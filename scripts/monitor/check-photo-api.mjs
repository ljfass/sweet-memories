import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const MONITOR_DEFAULTS = Object.freeze({
  maxAttempts: 3,
  requestTimeoutMs: 15_000,
  totalTimeoutMs: 90_000,
})

const MAX_HEALTH_BYTES = 8 * 1024
const MAX_PHOTOS_BYTES = 16 * 1024 * 1024
const MAX_PHOTOS = 1_000
const PHOTO_KEYS = ['alt', 'capturedDate', 'id', 'sources', 'title', 'transform']
const SOURCE_KEYS = ['avif', 'fallback', 'jpeg', 'webp']
const RESPONSIVE_KEYS = ['url', 'width']
const FALLBACK_KEYS = ['height', 'url', 'width']
const TRANSFORM_KEYS = ['rotation', 'x', 'y']
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

class RequestFailure extends Error {
  constructor(retryable = false) {
    super('monitor request failed')
    this.retryable = retryable
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function productionOrigin(input) {
  if (
    typeof input !== 'string'
    || input !== input.trim()
    || Array.from(input).some((character) => (
      character === '\\' || (character.codePointAt(0) ?? 0) <= 0x20
    ))
  ) {
    throw new Error('生产地址无效')
  }
  let parsed
  try {
    parsed = new URL(input)
  } catch {
    throw new Error('生产地址无效')
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    throw new Error('生产地址无效')
  }
  return parsed.origin
}

function monitorMode(value) {
  if (value !== 'static' && value !== 'api') throw new Error('相册模式无效')
  return value
}

async function cancelBody(response) {
  try {
    await response.body?.cancel()
  } catch {
    // Cancellation is best-effort and must not replace the stable monitor error.
  }
}

function contentLengthExceeds(response, maximum) {
  const header = response.headers.get('content-length')
  if (header === null) return false
  return !/^\d+$/.test(header) || Number(header) > maximum
}

function mediaType(response) {
  return response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

async function withAbort(operation, signal) {
  if (signal.aborted) throw new RequestFailure(true)
  let abort
  const aborted = new Promise((_, reject) => {
    abort = () => reject(new RequestFailure(true))
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

async function readBoundedText(response, maximum, signal) {
  if (response.body === null || contentLengthExceeds(response, maximum)) {
    await cancelBody(response)
    throw new RequestFailure()
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const parts = []
  let total = 0
  const abort = () => void reader.cancel().catch(() => undefined)
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      let chunk
      try {
        chunk = await withAbort(reader.read(), signal)
      } catch (error) {
        if (error instanceof RequestFailure) throw error
        throw new RequestFailure(true)
      }
      if (chunk.done) {
        if (signal.aborted) throw new RequestFailure(true)
        parts.push(decoder.decode())
        return parts.join('')
      }
      total += chunk.value.byteLength
      if (total > maximum) {
        await reader.cancel().catch(() => undefined)
        throw new RequestFailure()
      }
      parts.push(decoder.decode(chunk.value, { stream: true }))
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    if (error instanceof RequestFailure) throw error
    throw new RequestFailure()
  } finally {
    signal.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

async function readJson(response, maximum, signal) {
  if (mediaType(response) !== 'application/json') {
    await cancelBody(response)
    throw new RequestFailure()
  }
  const text = await readBoundedText(response, maximum, signal)
  try {
    return JSON.parse(text)
  } catch {
    throw new RequestFailure()
  }
}

function failureForStatus(response) {
  if (response.status >= 200 && response.status < 300) return null
  return new RequestFailure(response.status === 429 || response.status >= 500)
}

async function request(context, pathname, failureMessage, validate) {
  const url = new URL(pathname, context.origin).href
  for (let attempt = 1; attempt <= context.maxAttempts; attempt += 1) {
    const remaining = context.deadline - Date.now()
    if (remaining <= 0) break
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(context.requestTimeoutMs, remaining),
    )
    try {
      const response = await withAbort(context.fetch(url, {
        credentials: 'omit',
        redirect: 'manual',
        signal: controller.signal,
      }), controller.signal)
      const statusFailure = failureForStatus(response)
      if (statusFailure !== null) {
        await cancelBody(response)
        throw statusFailure
      }
      return await validate(response, controller.signal)
    } catch (error) {
      const retryable = error instanceof RequestFailure
        ? error.retryable
        : controller.signal.aborted || error instanceof TypeError
      if (!retryable || attempt === context.maxAttempts || Date.now() >= context.deadline) {
        throw new Error(failureMessage, { cause: error })
      }
    } finally {
      clearTimeout(timeout)
    }
  }
  throw new Error(failureMessage)
}

function boundedText(record, key, maximum) {
  const value = Reflect.get(record, key)
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value.length === 0
    || value.includes('\u0000')
    || Array.from(value).length > maximum
  ) {
    throw new RequestFailure()
  }
  return value
}

function dimension(record, key) {
  const value = Reflect.get(record, key)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 60_000) {
    throw new RequestFailure()
  }
  return value
}

function canonicalDate(value) {
  const match = DATE_PATTERN.exec(value)
  if (match === null || match[1] === '0000') return false
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
}

function mediaUrl(raw, origin, id, format, width) {
  if (
    typeof raw !== 'string'
    || !raw.startsWith('/media/')
    || raw.includes('%')
    || raw.includes('\\')
    || raw.includes('?')
    || raw.includes('#')
    || raw.includes('//')
  ) {
    throw new RequestFailure()
  }
  let parsed
  try {
    parsed = new URL(raw, origin)
  } catch {
    throw new RequestFailure()
  }
  const parts = raw.split('/')
  const extensions = format === 'jpeg' ? ['jpg', 'jpeg'] : [format]
  if (
    parsed.origin !== origin
    || parsed.pathname !== raw
    || parts.length !== 4
    || parts[0] !== ''
    || parts[1] !== 'media'
    || parts[2] !== id
    || !extensions.some((extension) => parts[3] === `${width}.${extension}`)
  ) {
    throw new RequestFailure()
  }
  return raw
}

function responsiveSources(value, origin, id, format) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new RequestFailure()
  }
  let previousWidth = 0
  return value.map((source) => {
    if (!isRecord(source) || !hasExactKeys(source, RESPONSIVE_KEYS)) throw new RequestFailure()
    const width = dimension(source, 'width')
    if (width <= previousWidth) throw new RequestFailure()
    previousWidth = width
    return { url: mediaUrl(Reflect.get(source, 'url'), origin, id, format, width), width }
  })
}

function publicPhoto(value, origin) {
  if (!isRecord(value) || !hasExactKeys(value, PHOTO_KEYS)) throw new RequestFailure()
  const id = boundedText(value, 'id', 128)
  if (!SAFE_ID.test(id) || id === '.' || id === '..') throw new RequestFailure()
  const capturedDate = boundedText(value, 'capturedDate', 10)
  if (!canonicalDate(capturedDate)) throw new RequestFailure()
  boundedText(value, 'title', 120)
  boundedText(value, 'alt', 500)

  const transform = Reflect.get(value, 'transform')
  if (!isRecord(transform) || !hasExactKeys(transform, TRANSFORM_KEYS)) throw new RequestFailure()
  const [rotation, x, y] = ['rotation', 'x', 'y'].map((key) => Reflect.get(transform, key))
  if (
    ![rotation, x, y].every(Number.isInteger)
    || rotation < -6 || rotation > 6
    || x < -16 || x > 16
    || y < -16 || y > 16
  ) {
    throw new RequestFailure()
  }

  const sources = Reflect.get(value, 'sources')
  if (!isRecord(sources) || !hasExactKeys(sources, SOURCE_KEYS)) throw new RequestFailure()
  responsiveSources(Reflect.get(sources, 'avif'), origin, id, 'avif')
  responsiveSources(Reflect.get(sources, 'webp'), origin, id, 'webp')
  const jpeg = responsiveSources(Reflect.get(sources, 'jpeg'), origin, id, 'jpeg')
  const fallback = Reflect.get(sources, 'fallback')
  if (!isRecord(fallback) || !hasExactKeys(fallback, FALLBACK_KEYS)) throw new RequestFailure()
  const width = dimension(fallback, 'width')
  const height = dimension(fallback, 'height')
  if (width * height > 60_000_000) throw new RequestFailure()
  const fallbackUrl = mediaUrl(Reflect.get(fallback, 'url'), origin, id, 'jpeg', width)
  if (!jpeg.some((source) => source.url === fallbackUrl && source.width === width)) {
    throw new RequestFailure()
  }
  return { capturedDate, fallbackUrl, id }
}

function publicPhotos(value, origin) {
  if (!Array.isArray(value) || value.length > MAX_PHOTOS) throw new RequestFailure()
  const ids = new Set()
  let previousDate = ''
  const photos = value.map((photo) => {
    const parsed = publicPhoto(photo, origin)
    if (ids.has(parsed.id) || (previousDate !== '' && parsed.capturedDate < previousDate)) {
      throw new RequestFailure()
    }
    ids.add(parsed.id)
    previousDate = parsed.capturedDate
    return parsed
  })
  return photos
}

async function probeImage(response, signal) {
  if (!mediaType(response).startsWith('image/') || response.body === null) {
    await cancelBody(response)
    throw new RequestFailure()
  }
  const reader = response.body.getReader()
  const abort = () => void reader.cancel().catch(() => undefined)
  signal.addEventListener('abort', abort, { once: true })
  try {
    const chunk = await withAbort(reader.read(), signal)
    if (signal.aborted) throw new RequestFailure(true)
    if (chunk.done || chunk.value.byteLength === 0) {
      throw new RequestFailure()
    }
    await reader.cancel().catch(() => undefined)
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    if (error instanceof RequestFailure) throw error
    throw new RequestFailure(true)
  } finally {
    signal.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

export async function checkPhotoApi(input, options = {}) {
  const origin = productionOrigin(input)
  const mode = monitorMode(options.mode)
  const context = {
    origin,
    fetch: options.fetch ?? globalThis.fetch,
    maxAttempts: options.maxAttempts ?? MONITOR_DEFAULTS.maxAttempts,
    requestTimeoutMs: options.requestTimeoutMs ?? MONITOR_DEFAULTS.requestTimeoutMs,
    deadline: Date.now() + (options.totalTimeoutMs ?? MONITOR_DEFAULTS.totalTimeoutMs),
  }

  const status = await request(context, '/api/health', '健康检查失败', async (response, signal) => {
    const health = await readJson(response, MAX_HEALTH_BYTES, signal)
    if (!isRecord(health) || !hasExactKeys(health, ['status']) || health.status !== 'ok') {
      throw new RequestFailure()
    }
    return response.status
  })
  const photos = await request(context, '/api/photos', '公开照片数据无效', async (response, signal) => (
    publicPhotos(await readJson(response, MAX_PHOTOS_BYTES, signal), origin)
  ))
  if (mode === 'api' && photos.length === 0) throw new Error('公开照片列表为空')
  if (photos.length > 0) {
    await request(context, photos[0].fallbackUrl, '公开照片媒体检查失败', probeImage)
  }
  return { origin, photoCount: photos.length, status }
}

async function runCli() {
  if (process.argv.length !== 4) throw new Error('用法：check-photo-api.mjs URL MODE')
  const result = await checkPhotoApi(process.argv[2], { mode: process.argv[3] })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

const isCli = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isCli) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : '巡检失败'
    process.stderr.write(`照片 API 巡检失败：${message}\n`)
    process.exitCode = 1
  })
}
