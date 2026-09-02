import type { Memory, MemoryTransform, ResponsiveImageSources } from '../types/album'

const INVALID_DATA_MESSAGE = '照片数据格式无效'
const LOAD_ERROR_MESSAGE = '照片暂时无法加载'
const PHOTO_KEYS = ['alt', 'capturedDate', 'id', 'sources', 'title', 'transform']
const SOURCE_KEYS = ['avif', 'fallback', 'jpeg', 'webp']
const RESPONSIVE_SOURCE_KEYS = ['url', 'width']
const FALLBACK_KEYS = ['height', 'url', 'width']
const TRANSFORM_KEYS = ['rotation', 'x', 'y']
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_PUBLIC_PHOTOS = 1_000
const MAX_JSON_BYTES = 2 * 1024 * 1024

type PublicFormat = 'avif' | 'webp' | 'jpeg'

export interface FetchPublicPhotosOptions {
  readonly fetch?: typeof globalThis.fetch
  readonly signal?: AbortSignal
}

function invalidData(): Error {
  return new Error(INVALID_DATA_MESSAGE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function readBoundedText(
  record: Record<string, unknown>,
  key: string,
  maximumLength: number,
): string {
  const value = Reflect.get(record, key)
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value.length === 0
    || value.includes('\u0000')
    || Array.from(value).length > maximumLength
  ) {
    throw invalidData()
  }
  return value
}

function isCanonicalDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value)
  if (match === null || match[1] === '0000') {
    return false
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
}

function readDimension(record: Record<string, unknown>, key: string): number {
  const value = Reflect.get(record, key)
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value <= 0 || value > 60_000) {
    throw invalidData()
  }
  return value
}

function expectedExtension(format: PublicFormat): readonly string[] {
  return format === 'jpeg' ? ['jpg', 'jpeg'] : [format]
}

function validateMediaUrl(
  rawUrl: unknown,
  photoId: string,
  format: PublicFormat,
  width: number,
): string {
  if (
    typeof rawUrl !== 'string'
    || !rawUrl.startsWith('/media/')
    || rawUrl.includes('%')
    || rawUrl.includes('\\')
    || rawUrl.includes('?')
    || rawUrl.includes('#')
    || rawUrl.includes('//')
  ) {
    throw invalidData()
  }

  const baseOrigin = window.location.origin
  let parsed: URL
  try {
    parsed = new URL(rawUrl, baseOrigin)
  } catch {
    throw invalidData()
  }
  if (parsed.origin !== baseOrigin || parsed.pathname !== rawUrl) {
    throw invalidData()
  }

  const segments = rawUrl.split('/')
  if (segments.length !== 4 || segments[0] !== '' || segments[1] !== 'media' || segments[2] !== photoId) {
    throw invalidData()
  }
  const filename = segments[3]
  if (filename === undefined) {
    throw invalidData()
  }
  const extensions = expectedExtension(format)
  if (!extensions.some((extension) => filename === `${width}.${extension}`)) {
    throw invalidData()
  }
  return rawUrl
}

function parseResponsiveSources(
  value: unknown,
  photoId: string,
  format: PublicFormat,
): string {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw invalidData()
  }

  let previousWidth = 0
  const srcset: string[] = []
  for (const entry of value) {
    if (!isRecord(entry) || !hasExactKeys(entry, RESPONSIVE_SOURCE_KEYS)) {
      throw invalidData()
    }
    const width = readDimension(entry, 'width')
    if (width <= previousWidth) {
      throw invalidData()
    }
    const url = validateMediaUrl(Reflect.get(entry, 'url'), photoId, format, width)
    srcset.push(`${url} ${width}w`)
    previousWidth = width
  }
  return srcset.join(', ')
}

function parseTransform(value: unknown): MemoryTransform {
  if (!isRecord(value) || !hasExactKeys(value, TRANSFORM_KEYS)) {
    throw invalidData()
  }
  const rotation = Reflect.get(value, 'rotation')
  const x = Reflect.get(value, 'x')
  const y = Reflect.get(value, 'y')
  if (
    typeof rotation !== 'number'
    || typeof x !== 'number'
    || typeof y !== 'number'
    || !Number.isInteger(rotation)
    || !Number.isInteger(x)
    || !Number.isInteger(y)
    || rotation < -6
    || rotation > 6
    || x < -16
    || x > 16
    || y < -16
    || y > 16
  ) {
    throw invalidData()
  }
  return { rotation, x, y }
}

