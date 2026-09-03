// @vitest-environment node

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type RequestListener, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkPhotoApi,
  MONITOR_DEFAULTS,
} from './check-photo-api.mjs'

const siteOrigin = 'https://album.example'
const photoId = '550e8400-e29b-41d4-a716-446655440000'
const scriptPath = fileURLToPath(new URL('./check-photo-api.mjs', import.meta.url))
const integrationServers: Server[] = []
const integrationDirectories: string[] = []
const integrationChildren = new Set<ReturnType<typeof spawn>>()

interface RecordedRequest {
  readonly init: RequestInit | undefined
  readonly url: string
}

function publicPhoto(overrides: Record<string, unknown> = {}) {
  const id = typeof overrides.id === 'string' ? overrides.id : photoId
  return {
    id,
    title: '一岁生日',
    alt: '生日照片',
    capturedDate: '2026-08-21',
    transform: { rotation: -2, x: 3, y: 4 },
    sources: {
      avif: [{ url: `/media/${id}/320.avif`, width: 320 }],
      webp: [{ url: `/media/${id}/320.webp`, width: 320 }],
      jpeg: [{ url: `/media/${id}/320.jpg`, width: 320 }],
      fallback: {
        url: `/media/${id}/320.jpg`,
        width: 320,
        height: 240,
      },
    },
    ...overrides,
  }
}

function routeFetch(
  handler: (pathname: string) => Response,
  requests: RecordedRequest[],
): typeof fetch {
  return async (input, init) => {
    const requested = new URL(input instanceof Request ? input.url : String(input))
    requests.push({ url: requested.href, init })
    return handler(requested.pathname)
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function startIntegrationServer(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  integrationServers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('测试服务器地址无效')
  }
  return `http://127.0.0.1:${address.port}`
}

interface CliResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stderr: string
  readonly stdout: string
}

