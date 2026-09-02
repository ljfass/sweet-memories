import { nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { AdminApiError } from './api'
import type { AdminApiClient, AdminSession } from './types'
import { useAdminSession } from './useAdminSession'

const session: AdminSession = {
  username: 'alice',
  csrfToken: 'csrf-token',
  idleExpiresAt: '2026-09-02T12:00:00.000Z',
  absoluteExpiresAt: '2026-09-09T00:00:00.000Z',
}

function fakeApi() {
  let unauthorizedListener: (() => void) | undefined
  const api: AdminApiClient = {
    checkSession: vi.fn(async () => session),
    login: vi.fn(async () => session),
    logout: vi.fn(async () => undefined),
    onUnauthorized: vi.fn((listener) => {
      unauthorizedListener = listener
      return () => {
        unauthorizedListener = undefined
      }
    }),
  }
  return { api, emitUnauthorized: () => unauthorizedListener?.() }
}

describe('useAdminSession', () => {
  it('moves from checking to anonymous when no server session exists', async () => {
    const { api } = fakeApi()
    vi.mocked(api.checkSession).mockRejectedValue(new AdminApiError('unauthorized', '登录已过期'))
    const state = useAdminSession(api)

    expect(state.status.value).toBe('checking')
    await state.initialize()

    expect(state.status.value).toBe('anonymous')
    expect(state.username.value).toBeNull()
    expect(state.csrfToken.value).toBeNull()
  })

  it('keeps session and CSRF state only in Vue memory', async () => {
    const localWrite = vi.spyOn(Storage.prototype, 'setItem')
    const { api } = fakeApi()
    const state = useAdminSession(api)

    await state.initialize()

    expect(state.status.value).toBe('authenticated')
    expect(state.username.value).toBe('alice')
    expect(state.csrfToken.value).toBe('csrf-token')
    expect(localWrite).not.toHaveBeenCalled()
  })

  it('turns an authenticated session into reauth-required without clearing page-owned drafts', async () => {
    const { api, emitUnauthorized } = fakeApi()
    const state = useAdminSession(api)
    const pageDraft = { title: '尚未保存的标题' }
    await state.initialize()

    emitUnauthorized()
    await nextTick()

    expect(state.status.value).toBe('reauth-required')
    expect(state.csrfToken.value).toBeNull()
    expect(pageDraft.title).toBe('尚未保存的标题')
  })

  it('closes reauthentication with a fresh CSRF token and does not auto-run writes', async () => {
    const { api, emitUnauthorized } = fakeApi()
    const state = useAdminSession(api)
    const pendingWrite = vi.fn()
    await state.initialize()
    emitUnauthorized()
    vi.mocked(api.login).mockResolvedValue({ ...session, csrfToken: 'fresh-csrf' })

    await state.login('alice', 'new-password')

    expect(state.status.value).toBe('authenticated')
    expect(state.csrfToken.value).toBe('fresh-csrf')
    expect(pendingWrite).not.toHaveBeenCalled()
  })

  it('clears local state on logout even if the server session is already gone', async () => {
    const { api } = fakeApi()
    const state = useAdminSession(api)
    await state.initialize()
    vi.mocked(api.logout).mockRejectedValue(new AdminApiError('unauthorized', '登录已过期'))

    await state.logout()

    expect(api.logout).toHaveBeenCalledWith('csrf-token')
    expect(state.status.value).toBe('anonymous')
    expect(state.username.value).toBeNull()
    expect(state.csrfToken.value).toBeNull()
  })

  it.each([
    new AdminApiError('unavailable', '服务暂时不可用，请稍后重试'),
    new AdminApiError('forbidden', '请求被拒绝，请刷新页面后重试'),
    new AdminApiError('invalid-response', '服务器返回了无效数据'),
    new Error('unexpected internal failure'),
  ])('preserves authenticated memory and rejects when logout did not reach a valid boundary', async (error) => {
    const { api } = fakeApi()
    const state = useAdminSession(api)
    await state.initialize()
    vi.mocked(api.logout).mockRejectedValue(error)

    await expect(state.logout()).rejects.toBe(error)

    expect(state.status.value).toBe('authenticated')
    expect(state.username.value).toBe('alice')
    expect(state.csrfToken.value).toBe('csrf-token')
  })
})
