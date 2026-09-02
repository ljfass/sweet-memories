import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { AdminApiError } from './api'
import type { AdminPhoto, AdminPhotoApiClient } from './types'
import { usePhotoLibrary } from './usePhotoLibrary'

function photo(overrides: Partial<AdminPhoto> = {}): AdminPhoto {
  return {
    id: 'photo-1',
    title: '第一次散步',
    alt: '宝宝在公园散步',
    description: '宝宝在公园散步',
    capturedDate: '2026-05-01',
    status: 'published',
    version: 1,
    transform: { rotation: 0, x: 0, y: 0 },
    sources: {
      avif: [{ url: '/media/photo-1/320.avif', width: 320 }],
      webp: [{ url: '/media/photo-1/320.webp', width: 320 }],
      jpeg: [{ url: '/media/photo-1/320.jpg', width: 320 }],
      fallback: { url: '/media/photo-1/320.jpg', width: 320, height: 240 },
    },
    ...overrides,
  }
}

function fakeApi(initial: readonly AdminPhoto[] = [photo()]): AdminPhotoApiClient {
  return {
    listPhotos: vi.fn(async () => initial),
    updatePhoto: vi.fn(async (_id, input) => photo({
      title: input.title,
      description: input.description,
      capturedDate: input.capturedDate,
      version: input.version + 1,
    })),
    deletePhoto: vi.fn(async () => undefined),
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve: ((value: T) => void) | undefined
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return {
    promise,
    resolve: (value) => resolve?.(value),
  }
}

describe('usePhotoLibrary', () => {
  it('keeps independent drafts in memory and replaces the snapshot only after save succeeds', async () => {
    const api = fakeApi()
    const library = usePhotoLibrary(api, ref('csrf-token'))
    await library.load()
    library.select('photo-1')
    library.updateDraft('photo-1', { title: '未保存标题', description: '' })

    expect(library.draftFor('photo-1')).toMatchObject({ title: '未保存标题', description: '' })
    expect(library.photos.value[0]?.title).toBe('第一次散步')

    await library.save('photo-1')

    expect(api.updatePhoto).toHaveBeenCalledWith('photo-1', {
      title: '未保存标题',
      description: null,
      capturedDate: '2026-05-01',
      version: 1,
    }, 'csrf-token')
    expect(library.photos.value[0]).toMatchObject({ title: '未保存标题', version: 2 })
    expect(library.isDirty('photo-1')).toBe(false)
  })

  it('preserves the draft on 409 and only discards it when loading the latest snapshot', async () => {
    const api = fakeApi()
    vi.mocked(api.updatePhoto).mockRejectedValueOnce(
      new AdminApiError('conflict', '照片已在其他页面修改'),
    )
    const library = usePhotoLibrary(api, ref('csrf-token'))
    await library.load()
    library.select('photo-1')
    library.updateDraft('photo-1', { title: '我的草稿' })

    await library.save('photo-1')

    expect(library.draftFor('photo-1').title).toBe('我的草稿')
    expect(library.hasConflict('photo-1')).toBe(true)
    vi.mocked(api.listPhotos).mockResolvedValueOnce([photo({ title: '其他页面的新标题', version: 2 })])

    await library.loadLatest('photo-1')

    expect(library.draftFor('photo-1').title).toBe('其他页面的新标题')
    expect(library.hasConflict('photo-1')).toBe(false)
  })

  it('infers migration preparation from the real photo DTO and keeps failed deletions visible', async () => {
    const api = fakeApi([photo({ status: 'migration_pending', capturedDate: null })])
    const library = usePhotoLibrary(api, ref('csrf-token'))
    await library.load()

    expect(library.isMigrationPending.value).toBe(true)
    expect(library.uploadsDisabled.value).toBe(true)
    vi.mocked(api.deletePhoto).mockRejectedValueOnce(new AdminApiError('unavailable', 'private'))
    await expect(library.remove('photo-1')).resolves.toBe(false)
    expect(library.photos.value).toHaveLength(1)
    expect(library.messageFor('photo-1')).not.toMatch(/private/i)

    await expect(library.remove('photo-1')).resolves.toBe(true)
    expect(library.photos.value).toHaveLength(0)
  })

  it('does not send writes without an in-memory CSRF token', async () => {
    const api = fakeApi()
    const library = usePhotoLibrary(api, ref(null))
    await library.load()
    library.updateDraft('photo-1', { title: '不能提交的草稿' })

    await library.save('photo-1')
    await library.remove('photo-1')

    expect(api.updatePhoto).not.toHaveBeenCalled()
    expect(api.deletePhoto).not.toHaveBeenCalled()
    expect(library.photos.value).toHaveLength(1)
  })

  it('prevents duplicate save and delete requests while each write is pending', async () => {
    let resolveUpdate: ((value: AdminPhoto) => void) | undefined
    let resolveDelete: (() => void) | undefined
    const api = fakeApi()
    vi.mocked(api.updatePhoto).mockImplementation(() => new Promise((resolve) => {
      resolveUpdate = resolve
    }))
    vi.mocked(api.deletePhoto).mockImplementation(() => new Promise((resolve) => {
      resolveDelete = resolve
    }))
    const library = usePhotoLibrary(api, ref('csrf-token'))
    await library.load()
    library.updateDraft('photo-1', { title: '只保存一次' })

    const firstSave = library.save('photo-1')
    const secondSave = library.save('photo-1')
    expect(api.updatePhoto).toHaveBeenCalledTimes(1)
    resolveUpdate?.(photo({ title: '只保存一次', version: 2 }))
    await Promise.all([firstSave, secondSave])

    const firstDelete = library.remove('photo-1')
    const secondDelete = library.remove('photo-1')
    expect(api.deletePhoto).toHaveBeenCalledTimes(1)
    expect(api.deletePhoto).toHaveBeenCalledWith('photo-1', 2, 'csrf-token')
    resolveDelete?.()
    await Promise.all([firstDelete, secondDelete])
  })

  it('refreshes server snapshots without silently discarding a dirty draft', async () => {
    const api = fakeApi()
    const library = usePhotoLibrary(api, ref('csrf-token'))
    await library.load()
    library.updateDraft('photo-1', { title: '保留的本地草稿' })
    vi.mocked(api.listPhotos).mockResolvedValueOnce([photo({ title: '服务端新标题', version: 4 })])

    await library.refresh()

    expect(library.photos.value[0]).toMatchObject({ title: '服务端新标题', version: 4 })
    expect(library.draftFor('photo-1').title).toBe('保留的本地草稿')
    expect(library.isDirty('photo-1')).toBe(true)
  })

  it('marks a dirty draft as conflicted when refresh advances its base version and blocks save', async () => {
    const api = fakeApi()
    const library = usePhotoLibrary(api, ref('csrf-token'))
    await library.load()
    library.updateDraft('photo-1', { title: '不能覆盖的本地草稿' })
    vi.mocked(api.listPhotos).mockResolvedValueOnce([
      photo({ title: '其他管理员的新标题', version: 2 }),
    ])

    await library.refresh()
    await library.save('photo-1')

    expect(library.photos.value[0]).toMatchObject({ title: '其他管理员的新标题', version: 2 })
    expect(library.draftFor('photo-1').title).toBe('不能覆盖的本地草稿')
    expect(library.hasConflict('photo-1')).toBe(true)
    expect(api.updatePhoto).not.toHaveBeenCalled()
  })

  it('ignores an older load that resolves after a newer refresh', async () => {
    const older = deferred<readonly AdminPhoto[]>()
    const newer = deferred<readonly AdminPhoto[]>()
    const api = fakeApi()
    vi.mocked(api.listPhotos)
      .mockReset()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise)
    const library = usePhotoLibrary(api, ref('csrf-token'))

    const oldLoad = library.load()
    const newRefresh = library.refresh()
    newer.resolve([photo({ title: '最新响应', version: 3 })])
    await newRefresh
    older.resolve([photo({ title: '过期响应', version: 1 })])
    await oldLoad

    expect(library.photos.value[0]).toMatchObject({ title: '最新响应', version: 3 })
  })

  it('does not let a pending save response replace a newer refreshed version', async () => {
    const update = deferred<AdminPhoto>()
    const api = fakeApi()
    vi.mocked(api.updatePhoto).mockImplementationOnce(() => update.promise)
    const library = usePhotoLibrary(api, ref('csrf-token'))
    await library.load()
    library.updateDraft('photo-1', { title: '正在保存的草稿' })

    const save = library.save('photo-1')
    vi.mocked(api.listPhotos).mockResolvedValueOnce([
      photo({ title: '更新的服务端版本', version: 3 }),
    ])
    await library.refresh()
    update.resolve(photo({ title: '较早的保存响应', version: 2 }))
    await save

    expect(library.photos.value[0]).toMatchObject({ title: '更新的服务端版本', version: 3 })
    expect(library.draftFor('photo-1').title).toBe('正在保存的草稿')
    expect(library.hasConflict('photo-1')).toBe(true)
  })

  it('does not let a refresh started before save completion roll the saved version back', async () => {
    const refresh = deferred<readonly AdminPhoto[]>()
    const update = deferred<AdminPhoto>()
    const api = fakeApi()
    const library = usePhotoLibrary(api, ref('csrf-token'))
    await library.load()
    library.updateDraft('photo-1', { title: '已保存的新标题' })
    vi.mocked(api.listPhotos).mockImplementationOnce(() => refresh.promise)
    vi.mocked(api.updatePhoto).mockImplementationOnce(() => update.promise)

    const refreshing = library.refresh()
    const saving = library.save('photo-1')
    update.resolve(photo({ title: '已保存的新标题', version: 2 }))
    await saving
    refresh.resolve([photo({ title: '过期响应', version: 1 })])
    await refreshing

    expect(library.photos.value[0]).toMatchObject({ title: '已保存的新标题', version: 2 })
    expect(library.isDirty('photo-1')).toBe(false)
  })

  it('does not let a load started before successful deletion resurrect the photo', async () => {
    const refresh = deferred<readonly AdminPhoto[]>()
    const api = fakeApi()
    const library = usePhotoLibrary(api, ref('csrf-token'))
    await library.load()
    vi.mocked(api.listPhotos).mockImplementationOnce(() => refresh.promise)

    const refreshing = library.refresh()
    await expect(library.remove('photo-1')).resolves.toBe(true)
    refresh.resolve([photo()])
    await refreshing

    expect(library.photos.value).toEqual([])
    expect(library.status.value).toBe('ready')
  })

  it('monotonically adds an uploaded photo without overwriting an existing dirty draft', async () => {
    const api = fakeApi()
    const library = usePhotoLibrary(api, ref('csrf-token'))
    await library.load()
    library.updateDraft('photo-1', { title: '保留的本地草稿' })

    const uploaded = photo({
      id: 'uploaded-photo',
      title: '刚上传的照片',
      sources: {
        avif: [{ url: '/media/uploaded-photo/320.avif', width: 320 }],
        webp: [{ url: '/media/uploaded-photo/320.webp', width: 320 }],
        jpeg: [{ url: '/media/uploaded-photo/320.jpg', width: 320 }],
        fallback: { url: '/media/uploaded-photo/320.jpg', width: 320, height: 240 },
      },
    })
    library.addUploadedPhoto(uploaded)
    library.addUploadedPhoto(photo({ title: '过期的上传响应', version: 0 }))

    expect(library.photos.value.map((entry) => entry.id)).toEqual(['uploaded-photo', 'photo-1'])
    expect(library.draftFor('photo-1').title).toBe('保留的本地草稿')
    expect(library.isDirty('photo-1')).toBe(true)
  })

  it('keeps an uploaded photo while allowing an already pending refresh to finish', async () => {
    const refresh = deferred<readonly AdminPhoto[]>()
    const api = fakeApi()
    const library = usePhotoLibrary(api, ref('csrf-token'))
    await library.load()
    vi.mocked(api.listPhotos).mockImplementationOnce(() => refresh.promise)

    const refreshing = library.refresh()
    const uploaded = photo({
      id: 'uploaded-photo',
      title: '刚上传的照片',
      sources: {
        avif: [{ url: '/media/uploaded-photo/320.avif', width: 320 }],
        webp: [{ url: '/media/uploaded-photo/320.webp', width: 320 }],
        jpeg: [{ url: '/media/uploaded-photo/320.jpg', width: 320 }],
        fallback: { url: '/media/uploaded-photo/320.jpg', width: 320, height: 240 },
      },
    })
    library.addUploadedPhoto(uploaded)
    refresh.resolve([photo({ title: '刷新后的服务端照片', version: 2 })])
    await refreshing

    expect(library.photos.value.map((entry) => entry.id)).toEqual(['uploaded-photo', 'photo-1'])
    expect(library.photos.value[1]).toMatchObject({ title: '刷新后的服务端照片', version: 2 })
  })

  it('does not cancel a pending load-latest action when an unrelated upload completes', async () => {
    const latest = deferred<readonly AdminPhoto[]>()
    const api = fakeApi()
    const library = usePhotoLibrary(api, ref('csrf-token'))
    await library.load()
    library.updateDraft('photo-1', { title: '应被最新版本替换的草稿' })
    vi.mocked(api.listPhotos).mockImplementationOnce(() => latest.promise)

    const loadingLatest = library.loadLatest('photo-1')
    library.addUploadedPhoto(photo({
      id: 'uploaded-photo',
      sources: {
        avif: [{ url: '/media/uploaded-photo/320.avif', width: 320 }],
        webp: [{ url: '/media/uploaded-photo/320.webp', width: 320 }],
        jpeg: [{ url: '/media/uploaded-photo/320.jpg', width: 320 }],
        fallback: { url: '/media/uploaded-photo/320.jpg', width: 320, height: 240 },
      },
    }))
    latest.resolve([photo({ title: '已加载最新版本', version: 3 })])
    await loadingLatest

    expect(library.photos.value.map((entry) => entry.id)).toEqual(['uploaded-photo', 'photo-1'])
    expect(library.draftFor('photo-1').title).toBe('已加载最新版本')
    expect(library.hasConflict('photo-1')).toBe(false)
  })
})