async function runCliAgainstServer(
  serverOrigin: string,
  mode: 'api' | 'static',
): Promise<CliResult> {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'sweet-memories-monitor-cli.'))
  integrationDirectories.push(fixtureDirectory)
  const bootstrapPath = join(fixtureDirectory, 'transport.mjs')
  writeFileSync(bootstrapPath, `
const productionOrigin = ${JSON.stringify(siteOrigin)}
const serverOrigin = process.env.SWEET_MEMORIES_MONITOR_TEST_ORIGIN
if (serverOrigin === undefined) throw new Error('missing test server origin')
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const requested = new URL(input instanceof Request ? input.url : String(input))
  if (requested.origin !== productionOrigin) throw new TypeError('unexpected origin')
  return realFetch(new URL(requested.pathname + requested.search, serverOrigin), init)
}
`, 'utf8')

  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, siteOrigin, mode], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${pathToFileURL(bootstrapPath).href}`,
        SWEET_MEMORIES_MONITOR_TEST_ORIGIN: serverOrigin,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    integrationChildren.add(child)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 4_000)
    child.once('error', (error) => {
      clearTimeout(watchdog)
      integrationChildren.delete(child)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(watchdog)
      integrationChildren.delete(child)
      resolve({ code, signal, stderr, stdout })
    })
  })
}

afterEach(async () => {
  for (const child of integrationChildren) child.kill('SIGKILL')
  integrationChildren.clear()
  for (const server of integrationServers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve()
        return
      }
      server.close((error) => error === undefined ? resolve() : reject(error))
    })
  }
  for (const directory of integrationDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('public photo API monitor', () => {
  it('checks strict health, photos, and one same-origin image without credentials', async () => {
    const requests: RecordedRequest[] = []
    const fetchImplementation = routeFetch((pathname) => {
      if (pathname === '/api/health') return jsonResponse({ status: 'ok' })
      if (pathname === '/api/photos') return jsonResponse([publicPhoto()])
      if (pathname === `/media/${photoId}/320.jpg`) {
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        })
      }
      return new Response(null, { status: 404 })
    }, requests)

    await expect(checkPhotoApi(siteOrigin, {
      mode: 'api',
      fetch: fetchImplementation,
    })).resolves.toEqual({ origin: siteOrigin, photoCount: 1, status: 200 })

    expect(requests.map(({ url }) => url)).toEqual([
      `${siteOrigin}/api/health`,
      `${siteOrigin}/api/photos`,
      `${siteOrigin}/media/${photoId}/320.jpg`,
    ])
    for (const { init } of requests) {
      expect(init).toMatchObject({ credentials: 'omit', redirect: 'manual' })
      expect(init?.headers).toBeUndefined()
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    }
  })

  it('allows an empty static catalog but rejects an empty API catalog', async () => {
    const fetchImplementation = routeFetch(
      (pathname) => jsonResponse(pathname === '/api/health' ? { status: 'ok' } : []),
      [],
    )

    await expect(checkPhotoApi(siteOrigin, {
      mode: 'static',
      fetch: fetchImplementation,
    })).resolves.toEqual({ origin: siteOrigin, photoCount: 0, status: 200 })
    await expect(checkPhotoApi(siteOrigin, {
      mode: 'api',
      fetch: fetchImplementation,
    })).rejects.toThrow('公开照片列表为空')
  })

  it.each([
    [{ status: 'ok', detail: 'private' }, 'health response with extra data'],
    [{ status: 'starting' }, 'non-ready health response'],
  ])('rejects a non-minimal health payload: %s (%s)', async (health) => {
    const fetchImplementation = routeFetch(() => jsonResponse(health), [])

    await expect(checkPhotoApi(siteOrigin, {
      mode: 'static',
      fetch: fetchImplementation,
    })).rejects.toThrow('健康检查失败')
  })

  it('requires the public photo response to be an array', async () => {
    const fetchImplementation = routeFetch(
      (pathname) => jsonResponse(pathname === '/api/health' ? { status: 'ok' } : { photos: [] }),
      [],
    )

    await expect(checkPhotoApi(siteOrigin, {
      mode: 'static',
      fetch: fetchImplementation,
    })).rejects.toThrow('公开照片数据无效')
  })

  it.each([
    [publicPhoto({ title: '' }), 'invalid field'],
    [publicPhoto({ extra: 'private' }), 'extra field'],
    [publicPhoto({
      sources: {
        ...publicPhoto().sources,
        fallback: { url: 'https://media.example/private.jpg', width: 320, height: 240 },
      },
    }), 'cross-origin media'],
    [publicPhoto({
      sources: {
        ...publicPhoto().sources,
        fallback: { url: `/media/${photoId}/%33%32%30.jpg`, width: 320, height: 240 },
      },
    }), 'encoded media path'],
  ])('rejects an unsafe public DTO: %s (%s)', async (photo) => {
    const fetchImplementation = routeFetch(
      (pathname) => jsonResponse(pathname === '/api/health' ? { status: 'ok' } : [photo]),
      [],
    )

    await expect(checkPhotoApi(siteOrigin, {
      mode: 'static',
      fetch: fetchImplementation,
    })).rejects.toThrow('公开照片数据无效')
  })

  it.each([
    [[publicPhoto(), publicPhoto()], 'duplicate ID'],
    [[
      publicPhoto({ capturedDate: '2026-08-22' }),
      publicPhoto({ id: '550e8400-e29b-41d4-a716-446655440001', capturedDate: '2026-08-21' }),
    ], 'date order'],
    [[publicPhoto({ transform: { rotation: 1.5, x: 0, y: 0 } })], 'non-integer transform'],
    [[publicPhoto({
      sources: {
        ...publicPhoto().sources,
        fallback: { url: `/media/${photoId}/640.jpg`, width: 640, height: 480 },
      },
    })], 'fallback outside JPEG source list'],
  ])('rejects catalog-wide DTO violations: %s (%s)', async (photos) => {
    const fetchImplementation = routeFetch(
      (pathname) => jsonResponse(pathname === '/api/health' ? { status: 'ok' } : photos),
      [],
    )

    await expect(checkPhotoApi(siteOrigin, {
      mode: 'api',
      fetch: fetchImplementation,
    })).rejects.toThrow('公开照片数据无效')
  })

  it('does not follow or retry a media redirect', async () => {
    let mediaRequests = 0
    const fetchImplementation = routeFetch((pathname) => {
      if (pathname === '/api/health') return jsonResponse({ status: 'ok' })
      if (pathname === '/api/photos') return jsonResponse([publicPhoto()])
      mediaRequests += 1
      return new Response(null, { status: 302, headers: { location: '/not-media' } })
    }, [])

    await expect(checkPhotoApi(siteOrigin, {
      mode: 'api',
      fetch: fetchImplementation,
    })).rejects.toThrow('公开照片媒体检查失败')
    expect(mediaRequests).toBe(1)
  })

  it('retries only retryable statuses and stops after the third attempt', async () => {
    let healthAttempts = 0
    const requests: RecordedRequest[] = []
    const fetchImplementation = routeFetch((pathname) => {
      if (pathname === '/api/health') {
        healthAttempts += 1
        if (healthAttempts === 1) return new Response(null, { status: 429 })
        if (healthAttempts === 2) return new Response(null, { status: 503 })
        return jsonResponse({ status: 'ok' })
      }
      return jsonResponse([])
    }, requests)

    await expect(checkPhotoApi(siteOrigin, {
      mode: 'static',
      fetch: fetchImplementation,
    })).resolves.toEqual({ origin: siteOrigin, photoCount: 0, status: 200 })
    expect(requests.map(({ url }) => url)).toEqual([
      `${siteOrigin}/api/health`,
      `${siteOrigin}/api/health`,
      `${siteOrigin}/api/health`,
      `${siteOrigin}/api/photos`,
    ])

    const notFound = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }))
    await expect(checkPhotoApi(siteOrigin, {
      mode: 'static',
      fetch: notFound,
    })).rejects.toThrow('健康检查失败')
    expect(notFound).toHaveBeenCalledTimes(1)
  })

  it('retries a network stream read failure but not invalid response bytes', async () => {
    let healthAttempts = 0
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const pathname = new URL(String(input)).pathname
      if (pathname === '/api/health') {
        healthAttempts += 1
        if (healthAttempts === 1) {
          return new Response(new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new TypeError('socket closed'))
            },
          }), { headers: { 'content-type': 'application/json' } })
        }
        return jsonResponse({ status: 'ok' })
      }
      return jsonResponse([])
    })

    await expect(checkPhotoApi(siteOrigin, {
      mode: 'static',
      fetch: fetchImplementation,
    })).resolves.toEqual({ origin: siteOrigin, photoCount: 0, status: 200 })
    expect(fetchImplementation).toHaveBeenCalledTimes(3)
  })

  it('enforces per-attempt and absolute deadlines when fetch ignores AbortSignal', async () => {
    vi.useFakeTimers()
    try {
      const signals: AbortSignal[] = []
      const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
        if (init?.signal !== undefined) signals.push(init.signal)
        return await new Promise<Response>(() => undefined)
      })
      const outcome = checkPhotoApi(siteOrigin, {
        mode: 'static',
        fetch: fetchImplementation,
        requestTimeoutMs: 100,
        totalTimeoutMs: 250,
      }).then(() => 'resolved', () => 'rejected')

      await vi.advanceTimersByTimeAsync(251)

      await expect(Promise.race([outcome, Promise.resolve('pending')])).resolves.toBe('rejected')
      expect(fetchImplementation).toHaveBeenCalledTimes(3)
      expect(signals).toHaveLength(3)
      expect(signals.every((signal) => signal.aborted)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels oversized streamed JSON even without Content-Length', async () => {
    let cancellations = 0
    const fetchImplementation = vi.fn<typeof fetch>(async () => new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(5_000))
        },
        cancel() {
          cancellations += 1
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))

    await expect(checkPhotoApi(siteOrigin, {
      mode: 'static',
      fetch: fetchImplementation,
    })).rejects.toThrow('健康检查失败')
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
    expect(cancellations).toBe(1)
  })

  it('cancels invalid UTF-8 and oversized declared JSON before parsing', async () => {
    let invalidUtf8Canceled = 0
    const invalidUtf8 = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([0xff]))
      },
      cancel() {
        invalidUtf8Canceled += 1
      },
    }), { headers: { 'content-type': 'application/json' } })
    const invalidUtf8Fetch = vi.fn<typeof fetch>(async () => invalidUtf8)
    await expect(checkPhotoApi(siteOrigin, {
      mode: 'static',
      fetch: invalidUtf8Fetch,
    })).rejects.toThrow('健康检查失败')
    expect(invalidUtf8Fetch).toHaveBeenCalledTimes(1)
    expect(invalidUtf8Canceled).toBe(1)

    let declaredOversizeCanceled = 0
    const declaredOversize = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]))
      },
      cancel() {
        declaredOversizeCanceled += 1
      },
    }), {
      headers: {
        'content-length': String(8 * 1024 + 1),
        'content-type': 'application/json',
      },
    })
    await expect(checkPhotoApi(siteOrigin, {
      mode: 'static',
      fetch: vi.fn<typeof fetch>(async () => declaredOversize),
    })).rejects.toThrow('健康检查失败')
    expect(declaredOversizeCanceled).toBe(1)
  })

  it('probes and cancels a valid image without rejecting its full Content-Length', async () => {
    let mediaCanceled = 0
    const fetchImplementation = routeFetch((pathname) => {
      if (pathname === '/api/health') return jsonResponse({ status: 'ok' })
      if (pathname === '/api/photos') return jsonResponse([publicPhoto()])
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([0xff, 0xd8, 0xff]))
        },
        cancel() {
          mediaCanceled += 1
        },
      }), {
        headers: {
          'content-length': String(10 * 1024 * 1024),
          'content-type': 'image/jpeg',
        },
      })
    }, [])

    await expect(checkPhotoApi(siteOrigin, {
      mode: 'api',
      fetch: fetchImplementation,
    })).resolves.toEqual({ origin: siteOrigin, photoCount: 1, status: 200 })
    expect(mediaCanceled).toBe(1)
  })

  it.each([
    'http://album.example',
    'https://user:password@album.example',
    'https://album.example/?query=private',
    'https://album.example/#fragment',
    ' https://album.example/',
    'https://album.example\\admin',
  ])('rejects unsafe production input before fetch: %s', async (url) => {
    const fetchImplementation = vi.fn<typeof fetch>()

    await expect(checkPhotoApi(url, {
      mode: 'static',
      fetch: fetchImplementation,
    })).rejects.toThrow('生产地址无效')
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it('uses the fixed request, retry, and absolute deadline defaults', () => {
    expect(MONITOR_DEFAULTS).toEqual({
      maxAttempts: 3,
      requestTimeoutMs: 15_000,
      totalTimeoutMs: 90_000,
    })
  })

  it('does not execute when imported and rejects invalid CLI arguments safely', () => {
    const imported = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `import(${JSON.stringify(new URL('./check-photo-api.mjs', import.meta.url).href)})`,
    ], { encoding: 'utf8' })
    expect(imported.status).toBe(0)
    expect(imported.stdout).toBe('')
    expect(imported.stderr).toBe('')

    const missingArguments = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' })
    expect(missingArguments.status).toBe(1)
    expect(missingArguments.stdout).toBe('')
    expect(missingArguments.stderr).toContain('用法：check-photo-api.mjs URL MODE')

    const invalidMode = spawnSync(
      process.execPath,
      [scriptPath, siteOrigin, 'private'],
      { encoding: 'utf8' },
    )
    expect(invalidMode.status).toBe(1)
    expect(invalidMode.stdout).toBe('')
    expect(invalidMode.stderr).toContain('相册模式无效')
    expect(invalidMode.stderr).not.toContain(siteOrigin)
  })
})

describe('public photo API monitor CLI integration', () => {
  it('uses real streamed responses and prints only the safe success summary', async () => {
    const requests: Array<{
      readonly authorization: string | undefined
      readonly cookie: string | undefined
      readonly url: string | undefined
    }> = []
    let mediaClosed = false
    const origin = await startIntegrationServer((request, response) => {
      requests.push({
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        url: request.url,
      })
      if (request.url === '/api/health') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.write('{"sta')
        response.end('tus":"ok"}')
        return
      }
      if (request.url === '/api/photos') {
        const bytes = Buffer.from(JSON.stringify([publicPhoto()]))
        const chineseCharacter = bytes.indexOf(Buffer.from('一'))
        response.writeHead(200, { 'content-type': 'application/json' })
        response.write(bytes.subarray(0, chineseCharacter + 1))
        response.end(bytes.subarray(chineseCharacter + 1))
        return
      }
      if (request.url === `/media/${photoId}/320.jpg`) {
        response.writeHead(200, { 'content-type': 'image/jpeg' })
        response.write(Uint8Array.from([0xff, 0xd8, 0xff]))
        const interval = setInterval(() => response.write(Buffer.alloc(4_096)), 5)
        response.once('close', () => {
          clearInterval(interval)
          mediaClosed = true
        })
        return
      }
      response.writeHead(404).end()
    })

    const result = await runCliAgainstServer(origin, 'api')

    expect(result).toEqual({
      code: 0,
      signal: null,
      stderr: '',
      stdout: `${JSON.stringify({ origin: siteOrigin, photoCount: 1, status: 200 })}\n`,
    })
    expect(requests).toEqual([
      { authorization: undefined, cookie: undefined, url: '/api/health' },
      { authorization: undefined, cookie: undefined, url: '/api/photos' },
      { authorization: undefined, cookie: undefined, url: `/media/${photoId}/320.jpg` },
    ])
    expect(mediaClosed).toBe(true)
  })

  it('does not follow redirects and does not expose the Location in stderr', async () => {
    const paths: Array<string | undefined> = []
    const origin = await startIntegrationServer((request, response) => {
      paths.push(request.url)
      if (request.url === '/api/health') {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}')
        return
      }
      if (request.url === '/api/photos') {
        response.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify([publicPhoto()]))
        return
      }
      if (request.url === `/media/${photoId}/320.jpg`) {
        response.writeHead(302, { location: '/admin/private-canary' }).end()
        return
      }
      response.writeHead(200).end('private-canary')
    })

    const result = await runCliAgainstServer(origin, 'api')

    expect(result.code).toBe(1)
    expect(result.signal).toBeNull()
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('照片 API 巡检失败：公开照片媒体检查失败\n')
    expect(result.stderr).not.toContain('private-canary')
    expect(paths).not.toContain('/admin/private-canary')
  })

  it('cancels an oversized chunked response without exposing its body', async () => {
    let responseClosed = false
    const origin = await startIntegrationServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      const interval = setInterval(() => response.write('private-canary'.repeat(400)), 2)
      response.once('close', () => {
        clearInterval(interval)
        responseClosed = true
      })
    })

    const result = await runCliAgainstServer(origin, 'static')

    expect(result.code).toBe(1)
    expect(result.signal).toBeNull()
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('照片 API 巡检失败：健康检查失败\n')
    expect(result.stderr).not.toContain('private-canary')
    expect(responseClosed).toBe(true)
  })
})
