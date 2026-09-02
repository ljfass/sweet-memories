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
})
