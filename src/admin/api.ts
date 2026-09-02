import type { AdminApiClient, AdminSession } from './types'

const SESSION_ENDPOINT = '/api/admin/session'
const INVALID_RESPONSE_MESSAGE = '服务器返回了无效数据'

export type AdminApiErrorKind =
  | 'credentials'
  | 'rate-limited'
  | 'unauthorized'
  | 'forbidden'
  | 'invalid-response'
  | 'unavailable'

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

function responseError(status: number, operation: 'login' | 'session'): AdminApiError {
  if (status === 401) {
    return operation === 'login'
      ? new AdminApiError('credentials', '用户名或密码错误')
      : new AdminApiError('unauthorized', '登录已过期')
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
        return '登录暂时失败，请稍后重试'
    }
  }
  return '登录暂时失败，请稍后重试'
}

export function safeLogoutErrorMessage(): string {
  return '暂时无法退出登录，请稍后重试'
}

export class AdminApi implements AdminApiClient {
  readonly #fetch: typeof globalThis.fetch
  readonly #unauthorizedListeners = new Set<() => void>()
  #unauthorizedPublished = false

  constructor(options: AdminApiOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch
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

  async #request(options: {
    readonly method: 'GET' | 'POST' | 'DELETE'
    readonly operation?: 'login' | 'session'
    readonly headers?: HeadersInit
    readonly body?: BodyInit
  }): Promise<Response> {
    let response: Response
    try {
      response = await this.#fetch(SESSION_ENDPOINT, {
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
