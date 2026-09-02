import type { Ref } from 'vue'

export type AdminSessionStatus =
  | 'checking'
  | 'anonymous'
  | 'authenticated'
  | 'reauth-required'

export interface AdminSession {
  readonly username: string
  readonly csrfToken: string
  readonly idleExpiresAt: string
  readonly absoluteExpiresAt: string
}

export interface AdminApiClient {
  checkSession(): Promise<AdminSession>
  login(username: string, password: string): Promise<AdminSession>
  logout(csrfToken: string): Promise<void>
  onUnauthorized(listener: () => void): () => void
}

export interface AdminSessionState {
  readonly status: Ref<AdminSessionStatus>
  readonly username: Ref<string | null>
  readonly csrfToken: Ref<string | null>
  initialize(): Promise<void>
  login(username: string, password: string): Promise<void>
  logout(): Promise<void>
}
