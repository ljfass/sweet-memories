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

  it('rejects an oversized JSON body even when Content-Length is absent', async () => {
    const oversizedJson = `${' '.repeat(2 * 1024 * 1024 + 1)}[]`
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(oversizedJson, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(fetchPublicPhotos({ fetch: fetchMock })).rejects.toThrow('照片数据格式无效')
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
