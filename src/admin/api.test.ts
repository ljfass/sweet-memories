import { afterEach, describe, expect, it, vi } from 'vitest'
import { AdminApi, AdminApiError } from './api'
import type { AdminPhoto, PhotoUpdateInput } from './types'

const sessionResponse = {
  authenticated: true,
  username: 'alice',
  csrfToken: 'csrf-token',
  idleExpiresAt: '2026-09-02T12:00:00.000Z',
  absoluteExpiresAt: '2026-09-09T00:00:00.000Z',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const adminPhoto: AdminPhoto = {
  id: 'photo-1',
  title: '第一次散步',
  alt: '宝宝在公园散步',
  description: '宝宝在公园散步',
  capturedDate: '2026-05-01',
  status: 'published',
  version: 1,
  transform: { rotation: 0, x: 0, y: 0 },
  sources: {
    avif: [{ url: '/media/photo-1/320.avif', width: 320 }],
    webp: [{ url: '/media/photo-1/320.webp', width: 320 }],
    jpeg: [{ url: '/media/photo-1/320.jpg', width: 320 }],
    fallback: { url: '/media/photo-1/320.jpg', width: 320, height: 240 },
  },
}

interface TestInjectResponse {
  readonly body: string
  readonly statusCode: number
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>
}

interface TestApp {
  inject(input: {
    readonly method: string
    readonly url: string
    readonly headers?: Readonly<Record<string, string>>
    readonly payload?: string
  }): Promise<TestInjectResponse>
  close(): Promise<void>
}

interface BackendPhotoUpdate extends PhotoUpdateInput {
  readonly id: string
}

type BackendUpdatePhoto = (input: BackendPhotoUpdate) => AdminPhoto
type BackendDeletePhoto = (input: { readonly id: string; readonly version: number }) =>
  Promise<{ readonly deleted: boolean }>
type BuildApp = (dependencies: Record<string, unknown>) => TestApp
type ApiHttpErrorConstructor = new (statusCode: number, code: string, message: string) => Error

const backendModules = import.meta.glob('../../apps/api/src/{app,http/security}.ts', { eager: true })

function backendExport<T>(path: string, name: string): T {
  const module = backendModules[path]
  const value = typeof module === 'object' && module !== null ? Reflect.get(module, name) : undefined
  if (value === undefined) throw new Error(`Missing backend test export: ${name}`)
  return value as T
}

const buildApp = backendExport<BuildApp>('../../apps/api/src/app.ts', 'buildApp')
const ApiHttpError = backendExport<ApiHttpErrorConstructor>(
  '../../apps/api/src/http/security.ts',
  'ApiHttpError',
)

const applications: TestApp[] = []

function browserFetchFor(app: TestApp, calls: Array<[RequestInfo | URL, RequestInit | undefined]>) {
  return vi.fn<typeof fetch>(async (input, init) => {
    calls.push([input, init])
    const headers = new Headers(init?.headers)
    headers.set('cookie', '__Host-sweet_memories_session=browser-session')
    const method = init?.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      headers.set('origin', 'https://huangjianfen.cn')
    }
    const response = await app.inject({
      method,
      url: String(input),
      headers: Object.fromEntries(headers.entries()),
      payload: init?.body === undefined ? undefined : String(init.body),
    })
    const responseHeaders = new Headers()
    for (const [name, value] of Object.entries(response.headers)) {
      if (typeof value === 'string') responseHeaders.set(name, value)
      else if (Array.isArray(value)) responseHeaders.set(name, value.join(', '))
    }
    return new Response(response.body === '' ? null : response.body, {
      status: response.statusCode,
      headers: responseHeaders,
    })
  })
}

class FakeXhr extends EventTarget {
  readonly upload = new EventTarget()
  readonly requestHeaders = new Map<string, string>()
  method = ''
  url = ''
  async = false
  withCredentials = false
  responseText = ''
  status = 0
  timeout = 0
  aborted = false
  body: Document | XMLHttpRequestBodyInit | null = null
  contentType = 'application/json'

