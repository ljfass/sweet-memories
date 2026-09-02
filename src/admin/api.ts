import type {
  AdminApiClient,
  AdminPhoto,
  AdminPhotoApiClient,
  AdminPhotoSource,
  AdminSession,
  AdminUploadApiClient,
  PhotoUpdateInput,
} from './types'

const SESSION_ENDPOINT = '/api/admin/session'
const PHOTO_ENDPOINT = '/api/admin/photos'
const INVALID_RESPONSE_MESSAGE = '服务器返回了无效数据'
const PHOTO_KEYS = [
  'alt', 'capturedDate', 'description', 'id', 'sources', 'status', 'title', 'transform', 'version',
]
const SOURCE_KEYS = ['avif', 'fallback', 'jpeg', 'webp']
const RESPONSIVE_SOURCE_KEYS = ['url', 'width']
const FALLBACK_KEYS = ['height', 'url', 'width']
const TRANSFORM_KEYS = ['rotation', 'x', 'y']
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const MAX_ADMIN_PHOTOS = 1_000
const MAX_UPLOAD_RESPONSE_CHARACTERS = 1024 * 1024

export type AdminApiErrorKind =
  | 'credentials'
  | 'rate-limited'
  | 'unauthorized'
  | 'forbidden'
  | 'conflict'
  | 'not-found'
  | 'invalid-response'
  | 'unavailable'
  | 'upload-too-large'
  | 'upload-invalid'
  | 'uploads-disabled'
  | 'storage-full'
  | 'upload-busy'

export class AdminApiError extends Error {
  constructor(
    readonly kind: AdminApiErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'AdminApiError'
  }
}

export interface AdminApiOptions {
  readonly fetch?: typeof globalThis.fetch
  readonly xhr?: () => XMLHttpRequest
}

type SessionResponse = AdminSession & { readonly authenticated: true }
type LoginResponse = Omit<SessionResponse, 'username'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximumLength
    && !value.includes('\u0000')
}

function isIsoTimestamp(value: unknown): value is string {
  if (
    !isBoundedString(value, 64)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    return false
  }
  const parsed = new Date(value)
  const canonical = value.length === 20 ? value.replace('Z', '.000Z') : value
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === canonical
}

function invalidResponse(): AdminApiError {
  return new AdminApiError('invalid-response', INVALID_RESPONSE_MESSAGE)
}

function readText(value: unknown, maximumLength: number, allowEmpty = false): string {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || (!allowEmpty && value.length === 0)
    || value.includes('\u0000')
    || Array.from(value).length > maximumLength
  ) {
    throw invalidResponse()
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

function readDimension(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 60_000) {
    throw invalidResponse()
  }
  return value
}

function mediaUrl(value: unknown, id: string, format: 'avif' | 'webp' | 'jpeg', width: number): string {
  if (
    typeof value !== 'string'
    || !value.startsWith(`/media/${id}/`)
    || value.includes('%')
    || value.includes('\\')
    || value.includes('?')
    || value.includes('#')
    || value.includes('//')
  ) {
    throw invalidResponse()
  }
  const filename = value.split('/')[3]
  const extensions = format === 'jpeg' ? ['jpg', 'jpeg'] : [format]
  if (value.split('/').length !== 4 || !extensions.some((extension) => filename === `${width}.${extension}`)) {
    throw invalidResponse()
  }
  let parsed: URL
  try {
    parsed = new URL(value, window.location.origin)
  } catch {
    throw invalidResponse()
  }
  if (parsed.origin !== window.location.origin || parsed.pathname !== value) {
    throw invalidResponse()
  }
  return value
}

function parseSourceList(
  value: unknown,
  id: string,
  format: 'avif' | 'webp' | 'jpeg',
): readonly AdminPhotoSource[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw invalidResponse()
  }
  let previousWidth = 0
  return value.map((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, RESPONSIVE_SOURCE_KEYS)) {
      throw invalidResponse()
    }
    const width = readDimension(Reflect.get(entry, 'width'))
    if (width <= previousWidth) {
      throw invalidResponse()
    }
    previousWidth = width
    return { url: mediaUrl(Reflect.get(entry, 'url'), id, format, width), width }
  })
}