function parseSources(value: unknown, photoId: string): ResponsiveImageSources {
  if (!isRecord(value) || !hasExactKeys(value, SOURCE_KEYS)) {
    throw invalidData()
  }

  const fallback = Reflect.get(value, 'fallback')
  if (!isRecord(fallback) || !hasExactKeys(fallback, FALLBACK_KEYS)) {
    throw invalidData()
  }
  const width = readDimension(fallback, 'width')
  const height = readDimension(fallback, 'height')
  if (width * height > 60_000_000) {
    throw invalidData()
  }
  const avif = parseResponsiveSources(Reflect.get(value, 'avif'), photoId, 'avif')
  const webp = parseResponsiveSources(Reflect.get(value, 'webp'), photoId, 'webp')
  const jpeg = parseResponsiveSources(Reflect.get(value, 'jpeg'), photoId, 'jpeg')
  const fallbackUrl = validateMediaUrl(Reflect.get(fallback, 'url'), photoId, 'jpeg', width)
  if (!jpeg.split(', ').includes(`${fallbackUrl} ${width}w`)) {
    throw invalidData()
  }

  return {
    avif,
    webp,
    jpeg,
    fallback: fallbackUrl,
    width,
    height,
  }
}

export function mapPublicPhoto(value: unknown): Memory {
  if (!isRecord(value) || !hasExactKeys(value, PHOTO_KEYS)) {
    throw invalidData()
  }
  const id = readBoundedText(value, 'id', 128)
  if (!SAFE_ID_PATTERN.test(id) || id === '.' || id === '..') {
    throw invalidData()
  }
  const capturedDate = readBoundedText(value, 'capturedDate', 10)
  if (!isCanonicalDate(capturedDate)) {
    throw invalidData()
  }

  return {
    id,
    caption: readBoundedText(value, 'title', 120),
    alt: readBoundedText(value, 'alt', 500),
    transform: parseTransform(Reflect.get(value, 'transform')),
    sources: parseSources(Reflect.get(value, 'sources'), id),
  }
}

export function parsePublicPhotos(value: unknown): readonly Memory[] {
  if (!Array.isArray(value) || value.length > MAX_PUBLIC_PHOTOS) {
    throw invalidData()
  }
  const photos = value.map(mapPublicPhoto)
  const ids = new Set<string>()
  let previousDate = ''
  for (const [index, photo] of photos.entries()) {
    const source = value[index]
    if (!isRecord(source)) {
      throw invalidData()
    }
    const capturedDate = readBoundedText(source, 'capturedDate', 10)
    if (ids.has(photo.id) || (previousDate !== '' && capturedDate < previousDate)) {
      throw invalidData()
    }
    ids.add(photo.id)
    previousDate = capturedDate
  }
  return Object.freeze(photos)
}

export async function fetchPublicPhotos(
  options: FetchPublicPhotosOptions = {},
): Promise<readonly Memory[]> {
  const fetchImplementation = options.fetch ?? globalThis.fetch
  let response: Response
  try {
    response = await fetchImplementation('/api/photos', { signal: options.signal })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error
    }
    throw new Error(LOAD_ERROR_MESSAGE, { cause: error })
  }

  if (!response.ok) {
    throw new Error(LOAD_ERROR_MESSAGE)
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  const contentLength = Number(response.headers.get('content-length'))
  if (
    contentType !== 'application/json'
    || (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES)
  ) {
    throw invalidData()
  }

  let responseText: string
  try {
    responseText = await response.text()
  } catch {
    throw invalidData()
  }
  if (new TextEncoder().encode(responseText).byteLength > MAX_JSON_BYTES) {
    throw invalidData()
  }

  let body: unknown
  try {
    body = JSON.parse(responseText)
  } catch {
    throw invalidData()
  }
  return parsePublicPhotos(body)
}
