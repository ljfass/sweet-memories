// @ts-expect-error -- Node test helpers are intentionally outside the browser tsconfig types.
import { readFileSync } from 'node:fs'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import AdminApp from './AdminApp.vue'
import { AdminApiError } from './api'
import type {
  AdminPhoto,
  AdminPhotoApiClient,
  AdminSessionState,
  AdminUploadApiClient,
} from './types'

function photo(overrides: Partial<AdminPhoto> = {}): AdminPhoto {
  return {
    id: 'legacy-photo',
    title: '第一次散步',
    alt: '宝宝在公园散步',
    description: null,
    capturedDate: null,
    status: 'migration_pending',
    version: 1,
    transform: { rotation: 0, x: 0, y: 0 },
    sources: {
      avif: [{ url: '/media/legacy-photo/320.avif', width: 320 }],
      webp: [{ url: '/media/legacy-photo/320.webp', width: 320 }],
      jpeg: [{ url: '/media/legacy-photo/320.jpg', width: 320 }],
      fallback: { url: '/media/legacy-photo/320.jpg', width: 320, height: 240 },
    },
    ...overrides,
  }
}

function session(initial: 'anonymous' | 'authenticated' = 'authenticated'): AdminSessionState {
  const status = ref<AdminSessionState['status']['value']>(initial)
  const username = ref<string | null>(initial === 'authenticated' ? 'alice' : null)
  const csrfToken = ref<string | null>(initial === 'authenticated' ? 'csrf-token' : null)
  return {
    status,
    username,
    csrfToken,
    initialize: vi.fn(async () => undefined),
    login: vi.fn(async (nextUsername) => {
      username.value = nextUsername
      csrfToken.value = 'fresh-csrf-token'
      status.value = 'authenticated'
    }),
    logout: vi.fn(async () => {
      username.value = null
      csrfToken.value = null
      status.value = 'anonymous'
    }),
  }
}

function photoApi(initial: readonly AdminPhoto[]): AdminPhotoApiClient {
  return {
    listPhotos: vi.fn(async () => initial),
    updatePhoto: vi.fn(async (id, input) => ({
      ...initial.find((candidate) => candidate.id === id)!,
      title: input.title,
      description: input.description,
      capturedDate: input.capturedDate,
      version: input.version + 1,
    })),
    deletePhoto: vi.fn(async () => undefined),
  }
}

function idleUploadApi(): AdminUploadApiClient {
  return { uploadPhoto: vi.fn() }
}

