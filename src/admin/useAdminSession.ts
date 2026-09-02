import { getCurrentScope, onScopeDispose, ref } from 'vue'
import { AdminApi, AdminApiError } from './api'
import type { AdminApiClient, AdminSession, AdminSessionState } from './types'

function clearSession(state: {
  readonly username: AdminSessionState['username']
  readonly csrfToken: AdminSessionState['csrfToken']
}): void {
  state.username.value = null
  state.csrfToken.value = null
}

export function useAdminSession(api: AdminApiClient = new AdminApi()): AdminSessionState {
  const status = ref<AdminSessionState['status']['value']>('checking')
  const username = ref<string | null>(null)
  const csrfToken = ref<string | null>(null)

  function applySession(session: AdminSession): void {
    username.value = session.username
    csrfToken.value = session.csrfToken
    status.value = 'authenticated'
  }

  const unsubscribe = api.onUnauthorized(() => {
    if (status.value === 'authenticated' || status.value === 'reauth-required') {
      csrfToken.value = null
      status.value = 'reauth-required'
    }
  })
  if (getCurrentScope()) {
    onScopeDispose(unsubscribe)
  }

  async function initialize(): Promise<void> {
    status.value = 'checking'
    try {
      applySession(await api.checkSession())
    } catch {
      clearSession({ username, csrfToken })
      status.value = 'anonymous'
    }
  }

  async function login(loginUsername: string, password: string): Promise<void> {
    applySession(await api.login(loginUsername, password))
  }

  async function logout(): Promise<void> {
    const token = csrfToken.value
    if (token === null) {
      clearSession({ username, csrfToken })
      status.value = 'anonymous'
      return
    }
    try {
      await api.logout(token)
    } catch (error) {
      if (!(error instanceof AdminApiError) || error.kind !== 'unauthorized') {
        throw error
      }
    }
    clearSession({ username, csrfToken })
    status.value = 'anonymous'
  }

  return { status, username, csrfToken, initialize, login, logout }
}
