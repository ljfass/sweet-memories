import { getCurrentScope, onScopeDispose, ref, watch, type Ref } from 'vue'
import { AdminApiError } from './api'
import type {
  AdminPhoto,
  AdminSessionStatus,
  AdminUploadApiClient,
  UploadErrorCode,
  UploadQueueItem,
  UploadQueueState,
} from './types'

const MAX_SELECTION_COUNT = 10
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_CONCURRENT_UPLOADS = 2
const RECOGNIZED_EXTENSION = /\.(?:heic|heif|jpe?g|png|webp)$/iu

export interface UploadQueueOptions {
  readonly api: AdminUploadApiClient
  readonly sessionStatus: Ref<AdminSessionStatus>
  readonly csrfToken: Ref<string | null>
  readonly onUploaded?: (photo: AdminPhoto) => void
  readonly createId?: () => string
  readonly createObjectUrl?: (file: File) => string
  readonly revokeObjectUrl?: (url: string) => void
}

function uploadErrorCode(error: unknown): UploadErrorCode {
  if (error instanceof AdminApiError) {
    switch (error.kind) {
      case 'upload-too-large': return 'file-too-large'
      case 'upload-invalid': return 'invalid-photo'
      case 'uploads-disabled': return 'uploads-disabled'
      case 'storage-full': return 'storage-full'
      case 'upload-busy': return 'upload-busy'
      default: return 'upload-unavailable'
    }
  }
  return 'upload-unavailable'
}

