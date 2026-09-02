import type { ComputedRef, Ref } from 'vue'

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

export interface AdminPhotoSource {
  readonly url: string
  readonly width: number
}

export interface AdminPhoto {
  readonly id: string
  readonly title: string
  readonly alt: string
  readonly description: string | null
  readonly capturedDate: string | null
  readonly status: 'migration_pending' | 'published'
  readonly version: number
  readonly transform: {
    readonly rotation: number
    readonly x: number
    readonly y: number
  }
  readonly sources: {
    readonly avif: readonly AdminPhotoSource[]
    readonly webp: readonly AdminPhotoSource[]
    readonly jpeg: readonly AdminPhotoSource[]
    readonly fallback: {
      readonly url: string
      readonly width: number
      readonly height: number
    }
  }
}

export interface PhotoDraft {
  readonly title: string
  readonly description: string
  readonly capturedDate: string
}

export interface PhotoUpdateInput {
  readonly title: string
  readonly description: string | null
  readonly capturedDate: string
  readonly version: number
}

export interface AdminPhotoApiClient {
  listPhotos(): Promise<readonly AdminPhoto[]>
  updatePhoto(
    id: string,
    input: PhotoUpdateInput,
    csrfToken: string,
  ): Promise<AdminPhoto>
  deletePhoto(id: string, version: number, csrfToken: string): Promise<void>
}

export interface PhotoLibraryState {
  readonly photos: Ref<readonly AdminPhoto[]>
  readonly status: Ref<'idle' | 'loading' | 'ready' | 'error'>
  readonly selectedId: Ref<string | null>
  readonly isMigrationPending: ComputedRef<boolean>
  readonly uploadsDisabled: ComputedRef<boolean>
  load(): Promise<void>
  refresh(): Promise<void>
  select(id: string | null): void
  draftFor(id: string): PhotoDraft
  updateDraft(id: string, patch: Partial<PhotoDraft>): void
  isDirty(id: string): boolean
  hasConflict(id: string): boolean
  isSaving(id: string): boolean
  messageFor(id: string): string
  save(id: string): Promise<void>
  loadLatest(id: string): Promise<void>
  remove(id: string): Promise<boolean>
}

export interface AdminSessionState {
  readonly status: Ref<AdminSessionStatus>
  readonly username: Ref<string | null>
  readonly csrfToken: Ref<string | null>
  initialize(): Promise<void>
  login(username: string, password: string): Promise<void>
  logout(): Promise<void>
}