  open(method: string, url: string, async = true): void {
    this.method = method
    this.url = url
    this.async = async
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders.set(name.toLowerCase(), value)
  }

  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === 'content-type' ? this.contentType : null
  }

  send(body: Document | XMLHttpRequestBodyInit | null): void {
    this.body = body
  }

  abort(): void {
    this.aborted = true
    this.dispatchEvent(new Event('abort'))
  }

  report(loaded: number, total: number): void {
    const event = new Event('progress')
    Object.defineProperties(event, {
      lengthComputable: { value: true },
      loaded: { value: loaded },
      total: { value: total },
    })
    this.upload.dispatchEvent(event)
  }

  respond(status: number, body: unknown, contentType = 'application/json'): void {
    this.status = status
    this.responseText = JSON.stringify(body)
    this.contentType = contentType
    this.dispatchEvent(new Event('load'))
  }

  fail(): void {
    this.dispatchEvent(new Event('error'))
  }
}

function realPhotoApp(overrides: {
  readonly updatePhoto?: BackendUpdatePhoto
  readonly deletePhoto?: BackendDeletePhoto
} = {}) {
  const authenticated = {
    adminId: 'admin-1', username: 'alice', tokenHash: 'token-hash', csrfHash: 'csrf-hash',
    createdAt: '2026-09-01T00:00:00.000Z', lastActivityAt: '2026-09-01T00:00:00.000Z',
    idleExpiresAt: '2026-09-01T12:00:00.000Z', absoluteExpiresAt: '2026-09-08T00:00:00.000Z',
  }
  const sessionService = {
    login: vi.fn(), authenticate: vi.fn(() => authenticated), rotateCsrf: vi.fn(),
    verifyCsrf: vi.fn((_session: unknown, csrf: string) => csrf === 'csrf-token'), logout: vi.fn(),
    cleanupExpired: vi.fn(),
  }
  const updatePhoto = vi.fn<BackendUpdatePhoto>(overrides.updatePhoto ?? ((input) => ({
    ...adminPhoto,
    title: input.title,
    description: input.description,
    capturedDate: input.capturedDate,
    version: input.version + 1,
  })))
  const photoService = {
    listPublicPhotos: vi.fn(() => []), listAdminPhotos: vi.fn(() => [adminPhoto]), updatePhoto,
  }
  const deletePhoto = vi.fn<BackendDeletePhoto>(overrides.deletePhoto ?? (async () => ({ deleted: true })))
  const deletePhotoService = { delete: deletePhoto }
  const uploadPhotoService = { upload: vi.fn() }
  const app = buildApp({
    publicOrigin: 'https://huangjianfen.cn', sessionService, photoService,
    uploadPhotoService, deletePhotoService, logger: false,
  })
  applications.push(app)
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = []
  return { app, calls, fetch: browserFetchFor(app, calls), updatePhoto, deletePhoto }
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async (app) => app.close()))
})

