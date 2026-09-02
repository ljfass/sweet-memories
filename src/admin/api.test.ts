import { describe, expect, it, vi } from 'vitest'
import { AdminApi, AdminApiError } from './api'

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

describe('AdminApi', () => {
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
