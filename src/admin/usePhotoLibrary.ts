import { computed, reactive, ref, type Ref } from 'vue'
import { AdminApiError } from './api'
import type {
  AdminPhoto,
  AdminPhotoApiClient,
  PhotoDraft,
  PhotoLibraryState,
} from './types'

function draftFrom(photo: AdminPhoto): PhotoDraft {
  return {
    title: photo.title,
    description: photo.description ?? '',
    capturedDate: photo.capturedDate ?? '',
  }
}

function sameDraft(draft: PhotoDraft, photo: AdminPhoto): boolean {
  return draft.title === photo.title
    && draft.description === (photo.description ?? '')
    && draft.capturedDate === (photo.capturedDate ?? '')
}

function safeActionMessage(error: unknown, operation: 'load' | 'save' | 'delete'): string {
  if (error instanceof AdminApiError) {
    if (error.kind === 'conflict') return '照片已在其他页面修改'
    if (error.kind === 'not-found') return '照片不存在或已被删除'
    if (error.kind === 'unauthorized') return '登录已过期，请重新登录'
  }
  if (operation === 'load') return '暂时无法加载照片，请稍后重试'
  if (operation === 'save') return '暂时无法保存照片，请稍后重试'
  return '暂时无法删除照片，请稍后重试'
}

function validDraft(draft: PhotoDraft): string | null {
  const title = draft.title.normalize('NFC').trim()
  const description = draft.description.normalize('NFC').trim()
  if (title.includes('\u0000') || Array.from(title).length === 0 || Array.from(title).length > 120) {
    return '标题需要填写，且不能超过 120 个字符'
  }
  if (description.includes('\u0000') || Array.from(description).length > 500) {
    return '图片描述不能超过 500 个字符'
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.capturedDate)) {
    return '请填写拍摄日期'
  }
  return null
}

export function usePhotoLibrary(
  api: AdminPhotoApiClient,
  csrfToken: Ref<string | null>,
): PhotoLibraryState {
  const photos = ref<readonly AdminPhoto[]>([])
  const status = ref<PhotoLibraryState['status']['value']>('idle')
  const selectedId = ref<string | null>(null)
  const drafts = reactive(new Map<string, PhotoDraft>())
  const dirty = reactive(new Set<string>())
  const conflicts = reactive(new Set<string>())
  const saving = reactive(new Set<string>())
  const deleting = new Set<string>()
  const messages = reactive(new Map<string, string>())
  const isMigrationPending = computed(() =>
    photos.value.some((photo) => photo.status === 'migration_pending'))
  const uploadsDisabled = computed(() => isMigrationPending.value)

  function replacePhoto(nextPhoto: AdminPhoto): void {
    photos.value = photos.value.map((photo) => photo.id === nextPhoto.id ? nextPhoto : photo)
  }

  function synchronize(nextPhotos: readonly AdminPhoto[], replaceDraftId?: string): void {
    photos.value = nextPhotos
    const currentIds = new Set(nextPhotos.map((photo) => photo.id))
    for (const photo of nextPhotos) {
      if (!dirty.has(photo.id) || replaceDraftId === photo.id) {
        drafts.set(photo.id, draftFrom(photo))
      }
      if (replaceDraftId === photo.id) {
        dirty.delete(photo.id)
        conflicts.delete(photo.id)
        messages.delete(photo.id)
      }
    }
    for (const id of drafts.keys()) {
      if (!currentIds.has(id)) {
        drafts.delete(id)
        dirty.delete(id)
        conflicts.delete(id)
        messages.delete(id)
      }
    }
    if (selectedId.value !== null && !currentIds.has(selectedId.value)) {
      selectedId.value = null
    }
  }

  async function load(): Promise<void> {
    status.value = 'loading'
    try {
      synchronize(await api.listPhotos())
      status.value = 'ready'
    } catch (error) {
      status.value = 'error'
      messages.set('library', safeActionMessage(error, 'load'))
    }
  }

  async function refresh(): Promise<void> {
    await load()
  }

  function select(id: string | null): void {
    selectedId.value = id
    if (id === null) return
    const photo = photos.value.find((candidate) => candidate.id === id)
    if (photo !== undefined && !drafts.has(id)) drafts.set(id, draftFrom(photo))
  }

  function draftFor(id: string): PhotoDraft {
    const existing = drafts.get(id)
    if (existing !== undefined) return existing
    const photo = photos.value.find((candidate) => candidate.id === id)
    const draft = photo === undefined
      ? { title: '', description: '', capturedDate: '' }
      : draftFrom(photo)
    drafts.set(id, draft)
    return draft
  }

  function updateDraft(id: string, patch: Partial<PhotoDraft>): void {
    const next = { ...draftFor(id), ...patch }
    drafts.set(id, next)
    const photo = photos.value.find((candidate) => candidate.id === id)
    if (photo !== undefined && sameDraft(next, photo)) dirty.delete(id)
    else dirty.add(id)
    conflicts.delete(id)
    messages.delete(id)
  }

  async function save(id: string): Promise<void> {
    if (saving.has(id)) return
    const photo = photos.value.find((candidate) => candidate.id === id)
    if (photo === undefined) return
    const token = csrfToken.value
    if (token === null) {
      messages.set(id, '登录已过期，请重新登录')
      return
    }
    const draft = draftFor(id)
    const validationMessage = validDraft(draft)
    if (validationMessage !== null) {
      messages.set(id, validationMessage)
      return
    }
    saving.add(id)
    messages.delete(id)
    try {
      const updated = await api.updatePhoto(id, {
        title: draft.title.normalize('NFC').trim(),
        description: draft.description.normalize('NFC').trim() || null,
        capturedDate: draft.capturedDate,
        version: photo.version,
      }, token)
      replacePhoto(updated)
      drafts.set(id, draftFrom(updated))
      dirty.delete(id)
      conflicts.delete(id)
    } catch (error) {
      if (error instanceof AdminApiError && error.kind === 'conflict') conflicts.add(id)
      messages.set(id, safeActionMessage(error, 'save'))
    } finally {
      saving.delete(id)
    }
  }

  async function loadLatest(id: string): Promise<void> {
    try {
      const latest = await api.listPhotos()
      synchronize(latest, id)
      status.value = 'ready'
    } catch (error) {
      messages.set(id, safeActionMessage(error, 'load'))
    }
  }

  async function remove(id: string): Promise<boolean> {
    if (deleting.has(id)) return false
    const photo = photos.value.find((candidate) => candidate.id === id)
    const token = csrfToken.value
    if (photo === undefined || token === null) {
      messages.set(id, token === null ? '登录已过期，请重新登录' : '照片不存在或已被删除')
      return false
    }
    deleting.add(id)
    messages.delete(id)
    try {
      await api.deletePhoto(id, photo.version, token)
      photos.value = photos.value.filter((candidate) => candidate.id !== id)
      drafts.delete(id)
      dirty.delete(id)
      conflicts.delete(id)
      messages.delete(id)
      if (selectedId.value === id) selectedId.value = null
      return true
    } catch (error) {
      if (error instanceof AdminApiError && error.kind === 'conflict') conflicts.add(id)
      messages.set(id, safeActionMessage(error, 'delete'))
      return false
    } finally {
      deleting.delete(id)
    }
  }

  return {
    photos, status, selectedId, isMigrationPending, uploadsDisabled,
    load, refresh, select, draftFor, updateDraft,
    isDirty: (id) => dirty.has(id),
    hasConflict: (id) => conflicts.has(id),
    isSaving: (id) => saving.has(id),
    messageFor: (id) => messages.get(id) ?? '',
    save, loadLatest, remove,
  }
}