function parseAdminPhoto(value: unknown): AdminPhoto {
  if (!isRecord(value) || !hasExactKeys(value, PHOTO_KEYS)) {
    throw invalidResponse()
  }
  const id = readText(Reflect.get(value, 'id'), 128)
  if (!SAFE_ID_PATTERN.test(id) || id === '.' || id === '..') {
    throw invalidResponse()
  }
  const title = readText(Reflect.get(value, 'title'), 120)
  const alt = readText(Reflect.get(value, 'alt'), 500)
  const rawDescription = Reflect.get(value, 'description')
  const description = rawDescription === null ? null : readText(rawDescription, 500)
  const rawDate = Reflect.get(value, 'capturedDate')
  const capturedDate = rawDate === null ? null : readText(rawDate, 10)
  if (capturedDate !== null && !isCanonicalDate(capturedDate)) {
    throw invalidResponse()
  }
  const status = Reflect.get(value, 'status')
  const version = Reflect.get(value, 'version')
  if (
    (status !== 'migration_pending' && status !== 'published')
    || typeof version !== 'number'
    || !Number.isSafeInteger(version)
    || version < 1
  ) {
    throw invalidResponse()
  }
  const transform = Reflect.get(value, 'transform')
  if (!isRecord(transform) || !hasExactKeys(transform, TRANSFORM_KEYS)) {
    throw invalidResponse()
  }
  const rotation = Reflect.get(transform, 'rotation')
  const x = Reflect.get(transform, 'x')
  const y = Reflect.get(transform, 'y')
  if (
    typeof rotation !== 'number' || typeof x !== 'number' || typeof y !== 'number'
    || !Number.isInteger(rotation) || !Number.isInteger(x) || !Number.isInteger(y)
    || rotation < -6 || rotation > 6 || x < -16 || x > 16 || y < -16 || y > 16
  ) {
    throw invalidResponse()
  }
  const rawSources = Reflect.get(value, 'sources')
  if (!isRecord(rawSources) || !hasExactKeys(rawSources, SOURCE_KEYS)) {
    throw invalidResponse()
  }
  const avif = parseSourceList(Reflect.get(rawSources, 'avif'), id, 'avif')
  const webp = parseSourceList(Reflect.get(rawSources, 'webp'), id, 'webp')
  const jpeg = parseSourceList(Reflect.get(rawSources, 'jpeg'), id, 'jpeg')
  const rawFallback = Reflect.get(rawSources, 'fallback')
  if (!isRecord(rawFallback) || !hasExactKeys(rawFallback, FALLBACK_KEYS)) {
    throw invalidResponse()
  }
  const width = readDimension(Reflect.get(rawFallback, 'width'))
  const height = readDimension(Reflect.get(rawFallback, 'height'))
  if (width * height > 60_000_000) {
    throw invalidResponse()
  }
  const fallbackUrl = mediaUrl(Reflect.get(rawFallback, 'url'), id, 'jpeg', width)
  if (!jpeg.some((source) => source.url === fallbackUrl && source.width === width)) {
    throw invalidResponse()
  }
  return {
    id, title, alt, description, capturedDate, status, version,
    transform: { rotation, x, y },
    sources: { avif, webp, jpeg, fallback: { url: fallbackUrl, width, height } },
  }
}

function parseAdminPhotos(value: unknown): readonly AdminPhoto[] {
  if (!Array.isArray(value) || value.length > MAX_ADMIN_PHOTOS) {
    throw invalidResponse()
  }
  const photos = value.map(parseAdminPhoto)
  if (new Set(photos.map((photo) => photo.id)).size !== photos.length) {
    throw invalidResponse()
  }
  return photos
}

function parseUploadResponse(value: unknown): AdminPhoto {
  if (!isRecord(value) || !hasExactKeys(value, ['photo'])) {
    throw invalidResponse()
  }
  return parseAdminPhoto(value.photo)
}

function parseSessionResponse(value: unknown): SessionResponse {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'absoluteExpiresAt',
      'authenticated',
      'csrfToken',
      'idleExpiresAt',
      'username',
    ])
    || value.authenticated !== true
    || !isBoundedString(value.username, 32)
    || !isBoundedString(value.csrfToken, 512)
    || !isIsoTimestamp(value.idleExpiresAt)
    || !isIsoTimestamp(value.absoluteExpiresAt)
  ) {
    throw new AdminApiError('invalid-response', INVALID_RESPONSE_MESSAGE)
  }
  return value as unknown as SessionResponse
}

