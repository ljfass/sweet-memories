import { flushPromises } from '@vue/test-utils'
import { effectScope, nextTick, ref, type Ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { AdminApiError } from './api'
import type {
  AdminPhoto,
  AdminSessionStatus,
  AdminUploadApiClient,
  UploadQueueState,
} from './types'
import { useUploadQueue } from './useUploadQueue'

const MEBIBYTE = 1024 * 1024

function photo(id: string): AdminPhoto {
  return {
    id,
    title: `照片 ${id}`,
    alt: `照片 ${id}`,
    description: null,
    capturedDate: '2026-09-02',
    status: 'published',
    version: 1,
    transform: { rotation: 0, x: 0, y: 0 },
    sources: {
      avif: [{ url: `/media/${id}/320.avif`, width: 320 }],
      webp: [{ url: `/media/${id}/320.webp`, width: 320 }],
      jpeg: [{ url: `/media/${id}/320.jpg`, width: 320 }],
      fallback: { url: `/media/${id}/320.jpg`, width: 320, height: 240 },
    },
  }
}

function file(name: string, size = 32): File {
  const selected = new File(['photo'], name, { type: 'image/jpeg' })
  Object.defineProperty(selected, 'size', { configurable: true, value: size })
  return selected
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

interface UploadCall {
  readonly file: File
  readonly requestId: string
  readonly csrfToken: string
  readonly reportProgress: (progress: number) => void
  readonly result: ReturnType<typeof deferred<AdminPhoto>>
}

function controlledApi(): {
  readonly api: AdminUploadApiClient
  readonly calls: UploadCall[]
  readonly maxActive: () => number
} {
  const calls: UploadCall[] = []
  let active = 0
  let maximum = 0
  const api: AdminUploadApiClient = {
    uploadPhoto: vi.fn((selectedFile, requestId, csrfToken, reportProgress) => {
      active += 1
      maximum = Math.max(maximum, active)
      const result = deferred<AdminPhoto>()
      calls.push({ file: selectedFile, requestId, csrfToken, reportProgress, result })
      return result.promise.finally(() => {
        active -= 1
      })
    }),
  }
  return { api, calls, maxActive: () => maximum }
}

function createQueue(
  api: AdminUploadApiClient,
  overrides: {
    readonly status?: Ref<AdminSessionStatus>
    readonly csrfToken?: Ref<string | null>
    readonly onUploaded?: (uploaded: AdminPhoto) => void
  } = {},
): UploadQueueState {
  let sequence = 0
  return useUploadQueue({
    api,
    sessionStatus: overrides.status ?? ref('authenticated'),
    csrfToken: overrides.csrfToken ?? ref('csrf-token'),
    createId: () => `0195c681-9c63-7db0-8000-${String(++sequence).padStart(12, '0')}`,
    createObjectUrl: (selectedFile) => `blob:${selectedFile.name}`,
    revokeObjectUrl: vi.fn(),
    onUploaded: overrides.onUploaded,
  })
}

describe('useUploadQueue', () => {
  it('accepts at most ten files per selection and prechecks each 10 MiB boundary', async () => {
    const controlled = controlledApi()
    const queue = createQueue(controlled.api)

    expect(() => queue.add(Array.from({ length: 11 }, (_, index) => file(`${index}.jpg`))))
      .toThrow('一次最多选择 10 张照片')
    expect(queue.items.value).toHaveLength(0)

    const maximum = file('maximum.jpg', 10 * MEBIBYTE)
    const oversized = file('oversized.jpg', 10 * MEBIBYTE + 1)
    const unknownExtension = file('camera.raw')
    queue.add([maximum, oversized, unknownExtension])
    await flushPromises()

    expect(controlled.calls.map((call) => call.file)).toEqual([maximum, unknownExtension])
    expect(queue.items.value[2]).toMatchObject({
      file: unknownExtension,
      hasUnrecognizedExtension: true,
    })
    expect(queue.items.value[1]).toMatchObject({
      file: oversized,
      status: 'failed',
      errorCode: 'file-too-large',
    })
  })

  it('runs at most two uploads, reports progress, and lets later items continue after one fails', async () => {
    const controlled = controlledApi()
    const uploaded = vi.fn()
    const queue = createQueue(controlled.api, { onUploaded: uploaded })
    queue.add(Array.from({ length: 5 }, (_, index) => file(`${index + 1}.jpg`)))
    await flushPromises()

    expect(controlled.calls).toHaveLength(2)
    expect(controlled.maxActive()).toBe(2)
    controlled.calls[0]?.reportProgress(64)
    expect(queue.items.value[0]).toMatchObject({ progress: 64, status: 'uploading' })

    controlled.calls[0]?.result.resolve(photo('uploaded-1'))
    controlled.calls[1]?.result.reject(new AdminApiError('unavailable', 'private server detail'))
    await flushPromises()

    expect(controlled.calls).toHaveLength(4)
    expect(queue.items.value[0]).toMatchObject({ status: 'succeeded', progress: 100 })
    expect(queue.items.value[1]).toMatchObject({ status: 'failed', errorCode: 'upload-unavailable' })
    expect(uploaded).toHaveBeenCalledWith(photo('uploaded-1'))
    expect(controlled.maxActive()).toBe(2)

    controlled.calls[2]?.result.resolve(photo('uploaded-3'))
    controlled.calls[3]?.result.resolve(photo('uploaded-4'))
    await flushPromises()
    expect(controlled.calls).toHaveLength(5)
    controlled.calls[4]?.result.resolve(photo('uploaded-5'))
    await flushPromises()
    expect(queue.status.value).toBe('complete')
  })

  it('retries one failed item with its original UUID and does not resend successful items', async () => {
    const controlled = controlledApi()
    const queue = createQueue(controlled.api)
    queue.add([file('first.jpg'), file('second.jpg')])
    await flushPromises()
    const firstRequestId = controlled.calls[0]?.requestId
    const secondRequestId = controlled.calls[1]?.requestId

    controlled.calls[0]?.result.reject(new AdminApiError('unavailable', 'temporary'))
    controlled.calls[1]?.result.resolve(photo('second'))
    await flushPromises()
    queue.retry(queue.items.value[0]!.id)
    await flushPromises()

    expect(controlled.calls).toHaveLength(3)
    expect(controlled.calls[2]?.requestId).toBe(firstRequestId)
    expect(controlled.calls.filter((call) => call.requestId === secondRequestId)).toHaveLength(1)
  })

  it('pauses after 401 and requires an explicit continue after successful reauthentication', async () => {
    const controlled = controlledApi()
    const sessionStatus = ref<AdminSessionStatus>('authenticated')
    const csrfToken = ref<string | null>('old-csrf')
    const queue = createQueue(controlled.api, { status: sessionStatus, csrfToken })
    queue.add([file('one.jpg'), file('two.jpg'), file('three.jpg')])
    await flushPromises()
    const firstRequestId = controlled.calls[0]?.requestId

    sessionStatus.value = 'reauth-required'
    csrfToken.value = null
    controlled.calls[0]?.result.reject(new AdminApiError('unauthorized', 'expired'))
    controlled.calls[1]?.result.resolve(photo('two'))
    await flushPromises()

    expect(queue.status.value).toBe('paused-auth')
    expect(controlled.calls).toHaveLength(2)
    expect(queue.items.value.map((item) => item.status)).toEqual(['paused', 'succeeded', 'paused'])

    csrfToken.value = 'fresh-csrf'
    sessionStatus.value = 'authenticated'
    await nextTick()
    await flushPromises()

    expect(queue.status.value).toBe('ready-to-resume')
    expect(controlled.calls).toHaveLength(2)
    queue.continueAfterLogin()
    await flushPromises()

    expect(controlled.calls).toHaveLength(4)
    expect(controlled.calls[2]).toMatchObject({ requestId: firstRequestId, csrfToken: 'fresh-csrf' })
  })

  it('does not treat an empty queue during the initial anonymous check as a paused upload', async () => {
    const controlled = controlledApi()
    const sessionStatus = ref<AdminSessionStatus>('checking')
    const csrfToken = ref<string | null>(null)
    const queue = createQueue(controlled.api, { status: sessionStatus, csrfToken })

    sessionStatus.value = 'anonymous'
    await nextTick()
    csrfToken.value = 'first-login-csrf'
    sessionStatus.value = 'authenticated'
    await nextTick()
    queue.add([file('first-upload.jpg')])
    await flushPromises()

    expect(queue.status.value).toBe('uploading')
    expect(controlled.calls).toHaveLength(1)
    expect(controlled.calls[0]?.csrfToken).toBe('first-login-csrf')
  })

  it('keeps File objects only in memory and revokes previews when removed or disposed', async () => {
    const controlled = controlledApi()
    const revokeObjectUrl = vi.fn()
    let sequence = 0
    const scope = effectScope()
    const selected = file('family.jpg')
    const queue = scope.run(() => useUploadQueue({
      api: controlled.api,
      sessionStatus: ref('authenticated'),
      csrfToken: ref('csrf-token'),
      createId: () => `0195c681-9c63-7db0-8000-${String(++sequence).padStart(12, '0')}`,
      createObjectUrl: (queuedFile) => `blob:${queuedFile.name}`,
      revokeObjectUrl,
    }))!

    queue.add([selected])
    await flushPromises()
    expect(queue.items.value[0]).toMatchObject({ file: selected, previewUrl: 'blob:family.jpg' })
    controlled.calls[0]?.result.reject(new AdminApiError('unavailable', 'temporary'))
    await flushPromises()
    queue.remove(queue.items.value[0]!.id)
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:family.jpg')

    queue.add([file('second.jpg')])
    scope.stop()
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:second.jpg')
  })
})