describe('AdminApi', () => {
  it('uploads one photo through an exact same-origin XHR contract and strictly parses the response', async () => {
    const requests: FakeXhr[] = []
    const api = new AdminApi({
      fetch: vi.fn(),
      xhr: () => {
        const request = new FakeXhr()
        requests.push(request)
        return request as unknown as XMLHttpRequest
      },
    })
    const selectedFile = new File(['photo bytes'], 'private-family.jpg', { type: 'image/jpeg' })
    const progress = vi.fn()
    const requestId = '0195c681-9c63-7db0-8000-000000000101'

    const controller = new AbortController()
    const uploaded = api.uploadPhoto(
      selectedFile,
      requestId,
      'csrf-token',
      progress,
      controller.signal,
    )
    const request = requests[0]!
    expect(request).toMatchObject({
      method: 'POST',
      url: '/api/admin/photos',
      async: true,
      withCredentials: true,
    })
    expect(request.timeout).toBeGreaterThan(0)
    expect(request.requestHeaders.get('x-csrf-token')).toBe('csrf-token')
    expect(request.requestHeaders.get('idempotency-key')).toBe(requestId)
    expect(request.requestHeaders.has('origin')).toBe(false)
    expect(request.requestHeaders.has('content-type')).toBe(false)
    expect(request.body).toBeInstanceOf(FormData)
    expect((request.body as FormData).get('photo')).toBe(selectedFile)

    request.report(5, 10)
    expect(progress).toHaveBeenCalledWith(50)
    request.respond(201, { photo: adminPhoto })
    await expect(uploaded).resolves.toEqual(adminPhoto)
  })

  it('aborts an active XHR through its signal and rejects with a stable cancellation error', async () => {
    let request!: FakeXhr
    const api = new AdminApi({
      fetch: vi.fn(),
      xhr: () => {
        request = new FakeXhr()
        return request as unknown as XMLHttpRequest
      },
    })
    const controller = new AbortController()
    const upload = api.uploadPhoto(
      new File(['photo'], 'family.jpg'),
      '0195c681-9c63-7db0-8000-000000000106',
      'csrf-token',
      vi.fn(),
      controller.signal,
    )

    controller.abort()

    expect(request.aborted).toBe(true)
    await expect(upload).rejects.toMatchObject({ kind: 'cancelled', message: '上传已取消' })
  })

  it('ignores an old upload 401 after a successful login but publishes a current-epoch 401', async () => {
    const loginResponse = {
      authenticated: true,
      csrfToken: sessionResponse.csrfToken,
      idleExpiresAt: sessionResponse.idleExpiresAt,
      absoluteExpiresAt: sessionResponse.absoluteExpiresAt,
    }
    const requests: FakeXhr[] = []
    const listener = vi.fn()
    const api = new AdminApi({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(loginResponse)),
      xhr: () => {
        const request = new FakeXhr()
        requests.push(request)
        return request as unknown as XMLHttpRequest
      },
    })
    api.onUnauthorized(listener)
    const oldUpload = api.uploadPhoto(
      new File(['old'], 'old-session.jpg'),
      '0195c681-9c63-7db0-8000-000000000107',
      'old-csrf',
      vi.fn(),
      new AbortController().signal,
    )

    await api.login('alice', 'correct-password')
    requests[0]?.respond(401, { error: {} })
    await expect(oldUpload).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(listener).not.toHaveBeenCalled()

    const currentUpload = api.uploadPhoto(
      new File(['current'], 'current-session.jpg'),
      '0195c681-9c63-7db0-8000-000000000108',
      'fresh-csrf',
      vi.fn(),
      new AbortController().signal,
    )
    requests[1]?.respond(401, { error: {} })
    await expect(currentUpload).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('fails closed on malformed upload envelopes and publishes unauthorized only once without retrying', async () => {
    const requests: FakeXhr[] = []
    const listener = vi.fn()
    const api = new AdminApi({
      fetch: vi.fn(),
      xhr: () => {
        const request = new FakeXhr()
        requests.push(request)
        return request as unknown as XMLHttpRequest
      },
    })
    api.onUnauthorized(listener)
    const selectedFile = new File(['photo'], 'family.jpg', { type: 'image/jpeg' })

    const invalid = api.uploadPhoto(
      selectedFile,
      '0195c681-9c63-7db0-8000-000000000102',
      'csrf-token',
      vi.fn(),
      new AbortController().signal,
    )
    requests[0]?.respond(201, { photo: { ...adminPhoto, originalFilename: 'private.jpg' } })
    await expect(invalid).rejects.toMatchObject({ kind: 'invalid-response' })

    const firstUnauthorized = api.uploadPhoto(
      selectedFile,
      '0195c681-9c63-7db0-8000-000000000103',
      'csrf-token',
      vi.fn(),
      new AbortController().signal,
    )
    requests[1]?.respond(401, { error: { code: 'PRIVATE', stack: '/srv/private.ts' } })
    await expect(firstUnauthorized).rejects.toMatchObject({ kind: 'unauthorized' })
    const secondUnauthorized = api.uploadPhoto(
      selectedFile,
      '0195c681-9c63-7db0-8000-000000000104',
      'csrf-token',
      vi.fn(),
      new AbortController().signal,
    )
    requests[2]?.respond(401, { error: {} })
    await expect(secondUnauthorized).rejects.toMatchObject({ kind: 'unauthorized' })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(requests).toHaveLength(3)
  })

  it.each([
    [413, 'upload-too-large'],
    [415, 'upload-invalid'],
    [423, 'uploads-disabled'],
    [429, 'upload-busy'],
    [507, 'storage-full'],
  ] as const)('maps upload status %i to stable kind %s', async (status, kind) => {
    let request!: FakeXhr
    const api = new AdminApi({
      fetch: vi.fn(),
      xhr: () => {
        request = new FakeXhr()
        return request as unknown as XMLHttpRequest
      },
    })
    const upload = api.uploadPhoto(
      new File(['photo'], 'family.jpg'),
      '0195c681-9c63-7db0-8000-000000000105',
      'csrf-token',
      vi.fn(),
      new AbortController().signal,
    )
    request.respond(status, { error: { code: 'PRIVATE', message: '/srv/private' } })
    const error = await upload.catch((reason: unknown) => reason)

    expect(error).toMatchObject({ kind })
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE|\/srv/i)
  })

  it('uses the real buildApp GET/PATCH/DELETE contracts without forging browser Origin', async () => {
    const context = realPhotoApp()
    const api = new AdminApi({ fetch: context.fetch })

    await expect(api.listPhotos()).resolves.toEqual([adminPhoto])
    await expect(api.updatePhoto('photo-1', {
      title: '新的标题', description: null, capturedDate: '2026-05-02', version: 1,
    }, 'csrf-token')).resolves.toMatchObject({ title: '新的标题', version: 2 })
    await expect(api.deletePhoto('photo-1', 2, 'csrf-token')).resolves.toBeUndefined()

    expect(context.updatePhoto).toHaveBeenCalledWith({
      id: 'photo-1', title: '新的标题', description: null, capturedDate: '2026-05-02', version: 1,
    })
    expect(context.deletePhoto).toHaveBeenCalledWith({ id: 'photo-1', version: 2 })
    expect(context.calls.map(([, init]) => init?.method)).toEqual(['GET', 'PATCH', 'DELETE'])
    for (const [, init] of context.calls) {
      expect(init?.credentials).toBe('same-origin')
      expect(new Headers(init?.headers).has('origin')).toBe(false)
    }
    expect(new Headers(context.calls[1]?.[1]?.headers).get('x-csrf-token')).toBe('csrf-token')
    expect(new Headers(context.calls[2]?.[1]?.headers).get('if-match')).toBe('"2"')
  })

  it('maps a real buildApp version conflict to one stable sanitized client error', async () => {
    const context = realPhotoApp({
      updatePhoto: () => {
        throw new ApiHttpError(409, 'PHOTO_VERSION_CONFLICT', '照片已被更新，请刷新后重试')
      },
    })
    const api = new AdminApi({ fetch: context.fetch })

    const error = await api.updatePhoto('photo-1', {
      title: '草稿', description: null, capturedDate: '2026-05-02', version: 1,
    }, 'csrf-token').catch((reason: unknown) => reason)

    expect(error).toMatchObject({ kind: 'conflict', message: '照片已在其他页面修改' })
    expect(JSON.stringify(error)).not.toMatch(/PHOTO_VERSION_CONFLICT|刷新后重试/i)
  })

  it('fails closed when an administrator photo response contains extra private fields', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([{
      ...adminPhoto,
      originalFilename: 'private-family-photo.jpg',
    }]))

    await expect(new AdminApi({ fetch: fetchMock }).listPhotos())
      .rejects.toMatchObject({ kind: 'invalid-response', message: '服务器返回了无效数据' })
  })

  it('publishes one unauthorized event for repeated photo failures and never retries writes', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: {} }, 401))
    const listener = vi.fn()
    const api = new AdminApi({ fetch: fetchMock })
    api.onUnauthorized(listener)

    await expect(api.listPhotos()).rejects.toMatchObject({ kind: 'unauthorized' })
    await expect(api.updatePhoto('photo-1', {
      title: '草稿', description: null, capturedDate: '2026-05-01', version: 1,
    }, 'csrf-token')).rejects.toMatchObject({ kind: 'unauthorized' })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('maps a real buildApp missing photo response without exposing its server code', async () => {
    const context = realPhotoApp({
      updatePhoto: () => {
        throw new ApiHttpError(404, 'PHOTO_NOT_FOUND', '照片不存在')
      },
    })
    const error = await new AdminApi({ fetch: context.fetch }).updatePhoto('photo-1', {
      title: '草稿', description: null, capturedDate: '2026-05-01', version: 1,
    }, 'csrf-token').catch((reason: unknown) => reason)

    expect(error).toMatchObject({ kind: 'not-found', message: '照片不存在或已被删除' })
    expect(JSON.stringify(error)).not.toMatch(/PHOTO_NOT_FOUND/i)
  })

  it('checks the real session endpoint with same-origin credentials and validates the DTO', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(sessionResponse))
    const api = new AdminApi({ fetch: fetchMock })

    await expect(api.checkSession()).resolves.toEqual({
      username: 'alice',
      csrfToken: 'csrf-token',
      idleExpiresAt: '2026-09-02T12:00:00.000Z',
      absoluteExpiresAt: '2026-09-09T00:00:00.000Z',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/session')
    const init = fetchMock.mock.calls[0]?.[1]
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin' })
    expect(new Headers(init?.headers).has('origin')).toBe(false)
  })

  it('logs in without manually forging Origin and maps the username absent from the POST DTO', async () => {
    const loginResponse = {
      authenticated: true,
      csrfToken: sessionResponse.csrfToken,
      idleExpiresAt: sessionResponse.idleExpiresAt,
      absoluteExpiresAt: sessionResponse.absoluteExpiresAt,
    }
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(loginResponse))
    const api = new AdminApi({ fetch: fetchMock })

    await expect(api.login('alice', 'correct-password')).resolves.toMatchObject({
      username: 'alice',
      csrfToken: 'csrf-token',
    })
    const init = fetchMock.mock.calls[0]?.[1]
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' })
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    expect(new Headers(init?.headers).has('origin')).toBe(false)
    expect(JSON.parse(String(init?.body))).toEqual({
      username: 'alice',
      password: 'correct-password',
    })
  })

  it('adds only the in-memory CSRF token to logout and never retries a rejected write', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      error: { code: 'AUTHENTICATION_REQUIRED', message: '请重新登录' },
    }, 401))
    const api = new AdminApi({ fetch: fetchMock })

    await expect(api.logout('csrf-token')).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0]?.[1]
    const headers = new Headers(init?.headers)
    expect(init).toMatchObject({ method: 'DELETE', credentials: 'same-origin' })
    expect(headers.get('x-csrf-token')).toBe('csrf-token')
    expect(headers.has('origin')).toBe(false)
  })

  it('publishes one unauthorized event until a successful authentication resets the gate', async () => {
    const unauthorized = jsonResponse({ error: { code: 'SECRET_INTERNAL_CODE', stack: '/srv/app.ts' } }, 401)
    const successfulLogin = jsonResponse({
      authenticated: true,
      csrfToken: 'new-csrf',
      idleExpiresAt: sessionResponse.idleExpiresAt,
      absoluteExpiresAt: sessionResponse.absoluteExpiresAt,
    })
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized)
      .mockResolvedValueOnce(jsonResponse({ error: {} }, 401))
      .mockResolvedValueOnce(successfulLogin)
      .mockResolvedValueOnce(jsonResponse({ error: {} }, 401))
    const listener = vi.fn()
    const api = new AdminApi({ fetch: fetchMock })
    api.onUnauthorized(listener)

    await expect(api.checkSession()).rejects.toBeInstanceOf(AdminApiError)
    await expect(api.checkSession()).rejects.toBeInstanceOf(AdminApiError)
    expect(listener).toHaveBeenCalledTimes(1)
    await api.login('alice', 'correct-password')
    await expect(api.checkSession()).rejects.toBeInstanceOf(AdminApiError)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('fails closed on malformed session data and never exposes internal response fields', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...sessionResponse, databasePath: '/srv/private.sqlite' }))
      .mockResolvedValueOnce(jsonResponse({
        error: {
          code: 'SQLITE_FAILURE',
          message: 'failed at /srv/private.sqlite',
          stack: 'password=secret',
        },
      }, 500))
    const api = new AdminApi({ fetch: fetchMock })

    await expect(api.checkSession()).rejects.toThrow('服务器返回了无效数据')
    const error = await api.checkSession().catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(AdminApiError)
    expect(String(error)).toBe('AdminApiError: 服务暂时不可用，请稍后重试')
    expect(JSON.stringify(error)).not.toMatch(/SQLITE|private|password|secret/i)
  })

  it('rejects a real NUL character in every server-provided session string', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      ...sessionResponse,
      username: 'ali\u0000ce',
    }))

    await expect(new AdminApi({ fetch: fetchMock }).checkSession())
      .rejects.toThrow('服务器返回了无效数据')
  })

  it('rejects a timestamp whose calendar date only becomes valid through rollover', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      ...sessionResponse,
      idleExpiresAt: '2026-02-30T12:00:00.000Z',
    }))

    await expect(new AdminApi({ fetch: fetchMock }).checkSession())
      .rejects.toThrow('服务器返回了无效数据')
  })
})