function parseLoginResponse(value: unknown, username: string): AdminSession {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'absoluteExpiresAt',
      'authenticated',
      'csrfToken',
      'idleExpiresAt',
    ])
    || value.authenticated !== true
    || !isBoundedString(value.csrfToken, 512)
    || !isIsoTimestamp(value.idleExpiresAt)
    || !isIsoTimestamp(value.absoluteExpiresAt)
  ) {
    throw new AdminApiError('invalid-response', INVALID_RESPONSE_MESSAGE)
  }
  const response = value as unknown as LoginResponse
  return {
    username,
    csrfToken: response.csrfToken,
    idleExpiresAt: response.idleExpiresAt,
    absoluteExpiresAt: response.absoluteExpiresAt,
  }
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new AdminApiError('invalid-response', INVALID_RESPONSE_MESSAGE)
  }
  try {
    return await response.json()
  } catch {
    throw new AdminApiError('invalid-response', INVALID_RESPONSE_MESSAGE)
  }
}

function responseError(
  status: number,
  operation: 'login' | 'session' | 'photo' | 'upload',
): AdminApiError {
  if (status === 401) {
    return operation === 'login'
      ? new AdminApiError('credentials', '用户名或密码错误')
      : new AdminApiError('unauthorized', '登录已过期')
  }
  if (status === 413 && operation === 'upload') {
    return new AdminApiError('upload-too-large', '单张图片不能超过 10MB')
  }
  if (status === 415 && operation === 'upload') {
    return new AdminApiError('upload-invalid', '图片格式或内容无效')
  }
  if (status === 423 && operation === 'upload') {
    return new AdminApiError('uploads-disabled', '图片上传暂未开放')
  }
  if (status === 429 && operation === 'upload') {
    return new AdminApiError('upload-busy', '图片处理队列繁忙，请稍后重试')
  }
  if (status === 507 && operation === 'upload') {
    return new AdminApiError('storage-full', '服务器存储空间不足')
  }
  if (status === 429) {
    return new AdminApiError('rate-limited', '登录尝试过于频繁，请稍后再试')
  }
  if (status === 400) {
    return new AdminApiError('forbidden', '请求内容无效')
  }
  if (status === 403) {
    return new AdminApiError('forbidden', '请求被拒绝，请刷新页面后重试')
  }
  if (status === 409 && operation === 'photo') {
    return new AdminApiError('conflict', '照片已在其他页面修改')
  }
  if (status === 404 && operation === 'photo') {
    return new AdminApiError('not-found', '照片不存在或已被删除')
  }
  return new AdminApiError('unavailable', '服务暂时不可用，请稍后重试')
}

export function safeLoginErrorMessage(error: unknown): string {
  if (error instanceof AdminApiError) {
    switch (error.kind) {
      case 'credentials':
        return '用户名或密码错误'
      case 'rate-limited':
        return '登录尝试过于频繁，请稍后再试'
      case 'forbidden':
        return '登录请求无效，请刷新页面后重试'
      case 'unavailable':
      case 'invalid-response':
      case 'unauthorized':
      case 'upload-too-large':
      case 'upload-invalid':
      case 'uploads-disabled':
      case 'storage-full':
      case 'upload-busy':
        return '登录暂时失败，请稍后重试'
    }
  }
  return '登录暂时失败，请稍后重试'
}

export function safeLogoutErrorMessage(): string {
  return '暂时无法退出登录，请稍后重试'
}

export class AdminApi implements AdminApiClient, AdminPhotoApiClient, AdminUploadApiClient {
  readonly #fetch: typeof globalThis.fetch
  readonly #xhr: () => XMLHttpRequest
  readonly #unauthorizedListeners = new Set<() => void>()
  #unauthorizedPublished = false

  constructor(options: AdminApiOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#xhr = options.xhr ?? (() => new XMLHttpRequest())
  }

  onUnauthorized(listener: () => void): () => void {
    this.#unauthorizedListeners.add(listener)
    return () => this.#unauthorizedListeners.delete(listener)
  }

  async checkSession(): Promise<AdminSession> {
    const response = await this.#request({ method: 'GET' })
    const body = await readJson(response)
    const session = parseSessionResponse(body)
    this.#unauthorizedPublished = false
    return {
      username: session.username,
      csrfToken: session.csrfToken,
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
    }
  }

  async login(username: string, password: string): Promise<AdminSession> {
    const response = await this.#request({
      method: 'POST',
      operation: 'login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const session = parseLoginResponse(await readJson(response), username)
    this.#unauthorizedPublished = false
    return session
  }