export function useUploadQueue(options: UploadQueueOptions): UploadQueueState {
  const items = ref<UploadQueueItem[]>([])
  const status = ref<UploadQueueState['status']['value']>('idle')
  const createId = options.createId ?? (() => globalThis.crypto.randomUUID())
  const createObjectUrl = options.createObjectUrl ?? ((file) => URL.createObjectURL(file))
  const revokeObjectUrl = options.revokeObjectUrl ?? ((url) => URL.revokeObjectURL(url))
  let activeCount = 0
  let authenticationPaused = false
  let disposed = false
  const attemptGenerations = new Map<string, number>()
  const activeUploads = new Map<string, {
    readonly generation: number
    readonly controller: AbortController
  }>()

  function replaceItem(id: string, patch: Partial<UploadQueueItem>): void {
    items.value = items.value.map((item) => item.id === id ? { ...item, ...patch } : item)
  }

  function updateQueueStatus(): void {
    if (items.value.length === 0) {
      status.value = 'idle'
    } else if (authenticationPaused) {
      status.value = options.sessionStatus.value === 'authenticated'
        ? 'ready-to-resume'
        : 'paused-auth'
    } else if (activeCount > 0 || items.value.some((item) => item.status === 'queued')) {
      status.value = 'uploading'
    } else {
      status.value = 'complete'
    }
  }

  function pauseForAuthentication(): void {
    if (!items.value.some((item) =>
      item.status === 'queued' || item.status === 'uploading' || item.status === 'paused')) {
      updateQueueStatus()
      return
    }
    authenticationPaused = true
    items.value = items.value.map((item) => item.status === 'queued'
      ? { ...item, status: 'paused' }
      : item)
    updateQueueStatus()
  }

  function schedule(): void {
    if (
      disposed
      || authenticationPaused
      || options.sessionStatus.value !== 'authenticated'
      || options.csrfToken.value === null
    ) {
      updateQueueStatus()
      return
    }
    while (activeCount < MAX_CONCURRENT_UPLOADS) {
      const next = items.value.find((item) => item.status === 'queued')
      if (next === undefined) break
      void startUpload(next)
    }
    updateQueueStatus()
  }

  async function startUpload(item: UploadQueueItem): Promise<void> {
    const token = options.csrfToken.value
    if (token === null || authenticationPaused || disposed) {
      pauseForAuthentication()
      return
    }
    const generation = (attemptGenerations.get(item.id) ?? 0) + 1
    const controller = new AbortController()
    attemptGenerations.set(item.id, generation)
    activeUploads.set(item.id, { generation, controller })
    const isCurrentAttempt = () => !disposed
      && attemptGenerations.get(item.id) === generation
      && items.value.some((candidate) => candidate.id === item.id)
    activeCount += 1
    replaceItem(item.id, { status: 'uploading', progress: 0, errorCode: null })
    updateQueueStatus()
    try {
      const uploaded = await options.api.uploadPhoto(
        item.file,
        item.requestId,
        token,
        (progress) => {
          if (!isCurrentAttempt()) return
          replaceItem(item.id, { progress: Math.max(0, Math.min(100, Math.round(progress))) })
        },
        controller.signal,
      )
      if (!isCurrentAttempt()) return
      replaceItem(item.id, {
        status: 'succeeded',
        progress: 100,
        errorCode: null,
        photo: uploaded,
      })
      options.onUploaded?.(uploaded)
    } catch (error) {
      if (!isCurrentAttempt()) return
      if (error instanceof AdminApiError && error.kind === 'unauthorized') {
        pauseForAuthentication()
        replaceItem(item.id, { status: 'paused', errorCode: null })
      } else {
        replaceItem(item.id, { status: 'failed', errorCode: uploadErrorCode(error) })
      }
    } finally {
      activeCount -= 1
      if (activeUploads.get(item.id)?.generation === generation) {
        activeUploads.delete(item.id)
      }
      schedule()
    }
  }

  function add(files: readonly File[]): void {
    if (files.length > MAX_SELECTION_COUNT) {
      throw new Error('一次最多选择 10 张照片')
    }
    const additions = files.map((file): UploadQueueItem => {
      const requestId = createId()
      const tooLarge = file.size > MAX_FILE_BYTES
      return {
        id: requestId,
        requestId,
        file,
        previewUrl: createObjectUrl(file),
        status: tooLarge ? 'failed' : authenticationPaused ? 'paused' : 'queued',
        progress: 0,
        errorCode: tooLarge ? 'file-too-large' : null,
        photo: null,
        hasUnrecognizedExtension: !RECOGNIZED_EXTENSION.test(file.name),
      }
    })
    items.value = [...items.value, ...additions]
    schedule()
  }

  function retry(id: string): void {
    const item = items.value.find((candidate) => candidate.id === id)
    if (item?.status !== 'failed') return
    if (item.file.size > MAX_FILE_BYTES) {
      replaceItem(id, { errorCode: 'file-too-large' })
      return
    }
    replaceItem(id, {
      status: authenticationPaused ? 'paused' : 'queued',
      progress: 0,
      errorCode: null,
    })
    schedule()
  }

  function remove(id: string): void {
    const item = items.value.find((candidate) => candidate.id === id)
    if (item === undefined) return
    attemptGenerations.set(id, (attemptGenerations.get(id) ?? 0) + 1)
    activeUploads.get(id)?.controller.abort()
    items.value = items.value.filter((candidate) => candidate.id !== id)
    revokeObjectUrl(item.previewUrl)
    updateQueueStatus()
  }

  function continueAfterLogin(): void {
    if (
      !authenticationPaused
      || options.sessionStatus.value !== 'authenticated'
      || options.csrfToken.value === null
    ) return
    authenticationPaused = false
    items.value = items.value.map((item) => item.status === 'paused'
      ? { ...item, status: 'queued' }
      : item)
    schedule()
  }

  watch(options.sessionStatus, (nextStatus) => {
    if (nextStatus === 'reauth-required' || nextStatus === 'anonymous') {
      pauseForAuthentication()
    } else if (nextStatus === 'authenticated' && authenticationPaused) {
      if (items.value.some((item) => item.status === 'paused')) {
        updateQueueStatus()
      } else {
        authenticationPaused = false
        schedule()
      }
    }
  })

  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true
      for (const [id, active] of activeUploads) {
        attemptGenerations.set(id, active.generation + 1)
        active.controller.abort()
      }
      for (const item of items.value) revokeObjectUrl(item.previewUrl)
    })
  }

  return { items, status, add, retry, remove, continueAfterLogin }
}
