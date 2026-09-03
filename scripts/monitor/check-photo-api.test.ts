// @vitest-environment node

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  checkPhotoApi,
  MONITOR_DEFAULTS,
} from './check-photo-api.mjs'

const siteOrigin = 'https://album.example'
const photoId = '550e8400-e29b-41d4-a716-446655440000'
const scriptPath = fileURLToPath(new URL('./check-photo-api.mjs', import.meta.url))
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