function deferred<T>(): {
  readonly promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('AdminApp integration', () => {
  const adminCss = readFileSync('src/styles/admin.css', 'utf8')

  it('keeps the migration draft through reauthentication and only saves after an explicit action', async () => {
    const adminSession = session('anonymous')
    const legacyPhoto = photo()
    const photos = photoApi([legacyPhoto])
    const uploads = idleUploadApi()
    const wrapper = mount(AdminApp, {
      attachTo: document.body,
      props: { session: adminSession, photoApi: photos, uploadApi: uploads },
    })

    await wrapper.get('input[name="username"]').setValue('alice')
    await wrapper.get('input[name="password"]').setValue('correct-password')
    await wrapper.get('.admin-login form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('.admin-migration-banner').text())
      .toContain('正在准备旧照片，暂未开放上传')
    expect(wrapper.get('[data-upload]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-photo-id="legacy-photo"] button').trigger('click')
    const dateInput = wrapper.get('input[name="capturedDate"]')
    await dateInput.setValue('2026-05-01')

    adminSession.status.value = 'reauth-required'
    adminSession.csrfToken.value = null
    await flushPromises()

    expect((wrapper.get('input[name="capturedDate"]').element as HTMLInputElement).value)
      .toBe('2026-05-01')
    expect(wrapper.get('.admin-workspace-content').attributes('inert')).toBeDefined()
    expect(wrapper.get('.admin-workspace-content').attributes('aria-hidden')).toBe('true')
    expect(photos.updatePhoto).not.toHaveBeenCalled()

    await wrapper.get('[role="dialog"] input[name="password"]').setValue('new-password')
    await wrapper.get('[role="dialog"] form').trigger('submit')
    await flushPromises()

    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect((wrapper.get('input[name="capturedDate"]').element as HTMLInputElement).value)
      .toBe('2026-05-01')
    expect(photos.updatePhoto).not.toHaveBeenCalled()
    await wrapper.get('.admin-photo-editor form').trigger('submit')
    await flushPromises()

    expect(photos.updatePhoto).toHaveBeenCalledWith('legacy-photo', {
      title: '第一次散步',
      description: null,
      capturedDate: '2026-05-01',
      version: 1,
    }, 'fresh-csrf-token')
    expect(wrapper.get('.admin-form-message').text()).toBe('保存成功')
    expect(wrapper.get('.admin-form-message').classes()).toContain('is-success')
    expect(uploads.uploadPhoto).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('recovers from an unavailable API to a compact empty library without exposing details', async () => {
    const adminSession = session()
    const photos = photoApi([])
    vi.mocked(photos.listPhotos)
      .mockRejectedValueOnce(new Error('ECONNREFUSED http://127.0.0.1:3000 private stack'))
      .mockResolvedValueOnce([])
    const wrapper = mount(AdminApp, {
      props: { session: adminSession, photoApi: photos, uploadApi: idleUploadApi() },
    })
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('暂时无法加载照片，请稍后重试')
    expect(wrapper.text()).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|private|stack/i)
    await wrapper.get('.admin-library-error button').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('还没有照片')
    expect(wrapper.find('.admin-library-layout').exists()).toBe(false)
  })

  it('shows the current photo total and updates it after a refresh', async () => {
    const first = photo({ id: 'photo-1', status: 'published' })
    const second = photo({ id: 'photo-2', status: 'published' })
    const photos = photoApi([first, second])
    vi.mocked(photos.listPhotos)
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([second])
    const wrapper = mount(AdminApp, {
      props: { session: session(), photoApi: photos, uploadApi: idleUploadApi() },
    })
    await flushPromises()

    expect(wrapper.get('[data-photo-count]').text()).toBe('共 2 张')

    await wrapper.get('[data-refresh]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-photo-count]').text()).toBe('共 1 张')
  })

  it('shows one completion notification for a successful two-photo upload batch', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation((file) => `blob:${(file as File).name}`)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const uploads: AdminUploadApiClient = {
      uploadPhoto: vi.fn()
        .mockResolvedValueOnce(photo({ id: 'photo-1', title: '第一张', status: 'published' }))
        .mockResolvedValueOnce(photo({ id: 'photo-2', title: '第二张', status: 'published' })),
    }
    const wrapper = mount(AdminApp, {
      props: { session: session(), photoApi: photoApi([]), uploadApi: uploads },
    })
    await flushPromises()
    const input = wrapper.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [
        new File(['one'], 'one.jpg', { type: 'image/jpeg' }),
        new File(['two'], 'two.jpg', { type: 'image/jpeg' }),
      ],
    })

    await input.trigger('change')
    await flushPromises()

    const notifications = wrapper.get('[data-success-notifications]')
    expect(notifications.findAll('[data-success-notification]')).toHaveLength(1)
    expect(notifications.text()).toContain('2 张照片上传完成')
    expect(wrapper.findAll('[data-upload-item]')).toHaveLength(2)
    expect(wrapper.text()).toContain('上传队列已完成')
    expect(wrapper.findAll('.admin-upload-item').every((item) =>
      item.text().includes('上传完成'))).toBe(true)
    wrapper.unmount()
  })

  it('only shows refresh success after an accepted user refresh', async () => {
    const first = photo({ id: 'photo-1', status: 'published' })
    const second = photo({ id: 'photo-2', status: 'published' })
    const photos = photoApi([first])
    vi.mocked(photos.listPhotos)
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([first, second])
    const wrapper = mount(AdminApp, {
      props: { session: session(), photoApi: photos, uploadApi: idleUploadApi() },
    })
    await flushPromises()

    const notifications = wrapper.get('[data-success-notifications]')
    expect(notifications.findAll('[data-success-notification]')).toHaveLength(0)

    await wrapper.get('[data-refresh]').trigger('click')
    await flushPromises()

    expect(notifications.findAll('[data-success-notification]')).toHaveLength(1)
    expect(notifications.text()).toContain('刷新成功 · 共 2 张')
    wrapper.unmount()
  })

  it('keeps the safe refresh error without showing a success notification', async () => {
    const existing = photo({ id: 'photo-1', status: 'published' })
    const photos = photoApi([existing])
    vi.mocked(photos.listPhotos)
      .mockResolvedValueOnce([existing])
      .mockRejectedValueOnce(new Error('/srv/private refresh failure'))
    const wrapper = mount(AdminApp, {
      props: { session: session(), photoApi: photos, uploadApi: idleUploadApi() },
    })
    await flushPromises()

    await wrapper.get('[data-refresh]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-success-notifications]')
      .findAll('[data-success-notification]')).toHaveLength(0)
    expect(wrapper.get('.admin-library-refresh-message').text())
      .toBe('暂时无法加载照片，请稍后重试')
    expect(wrapper.text()).not.toContain('/srv/private refresh failure')
    wrapper.unmount()
  })

  it('keeps upload and refresh completion notifications visible together', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:uploaded-photo')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const uploaded = photo({ id: 'photo-1', title: '新照片', status: 'published' })
    const photos = photoApi([])
    vi.mocked(photos.listPhotos)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([uploaded])
    const uploads: AdminUploadApiClient = {
      uploadPhoto: vi.fn(async () => uploaded),
    }
    const wrapper = mount(AdminApp, {
      props: { session: session(), photoApi: photos, uploadApi: uploads },
    })
    await flushPromises()
    const input = wrapper.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [new File(['photo'], 'new-photo.jpg', { type: 'image/jpeg' })],
    })

    await input.trigger('change')
    await flushPromises()
    await wrapper.get('[data-refresh]').trigger('click')
    await flushPromises()

    const notices = wrapper.get('[data-success-notifications]')
      .findAll('[data-success-notification]')
    expect(notices).toHaveLength(2)
    expect(notices.map((notice) => notice.text())).toEqual([
      expect.stringContaining('1 张照片上传完成'),
      expect.stringContaining('刷新成功 · 共 1 张'),
    ])
    wrapper.unmount()
  })

  it('suspends existing notifications during reauthentication and photo modals', async () => {
    const existing = photo({ id: 'photo-1', status: 'published' })
    const adminSession = session()
    const photos = photoApi([existing])
    const wrapper = mount(AdminApp, {
      attachTo: document.body,
      props: { session: adminSession, photoApi: photos, uploadApi: idleUploadApi() },
    })
    await flushPromises()
    await wrapper.get('[data-refresh]').trigger('click')
    await flushPromises()

    const notifications = wrapper.get('[data-success-notifications]')
    const notice = notifications.get('[data-success-notification]')
    const dismiss = notice.get('[data-dismiss-success]')
    expect(notifications.element.closest('.admin-workspace-content')).toBeNull()

    adminSession.status.value = 'reauth-required'
    await flushPromises()

    expect(notifications.attributes('aria-live')).toBe('polite')
    expect(notifications.attributes('data-suspended')).toBe('true')
    expect(notice.attributes('tabindex')).toBe('-1')
    expect(dismiss.attributes('disabled')).toBeDefined()

    adminSession.status.value = 'authenticated'
    await flushPromises()

    expect(notifications.attributes('data-suspended')).toBeUndefined()
    expect(notice.attributes('tabindex')).toBe('0')
    expect(dismiss.attributes('disabled')).toBeUndefined()

    await wrapper.get('[data-photo-id="photo-1"] button').trigger('click')
    await wrapper.get('[data-open-delete]').trigger('click')
    await flushPromises()

    expect(notifications.attributes('aria-live')).toBe('polite')
    expect(notifications.attributes('data-suspended')).toBe('true')
    expect(notice.attributes('tabindex')).toBe('-1')
    expect(dismiss.attributes('disabled')).toBeDefined()

    await wrapper.get('[role="dialog"] .admin-secondary-button').trigger('click')
    await flushPromises()

    expect(notifications.attributes('data-suspended')).toBeUndefined()
    expect(notice.attributes('tabindex')).toBe('0')
    expect(dismiss.attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('discards paused notifications when reauthentication ends in logout', async () => {
    vi.useFakeTimers()
    const existing = photo({ id: 'photo-1', status: 'published' })
    const adminSession = session()
    const wrapper = mount(AdminApp, {
      attachTo: document.body,
      props: {
        session: adminSession,
        photoApi: photoApi([existing]),
        uploadApi: idleUploadApi(),
      },
    })
    await flushPromises()
    await wrapper.get('[data-refresh]').trigger('click')
    await flushPromises()

    const notice = wrapper.get('[data-success-notification]')
    await notice.trigger('mouseenter')
    adminSession.status.value = 'reauth-required'
    await flushPromises()
    await wrapper.get('[data-testid="reauth-logout"]').trigger('click')
    await flushPromises()

    expect(adminSession.status.value).toBe('anonymous')
    expect(wrapper.find('[data-success-notifications]').exists()).toBe(false)

    vi.advanceTimersByTime(10_000)
    adminSession.status.value = 'authenticated'
    adminSession.csrfToken.value = 'next-session-csrf-token'
    await flushPromises()

    expect(wrapper.get('[data-success-notifications]')
      .findAll('[data-success-notification]')).toHaveLength(0)
    wrapper.unmount()
  })

  it('does not surface an upload completion from a logged-out session', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pending-upload')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const completion = deferred<AdminPhoto>()
    const adminSession = session()
    const uploads: AdminUploadApiClient = {
      uploadPhoto: vi.fn()
        .mockImplementationOnce(() => completion.promise)
        .mockResolvedValueOnce(photo({ id: 'new-session-photo', status: 'published' })),
    }
    const wrapper = mount(AdminApp, {
      props: { session: adminSession, photoApi: photoApi([]), uploadApi: uploads },
    })
    await flushPromises()
    const input = wrapper.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [new File(['photo'], 'pending.jpg', { type: 'image/jpeg' })],
    })
    await input.trigger('change')
    expect(uploads.uploadPhoto).toHaveBeenCalledTimes(1)

    await wrapper.get('.admin-toolbar button').trigger('click')
    await flushPromises()

    expect(adminSession.status.value).toBe('anonymous')
    expect(wrapper.find('[data-success-notifications]').exists()).toBe(false)

    await wrapper.get('input[name="username"]').setValue('bob')
    await wrapper.get('input[name="password"]').setValue('new-session-password')
    await wrapper.get('.admin-login form').trigger('submit')
    await flushPromises()
    expect(adminSession.status.value).toBe('authenticated')

    completion.resolve(photo({ id: 'late-photo', status: 'published' }))
    await flushPromises()

    expect(wrapper.get('[data-success-notifications]')
      .findAll('[data-success-notification]')).toHaveLength(0)

    const nextInput = wrapper.get('input[type="file"]')
    Object.defineProperty(nextInput.element, 'files', {
      configurable: true,
      value: [new File(['new'], 'new-session.jpg', { type: 'image/jpeg' })],
    })
    await nextInput.trigger('change')
    await flushPromises()

    expect(uploads.uploadPhoto).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-success-notifications]').text())
      .toContain('1 张照片上传完成')
    wrapper.unmount()
  })

  it('does not surface a refresh completion while reauthentication is required', async () => {
    const existing = photo({ id: 'photo-1', status: 'published' })
    const completion = deferred<readonly AdminPhoto[]>()
    const adminSession = session()
    const photos = photoApi([existing])
    vi.mocked(photos.listPhotos)
      .mockResolvedValueOnce([existing])
      .mockImplementationOnce(() => completion.promise)
    const wrapper = mount(AdminApp, {
      props: { session: adminSession, photoApi: photos, uploadApi: idleUploadApi() },
    })
    await flushPromises()
    await wrapper.get('[data-refresh]').trigger('click')

    adminSession.status.value = 'reauth-required'
    await flushPromises()
    completion.resolve([existing])
    await flushPromises()

    expect(wrapper.get('[data-success-notifications]')
      .findAll('[data-success-notification]')).toHaveLength(0)

    adminSession.status.value = 'authenticated'
    adminSession.csrfToken.value = 'next-session-csrf-token'
    await flushPromises()

    expect(wrapper.get('[data-success-notifications]')
      .findAll('[data-success-notification]')).toHaveLength(0)
    wrapper.unmount()
  })

  it('keeps a production-data warning visible in local development', async () => {
    const wrapper = mount(AdminApp, {
      props: {
        session: session(),
        photoApi: photoApi([]),
        uploadApi: idleUploadApi(),
      },
    })
    await flushPromises()

    const warning = wrapper.get('[data-production-proxy-warning]')
    expect(warning.attributes('role')).toBe('status')
    expect(warning.text()).toContain('本地开发模式：正在直接操作线上生产数据')

    const warningRule = adminCss.match(
      /\.admin-production-proxy-banner\s*\{([^}]*)\}/,
    )?.[1] ?? ''
    expect(warningRule).toContain('background: #fff4e5')
    expect(warningRule).toContain('color: #713f12')
    expect(warningRule).not.toContain('position: fixed')
  })

  it('updates the photo total after a queued upload and permanent deletion', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:new-photo')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const existing = photo({ id: 'photo-1', status: 'published' })
    const uploaded = photo({ id: 'photo-2', title: '新上传照片', status: 'published' })
    const photos = photoApi([existing])
    const uploads: AdminUploadApiClient = {
      uploadPhoto: vi.fn(async () => uploaded),
    }
    const wrapper = mount(AdminApp, {
      attachTo: document.body,
      props: { session: session(), photoApi: photos, uploadApi: uploads },
    })
    await flushPromises()
    const input = wrapper.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [new File(['photo'], 'new-photo.jpg', { type: 'image/jpeg' })],
    })

    await input.trigger('change')
    await flushPromises()

    expect(wrapper.get('[data-photo-count]').text()).toBe('共 2 张')

    await wrapper.get('[data-photo-id="photo-2"] button').trigger('click')
    await wrapper.get('[data-open-delete]').trigger('click')
    await wrapper.get('[data-confirm-delete]').trigger('click')
    await flushPromises()

    expect(photos.deletePhoto).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-photo-count]').text()).toBe('共 1 张')
    wrapper.unmount()
  })

  it('shows independent network and disk-full failures in the real queue, then logs out cleanly', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation((file) => `blob:${(file as File).name}`)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const adminSession = session()
    const uploads: AdminUploadApiClient = {
      uploadPhoto: vi.fn()
        .mockRejectedValueOnce(new AdminApiError('unavailable', '/srv/private network error'))
        .mockRejectedValueOnce(new AdminApiError('storage-full', '/srv/private disk detail')),
    }
    const wrapper = mount(AdminApp, {
      props: { session: adminSession, photoApi: photoApi([]), uploadApi: uploads },
    })
    await flushPromises()
    const input = wrapper.get('input[type="file"]')
    const longName = `${'家庭成长纪念照片'.repeat(14)}.jpg`
    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [new File(['one'], longName), new File(['two'], '公园散步.jpg')],
    })

    await input.trigger('change')
    await flushPromises()

    expect(wrapper.text()).toContain('暂时无法上传，请稍后重试')
    expect(wrapper.text()).toContain('服务器存储空间不足')
    expect(wrapper.text()).toContain(longName)
    expect(wrapper.text()).not.toMatch(/\/srv\/private|network error|disk detail/i)
    expect(uploads.uploadPhoto).toHaveBeenCalledTimes(2)

    await wrapper.get('.admin-toolbar button').trigger('click')
    await flushPromises()

    expect(adminSession.logout).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.admin-workspace').exists()).toBe(false)
    expect(wrapper.get('.admin-login')).toBeDefined()
  })

  it('keeps photo-library toolbar controls at the stable 40px size', () => {
    const toolbarRule = adminCss.match(
      /\.admin-library-actions \.admin-primary-button,\s*\.admin-library-actions \.admin-secondary-button\s*\{([^}]*)\}/,
    )?.[1] ?? ''

    expect(toolbarRule).toContain('height: var(--admin-control-size)')
    expect(toolbarRule).toContain('min-height: var(--admin-control-size)')
  })

  it('styles successful saves as a prominent inline status', () => {
    const successRule = adminCss.match(
      /\.admin-form-message\.is-success\s*\{([^}]*)\}/,
    )?.[1] ?? ''

    expect(successRule).toContain('background: #edf7f1')
    expect(successRule).toContain('border-inline-start: 3px solid #176b45')
    expect(successRule).toContain('font-weight: 600')
    expect(successRule).toContain('padding: 8px 10px')
  })

  it('renders the little-journal brand and growth-album heading', async () => {
    const wrapper = mount(AdminApp, {
      props: {
        session: session(),
        photoApi: photoApi([photo({ status: 'published' })]),
        uploadApi: idleUploadApi(),
      },
    })
    await flushPromises()

    expect(wrapper.get('.admin-brand-mark svg')).toBeDefined()
    expect(wrapper.get('.admin-brand-mark').attributes('aria-hidden')).toBe('true')
    expect(wrapper.get('.admin-toolbar h1').text()).toBe('相册管理')
    expect(wrapper.get('#photo-library-title > span:first-child').text()).toBe('成长相册')
    expect(wrapper.get('[data-photo-count]').text()).toBe('共 1 张')
    expect(wrapper.get('.admin-logout-button').text()).toBe('关上日记本')
    expect(wrapper.find('.admin-logout-button svg').exists()).toBe(false)
  })

  it('defines the approved little-journal color tokens', () => {
    expect(adminCss).toContain('--admin-canvas: #f7f4f5')
    expect(adminCss).toContain('--admin-paper: #fffdfd')
    expect(adminCss).toContain('--admin-berry: #b84061')
    expect(adminCss).toContain('--admin-teal: #39767a')
    expect(adminCss).toContain('--admin-sun: #efa95a')
    expect(adminCss).not.toMatch(/linear-gradient|radial-gradient/)
  })

  it('keeps the approved desktop and mobile layout constraints', () => {
    expect(adminCss).toMatch(
      /\.admin-library-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*320px/s,
    )
    expect(adminCss).toMatch(
      /\.admin-photo-section-grid\s*\{[^}]*minmax\(180px,\s*1fr\)/s,
    )
    expect(adminCss).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*\.admin-photo-section-grid\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    )
    expect(adminCss).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*\.admin-photo-editor\s*\{[^}]*position:\s*fixed[^}]*height:\s*100dvh/,
    )
    expect(adminCss).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*\.admin-photo-editor\s*\{[^}]*padding:\s*0 16px 0;/,
    )
    expect(adminCss).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*\.admin-editor-footer\s*\{[^}]*position:\s*sticky;[^}]*z-index:\s*2;[^}]*bottom:\s*0;[^}]*margin:\s*16px -16px 0;[^}]*padding:\s*12px 16px calc\(12px \+ env\(safe-area-inset-bottom, 0px\)\);[^}]*background:\s*var\(--admin-paper\);/,
    )
    expect(adminCss).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*\.admin-photo-editor-header\s*\{[^}]*position:\s*sticky;[^}]*z-index:\s*2;[^}]*top:\s*0;[^}]*margin:\s*0 -16px 16px;[^}]*padding:\s*calc\(12px \+ env\(safe-area-inset-top, 0px\)\) 16px 12px;[^}]*background:\s*var\(--admin-paper\);/,
    )
    expect(adminCss).toMatch(
      /\.admin-photo-editor-header\s*\{[^}]*grid-template-columns:\s*1fr var\(--admin-control-size\);/,
    )
    expect(adminCss).toMatch(
      /\.admin-photo-editor-title\s*\{[^}]*text-align:\s*left;/,
    )
    expect(adminCss).toMatch(
      /\.admin-editor-back\s*\{[^}]*display:\s*none;/,
    )
    expect(adminCss).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*\.admin-mobile-floating-actions\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*45;[^}]*top:\s*calc\(12px \+ env\(safe-area-inset-top, 0px\)\);[^}]*right:\s*12px;[^}]*background:\s*rgb\(255 253 253 \/ 98%\);/,
    )
    expect(adminCss).toMatch(
      /\.admin-mobile-floating-actions\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) 44px;/,
    )
    expect(adminCss).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*\.admin-library-actions\s*\{[^}]*position:\s*static;/,
    )
    expect(adminCss).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*\.admin-mobile-year-nav\s*\{[^}]*position:\s*fixed;[^}]*right:\s*calc\(6px \+ env\(safe-area-inset-right, 0px\)\);[^}]*bottom:\s*calc\(24px \+ env\(safe-area-inset-bottom, 0px\)\);/,
    )
    expect(adminCss).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*\.admin-mobile-year-nav\s*\{[^}]*touch-action:\s*manipulation;/,
    )
    expect(adminCss).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*\.admin-mobile-year-nav-button\s*\{[^}]*touch-action:\s*manipulation;/,
    )
    expect(adminCss).toMatch(
      /\.admin-photo-year-section\s*\{[^}]*scroll-margin-top:\s*72px;/,
    )
    expect(adminCss).toMatch(
      /\.admin-year-nav,\s*\.admin-mobile-year-nav\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*80;[^}]*right:\s*20px;[^}]*bottom:\s*24px;/,
    )
    expect(adminCss).toMatch(
      /\.admin-year-nav-handle\s*\{[^}]*cursor:\s*grab;/,
    )
    expect(adminCss).toMatch(
      /\.admin-year-nav-button,\s*\.admin-mobile-year-nav-button\s*\{[^}]*cursor:\s*pointer;/,
    )
    expect(adminCss).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('uses the approved journal typography and warm year marker', () => {
    const markerRule = adminCss.match(
      /\.admin-photo-year-heading > span\s*\{([^}]*)\}/,
    )?.[1] ?? ''
    const titleRule = adminCss.match(
      /\.admin-photo-card-copy strong\s*\{([^}]*)\}/,
    )?.[1] ?? ''
    const dateRule = adminCss.match(
      /\.admin-photo-card-copy small\s*\{([^}]*)\}/,
    )?.[1] ?? ''

    expect(markerRule).toContain('width: 28px')
    expect(markerRule).toContain('height: 3px')
    expect(markerRule).toContain('background: var(--admin-sun)')
    expect(titleRule).toContain('font-family: var(--admin-serif)')
    expect(dateRule).toContain('font-size: 0.875rem')
    expect(dateRule).toContain('font-variant-numeric: tabular-nums')
  })

  it('keeps the captured-date field inside the mobile editor', () => {
    expect(adminCss).toMatch(
      /\.admin-date-field\s*\{[^}]*display:\s*flex;[^}]*min-width:\s*0;/s,
    )
    expect(adminCss).toMatch(
      /\.admin-date-field > input\[type="date"\]\s*\{[^}]*flex:\s*1 1 0;[^}]*width:\s*0;/s,
    )
    expect(adminCss).toMatch(
      /\.admin-clearable-field\s*\{[^}]*min-width:\s*0;/s,
    )
    expect(adminCss).toMatch(
      /\.admin-clearable-field > input\[type="date"\]\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s,
    )
    expect(adminCss).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*\.admin-clearable-field > input\[type="date"\]\s*\{[^}]*padding-right:\s*52px/,
    )
    expect(adminCss).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*\.admin-photo-editor \.admin-clear-field-button\.is-before-native-action\s*\{[^}]*right:\s*4px/,
    )
  })

  it('keeps mobile toolbar and editor controls at least 44px', () => {
    expect(adminCss).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*\.admin-library-actions \.admin-primary-button,[\s\S]*\.admin-library-actions \.admin-secondary-button\s*\{[^}]*min-height:\s*44px/,
    )
    expect(adminCss).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*\.admin-photo-editor \.admin-icon-button,[\s\S]*\.admin-photo-editor \.admin-editor-back\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/,
    )
  })

  it('styles mobile top-right toolbar action with a clean compact pill button without icons', () => {
    expect(adminCss).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*\.admin-toolbar-actions \.admin-logout-button\s*\{[^}]*height:\s*32px[^}]*min-height:\s*32px[^}]*border-radius:\s*16px/,
    )
    expect(adminCss).toMatch(
      /\.admin-toolbar-actions \.admin-logout-button\s*\{[^}]*border-radius:\s*20px[^}]*color:\s*#8a2846/,
    )
  })

  it('keeps the upload sparkle hover in the berry theme and only on precise pointers', () => {
    expect(adminCss).toMatch(
      /\.admin-sparkle-button\s*\{[^}]*position:\s*relative[^}]*border:\s*2px solid var\(--admin-berry\)/,
    )
    expect(adminCss).toMatch(
      /\.admin-sparkle-star\s*\{[^}]*color:\s*var\(--admin-berry\)[^}]*opacity:\s*0/,
    )
    expect(adminCss).toMatch(
      /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)\s*\{\s*\.admin-sparkle-button:hover:not\(:disabled\)\s*\{[^}]*background:\s*transparent[^}]*color:\s*var\(--admin-berry\)/,
    )
    expect(adminCss).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.admin-sparkle-star\s*\{\s*transition:\s*none/,
    )
  })

  it('implements layered curtain reveal interaction on the refresh button for precise pointers', () => {
    expect(adminCss).toMatch(
      /\.admin-refresh-button\s*\{[^}]*position:\s*relative[^}]*border:\s*2px solid var\(--admin-berry\)/,
    )
    expect(adminCss).toMatch(
      /\.admin-refresh-button::before\s*\{[^}]*background-color:\s*var\(--admin-canvas\)[^}]*transform:\s*scaleY\(1\)/,
    )
    expect(adminCss).toMatch(
      /\.admin-refresh-button::after\s*\{[^}]*background-color:\s*var\(--admin-canvas\)[^}]*transform:\s*scaleY\(1\)/,
    )
    expect(adminCss).toMatch(
      /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)[\s\S]*\.admin-refresh-button:hover:not\(:disabled\)::before\s*\{[^}]*transform:\s*translateY\(-25px\)[^}]*height:\s*0/,
    )
    expect(adminCss).toMatch(
      /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)[\s\S]*\.admin-refresh-button:hover:not\(:disabled\)::after\s*\{[^}]*transform:\s*scaleX\(0\)[^}]*transition-delay:\s*0\.15s/,
    )
    expect(adminCss).toMatch(
      /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)[\s\S]*\.admin-refresh-button:hover:not\(:disabled\)\s*\.admin-refresh-icon\s*\{[^}]*transform:\s*rotate\(180deg\)/,
    )
    expect(adminCss).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.admin-refresh-button,[\s\S]*\.admin-refresh-icon\s*\{[^}]*transition:\s*none;[^}]*transform:\s*none;/,
    )
  })

  it('keeps production admin text at 14px or larger', () => {
    expect(adminCss).not.toMatch(/font-size:\s*0\.(?:[0-7]\d\d|8[0-6])rem/)
  })
})
