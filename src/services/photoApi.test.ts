import { describe, expect, it, vi } from 'vitest'
import { fetchPublicPhotos, mapPublicPhoto, parsePublicPhotos } from './photoApi'

function publicPhoto(overrides: Record<string, unknown> = {}) {
  return {
    id: 'photo-id',
    title: '满月啦',
    alt: '爸爸妈妈抱着宝宝庆祝满月',
    capturedDate: '2026-02-03',
    transform: { rotation: -2, x: 3, y: 4 },
    sources: {
      avif: [
        { url: '/media/photo-id/320.avif', width: 320 },
        { url: '/media/photo-id/640.avif', width: 640 },
      ],
      webp: [
        { url: '/media/photo-id/320.webp', width: 320 },
        { url: '/media/photo-id/640.webp', width: 640 },
      ],
      jpeg: [
        { url: '/media/photo-id/320.jpg', width: 320 },
        { url: '/media/photo-id/640.jpg', width: 640 },
      ],
      fallback: {
        url: '/media/photo-id/640.jpg',
        width: 640,
        height: 480,
      },
    },
    ...overrides,
  }
}

function chunkedJsonResponse(chunks: readonly Uint8Array[], options: {
  readonly cancel?: (reason?: unknown) => void | PromiseLike<void>
  readonly pullCount?: { value: number }
} = {}) {
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (options.pullCount) {
        options.pullCount.value += 1
      }
      const chunk = chunks[index++]
      if (chunk === undefined) {
        controller.close()
        return
      }
      controller.enqueue(chunk)
    },
    cancel(reason) {
      return options.cancel?.(reason)
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('public photo API', () => {
  it('maps a validated DTO to responsive album data and real fallback dimensions', () => {
    expect(mapPublicPhoto(publicPhoto())).toEqual({
      id: 'photo-id',
      caption: '满月啦',
      alt: '爸爸妈妈抱着宝宝庆祝满月',
      sources: {
        avif: '/media/photo-id/320.avif 320w, /media/photo-id/640.avif 640w',
        webp: '/media/photo-id/320.webp 320w, /media/photo-id/640.webp 640w',
        jpeg: '/media/photo-id/320.jpg 320w, /media/photo-id/640.jpg 640w',
        fallback: '/media/photo-id/640.jpg',
        width: 640,
        height: 480,
      },
      transform: { rotation: -2, x: 3, y: 4 },
    })
  })

  it('preserves a valid multiline description used as public alt text', () => {
    const memory = mapPublicPhoto(publicPhoto({ alt: '第一行描述\n第二行描述' }))

    expect(memory.alt).toBe('第一行描述\n第二行描述')
  })

  it('fetches only the same-origin public endpoint with browser-default credentials', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([publicPhoto()]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const signal = new AbortController().signal

    const result = await fetchPublicPhotos({ fetch: fetchMock, signal })

    expect(result).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/photos', { signal })
    const requestOptions = fetchMock.mock.calls[0]?.[1]
    expect(requestOptions).not.toHaveProperty('credentials')
    expect(requestOptions).not.toHaveProperty('headers')
  })

  it('rejects non-successful and non-JSON responses before mapping', async () => {
    const nonSuccess = vi.fn<typeof fetch>().mockResolvedValue(new Response('no', { status: 503 }))
    const nonJson = vi.fn<typeof fetch>().mockResolvedValue(new Response('no', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }))

    await expect(fetchPublicPhotos({ fetch: nonSuccess })).rejects.toThrow('照片暂时无法加载')
    await expect(fetchPublicPhotos({ fetch: nonJson })).rejects.toThrow('照片数据格式无效')
  })

  it('cancels the body before reading when Content-Length exceeds the byte limit', async () => {
    const cancel = vi.fn().mockRejectedValue(new Error('cancel failed'))
    const stream = new ReadableStream<Uint8Array>({ cancel })
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': String(16 * 1024 * 1024 + 1),
      },
    }))

    await expect(fetchPublicPhotos({ fetch: fetchMock })).rejects.toThrow('照片数据格式无效')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('accepts 750 maximum multilingual descriptions within the public photo count contract', async () => {
    const photos = Array.from({ length: 750 }, (_, index) => publicPhoto({
      id: `photo-${String(index).padStart(4, '0')}`,
      title: '👶'.repeat(120),
      alt: '👶'.repeat(500),
      capturedDate: '2026-02-03',
      sources: {
        avif: [{ url: `/media/photo-${String(index).padStart(4, '0')}/320.avif`, width: 320 }],
        webp: [{ url: `/media/photo-${String(index).padStart(4, '0')}/320.webp`, width: 320 }],
        jpeg: [{ url: `/media/photo-${String(index).padStart(4, '0')}/320.jpg`, width: 320 }],
        fallback: {
          url: `/media/photo-${String(index).padStart(4, '0')}/320.jpg`,
          width: 320,
          height: 240,
        },
      },
    }))
    const body = JSON.stringify(photos)
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(2 * 1024 * 1024)
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      chunkedJsonResponse([new TextEncoder().encode(body)]),
    )

    await expect(fetchPublicPhotos({ fetch: fetchMock })).resolves.toHaveLength(750)
  })

  it('cancels an unbounded stream as soon as it exceeds the 16 MiB limit', async () => {
    const cancel = vi.fn().mockRejectedValue(new Error('cancel failed'))
    const pullCount = { value: 0 }
    const chunks = Array.from(
      { length: 20 },
      () => new Uint8Array(1024 * 1024).fill(0x20),
    )
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      chunkedJsonResponse(chunks, { cancel, pullCount }),
    )

    await expect(fetchPublicPhotos({ fetch: fetchMock })).rejects.toThrow('照片数据格式无效')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(pullCount.value).toBeLessThan(chunks.length)
  })

  it('decodes valid JSON when one UTF-8 character spans stream chunks', async () => {
    const encoded = new TextEncoder().encode(JSON.stringify([publicPhoto()]))
    const multibyteStart = encoded.findIndex((byte) => byte > 0x7f)
    expect(multibyteStart).toBeGreaterThan(0)
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(chunkedJsonResponse([
      encoded.slice(0, multibyteStart + 1),
      encoded.slice(multibyteStart + 1),
    ]))

    await expect(fetchPublicPhotos({ fetch: fetchMock })).resolves.toMatchObject([
      { caption: '满月啦' },
    ])
  })

  it('cancels the stream when fatal UTF-8 decoding fails mid-response', async () => {
    const cancel = vi.fn()
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(chunkedJsonResponse([
      new Uint8Array([0xff]),
      new TextEncoder().encode('[]'),
    ], { cancel }))

    await expect(fetchPublicPhotos({ fetch: fetchMock })).rejects.toThrow('照片数据格式无效')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('rejects a missing or failed response body with the stable data error', async () => {
    const missingBody = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const failedBody = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error('reader failed'))
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))

    await expect(fetchPublicPhotos({ fetch: missingBody })).rejects.toThrow('照片数据格式无效')
    await expect(fetchPublicPhotos({ fetch: failedBody })).rejects.toThrow('照片数据格式无效')
  })

  it('preserves an abort that occurs while reading the response body', async () => {
    const abortError = new DOMException('request aborted', 'AbortError')
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(abortError)
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))

    await expect(fetchPublicPhotos({ fetch: fetchMock })).rejects.toBe(abortError)
  })

  it('accepts an empty public album as a valid response', () => {
    const photos = parsePublicPhotos([])

    expect(photos).toEqual([])
    expect(Object.isFrozen(photos)).toBe(true)
  })

  it.each([
    ['non-array response', { photos: [] }],
    ['extra DTO field', [publicPhoto({ privatePath: '/var/lib/private' })]],
    ['blank title', [publicPhoto({ title: '   ' })]],
    ['NUL character', [publicPhoto({ title: '满月\u0000快乐' })]],
    ['invalid date', [publicPhoto({ capturedDate: '2026-02-30' })]],
    ['fractional transform', [publicPhoto({ transform: { rotation: 1.5, x: 0, y: 0 } })]],
    ['out-of-range rotation', [publicPhoto({ transform: { rotation: 7, x: 0, y: 0 } })]],
    ['out-of-range offset', [publicPhoto({ transform: { rotation: 0, x: 17, y: 0 } })]],
    ['zero source width', [publicPhoto({
      sources: {
        ...publicPhoto().sources,
        avif: [{ url: '/media/photo-id/320.avif', width: 0 }],
      },
    })]],
    ['mismatched source width', [publicPhoto({
      sources: {
        ...publicPhoto().sources,
        avif: [{ url: '/media/photo-id/320.avif', width: 640 }],
      },
    })]],
    ['wrong source extension', [publicPhoto({
      sources: {
        ...publicPhoto().sources,
        avif: [{ url: '/media/photo-id/320.webp', width: 320 }],
      },
    })]],
    ['master exposure', [publicPhoto({
      sources: {
        ...publicPhoto().sources,
        jpeg: [{ url: '/media/photo-id/master.jpg', width: 640 }],
      },
    })]],
    ['invalid fallback dimensions', [publicPhoto({
      sources: {
        ...publicPhoto().sources,
        fallback: { url: '/media/photo-id/640.jpg', width: 640, height: -1 },
      },
    })]],
    ['fallback missing from JPEG sources', [publicPhoto({
      sources: {
        ...publicPhoto().sources,
        fallback: { url: '/media/photo-id/960.jpg', width: 960, height: 720 },
      },
    })]],
    ['duplicate responsive width', [publicPhoto({
      sources: {
        ...publicPhoto().sources,
        webp: [
          { url: '/media/photo-id/320.webp', width: 320 },
          { url: '/media/photo-id/320.webp', width: 320 },
        ],
      },
    })]],
  ])('rejects a malformed %s', (_label, value) => {
    expect(() => parsePublicPhotos(value)).toThrow('照片数据格式无效')
  })

  it.each([
    'https://evil.example/media/photo-id/320.avif',
    '//evil.example/media/photo-id/320.avif',
    '/other/photo-id/320.avif',
    '/media/other-id/320.avif',
    '/media/photo-id/%2e%2e%2fsecret.avif',
    '/media%2fphoto-id%2f320.avif',
    '/media/photo-id/320.avif?token=secret',
  ])('rejects an unsafe media URL: %s', (url) => {
    const value = publicPhoto({
      sources: {
        ...publicPhoto().sources,
        avif: [{ url, width: 320 }],
      },
    })

    expect(() => mapPublicPhoto(value)).toThrow('照片数据格式无效')
  })
})