  async logout(csrfToken: string): Promise<void> {
    await this.#request({
      method: 'DELETE',
      headers: { 'x-csrf-token': csrfToken },
    })
    this.#unauthorizedPublished = false
  }

  async listPhotos(): Promise<readonly AdminPhoto[]> {
    const response = await this.#requestEndpoint(PHOTO_ENDPOINT, {
      method: 'GET',
      operation: 'photo',
    })
    return parseAdminPhotos(await readJson(response))
  }

  async updatePhoto(
    id: string,
    input: PhotoUpdateInput,
    csrfToken: string,
  ): Promise<AdminPhoto> {
    const response = await this.#requestEndpoint(`${PHOTO_ENDPOINT}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      operation: 'photo',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify(input),
    })
    return parseAdminPhoto(await readJson(response))
  }

  async deletePhoto(id: string, version: number, csrfToken: string): Promise<void> {
    await this.#requestEndpoint(`${PHOTO_ENDPOINT}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      operation: 'photo',
      headers: { 'if-match': `"${version}"`, 'x-csrf-token': csrfToken },
    })
  }

  uploadPhoto(
    file: File,
    requestId: string,
    csrfToken: string,
    reportProgress: (progress: number) => void,
  ): Promise<AdminPhoto> {
    return new Promise((resolve, reject) => {
      let request: XMLHttpRequest
      try {
        request = this.#xhr()
        request.open('POST', PHOTO_ENDPOINT, true)
        request.withCredentials = true
        request.setRequestHeader('x-csrf-token', csrfToken)
        request.setRequestHeader('idempotency-key', requestId)
      } catch {
        reject(new AdminApiError('unavailable', '服务暂时不可用，请稍后重试'))
        return
      }

      request.upload.addEventListener('progress', (event) => {
        if (!event.lengthComputable || event.total <= 0) return
        reportProgress((event.loaded / event.total) * 100)
      })
      request.addEventListener('load', () => {
        if (request.status === 401) this.#publishUnauthorized()
        if (request.status !== 200 && request.status !== 201) {
          reject(responseError(request.status, 'upload'))
          return
        }
        const contentType = request.getResponseHeader('content-type')
          ?.split(';', 1)[0]?.trim().toLowerCase()
        if (
          contentType !== 'application/json'
          || request.responseText.length > MAX_UPLOAD_RESPONSE_CHARACTERS
        ) {
          reject(invalidResponse())
          return
        }
        try {
          resolve(parseUploadResponse(JSON.parse(request.responseText) as unknown))
        } catch (error) {
          reject(error instanceof AdminApiError ? error : invalidResponse())
        }
      })
      const rejectUnavailable = () => {
        reject(new AdminApiError('unavailable', '服务暂时不可用，请稍后重试'))
      }
      request.addEventListener('error', rejectUnavailable)
      request.addEventListener('abort', rejectUnavailable)
      request.addEventListener('timeout', rejectUnavailable)

      try {
        const body = new FormData()
        body.append('photo', file)
        request.send(body)
      } catch {
        rejectUnavailable()
      }
    })
  }

  async #request(options: {
    readonly method: 'GET' | 'POST' | 'DELETE'
    readonly operation?: 'login' | 'session'
    readonly headers?: HeadersInit
    readonly body?: BodyInit
  }): Promise<Response> {
    return this.#requestEndpoint(SESSION_ENDPOINT, options)
  }

  async #requestEndpoint(endpoint: string, options: {
    readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
    readonly operation?: 'login' | 'session' | 'photo'
    readonly headers?: HeadersInit
    readonly body?: BodyInit
  }): Promise<Response> {
    let response: Response
    try {
      response = await this.#fetch(endpoint, {
        method: options.method,
        credentials: 'same-origin',
        headers: options.headers,
        body: options.body,
      })
    } catch {
      throw new AdminApiError('unavailable', '服务暂时不可用，请稍后重试')
    }
    if (response.status === 401) {
      this.#publishUnauthorized()
    }
    if (!response.ok) {
      throw responseError(response.status, options.operation ?? 'session')
    }
    return response
  }

  #publishUnauthorized(): void {
    if (this.#unauthorizedPublished) {
      return
    }
    this.#unauthorizedPublished = true
    for (const listener of this.#unauthorizedListeners) {
      listener()
    }
  }
}
