import { flushPromises, mount } from '@vue/test-utils'
import { computed, h, nextTick, ref, shallowRef } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AdminApp from './AdminApp.vue'
import { AdminApiError } from './api'
import type {
  AdminPhoto,
  AdminPhotoApiClient,
  AdminSessionState,
  AdminUploadApiClient,
  PhotoDraft,
  PhotoLibraryState,
  UploadQueueState,
} from './types'
import PhotoLibrary from './PhotoLibrary.vue'

const photo: AdminPhoto = {
  id: 'photo-1', title: '第一次散步', alt: '宝宝在公园散步', description: null,
  capturedDate: '2026-05-01', status: 'published', version: 1,
  transform: { rotation: 0, x: 0, y: 0 },
  sources: {
    avif: [{ url: '/media/photo-1/320.avif', width: 320 }],
    webp: [{ url: '/media/photo-1/320.webp', width: 320 }],
    jpeg: [{ url: '/media/photo-1/320.jpg', width: 320 }],
    fallback: { url: '/media/photo-1/320.jpg', width: 320, height: 240 },
  },
}
const secondPhoto: AdminPhoto = {
  ...photo,
  id: 'photo-2',
  title: '第二次散步',
  sources: {
    avif: [{ url: '/media/photo-2/320.avif', width: 320 }],
    webp: [{ url: '/media/photo-2/320.webp', width: 320 }],
    jpeg: [{ url: '/media/photo-2/320.jpg', width: 320 }],
    fallback: { url: '/media/photo-2/320.jpg', width: 320, height: 240 },
  },
}

function photoRecord(
  id: string,
  title: string,
  capturedDate: string | null,
): AdminPhoto {
  return {
    ...photo,
    id,
    title,
    capturedDate,
    sources: {
      avif: [{ url: `/media/${id}/320.avif`, width: 320 }],
      webp: [{ url: `/media/${id}/320.webp`, width: 320 }],
      jpeg: [{ url: `/media/${id}/320.jpg`, width: 320 }],
      fallback: { url: `/media/${id}/320.jpg`, width: 320, height: 240 },
    },
  }
}

function library(overrides: Partial<PhotoLibraryState> = {}): PhotoLibraryState {
  const draft: PhotoDraft = { title: photo.title, description: '', capturedDate: '2026-05-01' }
  const selectedId = ref<string | null>(null)
  return {
    photos: ref([photo]), status: ref('ready'), selectedId,
    isRefreshing: ref(false),
    isMigrationPending: computed(() => false), uploadsDisabled: computed(() => false),
    load: vi.fn(async () => undefined), refresh: vi.fn(async () => true),
    select: vi.fn((id) => { selectedId.value = id }), draftFor: vi.fn(() => draft), updateDraft: vi.fn(),
    isDirty: vi.fn(() => false), hasConflict: vi.fn(() => false),
    isSaving: vi.fn(() => false), messageFor: vi.fn(() => ''),
    messageToneFor: vi.fn(() => null),
    save: vi.fn(async () => undefined), loadLatest: vi.fn(async () => undefined),
    remove: vi.fn(async () => true), addUploadedPhoto: vi.fn(),
    ...overrides,
  }
}

function installIntersectionObserver(): {
  readonly observe: ReturnType<typeof vi.fn>
  readonly disconnect: ReturnType<typeof vi.fn>
  readonly setIntersecting: (isIntersecting: boolean) => void
} {
  let callback: IntersectionObserverCallback | undefined
  const observe = vi.fn()
  const disconnect = vi.fn()
  vi.stubGlobal('IntersectionObserver', class {
    readonly unobserve = vi.fn()

    constructor(nextCallback: IntersectionObserverCallback) {
      callback = nextCallback
    }

    observe = observe
    disconnect = disconnect
  })
  return {
    observe,
    disconnect,
    setIntersecting: (isIntersecting) => callback?.([
      { isIntersecting } as IntersectionObserverEntry,
    ], {} as IntersectionObserver),
  }
}

function useViewport(matches: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn((query?: string) => ({
    matches: query?.includes('reduce') ? false : matches,
    media: query ?? '(max-width: 720px)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  })))
}

function deletableLibrary(photos: readonly AdminPhoto[]): PhotoLibraryState {
  const state = library({ photos: ref(photos) })
  vi.mocked(state.remove).mockImplementation(async (id) => {
    state.photos.value = state.photos.value.filter((candidate) => candidate.id !== id)
    state.select(null)
    return true
  })
  return state
}

function uploadQueue(): UploadQueueState {
  return {
    items: ref([]), status: ref('idle'), add: vi.fn(), retry: vi.fn(), remove: vi.fn(),
    continueAfterLogin: vi.fn(),
  }
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

async function deleteSelectedPhoto(
  wrapper: ReturnType<typeof mount>,
  id: string,
): Promise<void> {
  await wrapper.get(`[data-photo-id="${id}"] button`).trigger('click')
  await nextTick()
  await wrapper.get('[data-open-delete]').trigger('click')
  await nextTick()
  await wrapper.get('[data-confirm-delete]').trigger('click')
  await flushPromises()
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('PhotoLibrary', () => {
  it('shows the mobile floating actions only after the original actions leave the viewport', async () => {
    useViewport(true)
    const observer = installIntersectionObserver()
    const state = library()
    const wrapper = mount(PhotoLibrary, { props: { library: state } })

    expect(wrapper.find('[data-mobile-floating-actions]').exists()).toBe(false)
    observer.setIntersecting(false)
    await nextTick()

    expect(wrapper.get('[data-mobile-floating-actions]').attributes('aria-hidden')).toBe('false')
    expect(wrapper.get('[data-mobile-floating-actions] [data-upload]').text()).toContain('上传')
    expect(wrapper.get('[data-mobile-floating-actions] [data-refresh]').attributes('aria-label'))
      .toBe('刷新照片')
    expect(observer.observe).toHaveBeenCalledTimes(1)

    observer.setIntersecting(true)
    await nextTick()
    expect(wrapper.find('[data-mobile-floating-actions]').exists()).toBe(false)

    wrapper.unmount()
    expect(observer.disconnect).toHaveBeenCalledTimes(1)
  })

  it('shows mobile year quick nav when scrolling down and navigates to year sections on click', async () => {
    useViewport(true)
    const observer = installIntersectionObserver()
    const photos = [
      photoRecord('p1', '2026 照片', '2026-05-20'),
      photoRecord('p2', '2025 照片', '2025-08-15'),
    ]
    const state = library({ photos: ref(photos) })
    const scrollMock = vi.fn()
    window.HTMLElement.prototype.scrollIntoView = scrollMock

    const wrapper = mount(PhotoLibrary, { props: { library: state } })

    expect(wrapper.find('[data-mobile-year-nav]').exists()).toBe(false)

    observer.setIntersecting(false)
    await nextTick()

    const nav = wrapper.get('[data-mobile-year-nav]')
    expect(nav.attributes('aria-label')).toBe('年份快捷导航')

    const buttons = nav.findAll('.admin-mobile-year-nav-button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0]?.text()).toContain('2026 年')
    expect(buttons[1]?.text()).toContain('2025 年')
    expect(buttons[0]?.classes()).toContain('is-active')

    await buttons[1]?.trigger('click')
    await nextTick()

    expect(scrollMock).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
    expect(buttons[1]?.classes()).toContain('is-active')

    observer.setIntersecting(true)
    await nextTick()
    expect(wrapper.find('[data-mobile-year-nav]').exists()).toBe(false)
  })

  it('hides mobile year quick nav when mobile photo editor is open', async () => {
    useViewport(true)
    const observer = installIntersectionObserver()
    const wrapper = mount(PhotoLibrary, { props: { library: library() } })

    observer.setIntersecting(false)
    await nextTick()
    expect(wrapper.find('[data-mobile-year-nav]').exists()).toBe(true)

    await wrapper.get('[data-photo-id="photo-1"] button').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-mobile-year-nav]').exists()).toBe(false)

    await wrapper.get('[aria-label="返回照片库"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-mobile-year-nav]').exists()).toBe(true)
  })

  it('tracks active year as mobile browser scrolls through different year sections', async () => {
    useViewport(true)
    const observer = installIntersectionObserver()
    const photos = [
      photoRecord('p1', '2026 照片', '2026-05-20'),
      photoRecord('p2', '2025 照片', '2025-08-15'),
    ]
    const state = library({ photos: ref(photos) })
    const wrapper = mount(PhotoLibrary, { props: { library: state } })

    observer.setIntersecting(false)
    await nextTick()

    const buttons = wrapper.findAll('.admin-mobile-year-nav-button')
    expect(buttons[0]?.classes()).toContain('is-active')

    const sections = wrapper.findAll('[data-photo-year-section]')
    const sec0 = sections[0]?.element as HTMLElement
    const sec1 = sections[1]?.element as HTMLElement
    vi.spyOn(sec0, 'getBoundingClientRect').mockReturnValue({
      top: -300, bottom: -50, left: 0, right: 390, width: 390, height: 250, x: 0, y: -300, toJSON: () => ({}),
    })
    vi.spyOn(sec1, 'getBoundingClientRect').mockReturnValue({
      top: 60, bottom: 400, left: 0, right: 390, width: 390, height: 340, x: 0, y: 60, toJSON: () => ({}),
    })

    window.dispatchEvent(new Event('scroll'))
    await nextTick()

    const scrolledButtons = wrapper.findAll('.admin-mobile-year-nav-button')
    expect(scrolledButtons[1]?.classes()).toContain('is-active')
  })

  it('snaps active year to the last section when scrolling reaches bottom in mobile browser', async () => {
    useViewport(true)
    const observer = installIntersectionObserver()
    const photos = [
      photoRecord('p1', '2026 照片', '2026-05-20'),
      photoRecord('p2', '2025 照片', '2025-08-15'),
    ]
    const state = library({ photos: ref(photos) })
    const wrapper = mount(PhotoLibrary, { props: { library: state } })

    observer.setIntersecting(false)
    await nextTick()

    const initialButtons = wrapper.findAll('.admin-mobile-year-nav-button')
    expect(initialButtons[0]?.classes()).toContain('is-active')

    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true })
    Object.defineProperty(window, 'scrollY', { value: 1400, configurable: true })
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 2000,
      configurable: true,
    })

    window.dispatchEvent(new Event('scroll'))
    await nextTick()

    const bottomButtons = wrapper.findAll('.admin-mobile-year-nav-button')
    expect(bottomButtons[1]?.classes()).toContain('is-active')
  })

  it('supports mobile browser reduced motion mode with instant auto scrolling', async () => {
    vi.stubGlobal('matchMedia', vi.fn((query?: string) => ({
      matches: true,
      media: query ?? '(max-width: 720px)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })))
    const observer = installIntersectionObserver()
    const photos = [
      photoRecord('p1', '2026 照片', '2026-05-20'),
      photoRecord('p2', '2025 照片', '2025-08-15'),
    ]
    const state = library({ photos: ref(photos) })
    const scrollMock = vi.fn()
    window.HTMLElement.prototype.scrollIntoView = scrollMock

    const wrapper = mount(PhotoLibrary, { props: { library: state } })
    observer.setIntersecting(false)
    await nextTick()

    const buttons = wrapper.findAll('.admin-mobile-year-nav-button')
    await buttons[1]?.trigger('click')
    await nextTick()

    expect(scrollMock).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' })
  })

  it('keeps year nav visible across viewport change to desktop when scrolled down', async () => {
    let changeHandler: (event: MediaQueryListEvent) => void = () => undefined
    vi.stubGlobal('matchMedia', vi.fn((query?: string) => ({
      matches: !query?.includes('reduce'),
      media: query ?? '(max-width: 720px)',
      onchange: null,
      addEventListener: vi.fn((event: string, handler: (e: MediaQueryListEvent) => void) => {
        if (event === 'change') changeHandler = handler
      }),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })))
    const observer = installIntersectionObserver()
    const wrapper = mount(PhotoLibrary, { props: { library: library() } })

    observer.setIntersecting(false)
    await nextTick()
    expect(wrapper.find('[data-year-nav]').exists()).toBe(true)
    expect(wrapper.find('[data-mobile-floating-actions]').exists()).toBe(true)

    changeHandler({ matches: false } as MediaQueryListEvent)
    await nextTick()

    expect(wrapper.find('[data-mobile-floating-actions]').exists()).toBe(false)
    expect(wrapper.find('[data-year-nav]').exists()).toBe(true)

    observer.setIntersecting(true)
    await nextTick()
    expect(wrapper.find('[data-year-nav]').exists()).toBe(false)
  })

  it('shows year quick nav on desktop when scrolling down and navigates on click', async () => {
    useViewport(false)
    const observer = installIntersectionObserver()
    const photos = [
      photoRecord('p1', '2026 照片', '2026-05-20'),
      photoRecord('p2', '2025 照片', '2025-08-15'),
    ]
    const state = library({ photos: ref(photos) })
    const scrollMock = vi.fn()
    window.HTMLElement.prototype.scrollIntoView = scrollMock

    const wrapper = mount(PhotoLibrary, { props: { library: state } })

    expect(wrapper.find('[data-year-nav]').exists()).toBe(false)

    observer.setIntersecting(false)
    await nextTick()

    expect(wrapper.find('[data-year-nav]').exists()).toBe(true)
    expect(wrapper.find('[data-mobile-floating-actions]').exists()).toBe(false)

    const buttons = wrapper.findAll('.admin-year-nav-button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0]?.text()).toContain('2026 年')
    expect(buttons[1]?.text()).toContain('2025 年')
    expect(buttons[0]?.classes()).toContain('is-active')

    await buttons[1]?.trigger('click')
    await nextTick()

    expect(scrollMock).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
    const updatedButtons = wrapper.findAll('.admin-year-nav-button')
    expect(updatedButtons[1]?.classes()).toContain('is-active')

    observer.setIntersecting(true)
    await nextTick()
    expect(wrapper.find('[data-year-nav]').exists()).toBe(false)
  })

  it('tracks active year on desktop when scrolling through sections', async () => {
    useViewport(false)
    const observer = installIntersectionObserver()
    const photos = [
      photoRecord('p1', '2026 照片', '2026-05-20'),
      photoRecord('p2', '2025 照片', '2025-08-15'),
    ]
    const state = library({ photos: ref(photos) })
    const wrapper = mount(PhotoLibrary, { props: { library: state } })

    observer.setIntersecting(false)
    await nextTick()

    const sections = wrapper.findAll('[data-photo-year-section]')
    const sec0 = sections[0]?.element as HTMLElement
    const sec1 = sections[1]?.element as HTMLElement
    vi.spyOn(sec0, 'getBoundingClientRect').mockReturnValue({
      top: -400, bottom: -100, left: 0, right: 1200, width: 1200, height: 300, x: 0, y: -400, toJSON: () => ({}),
    })
    vi.spyOn(sec1, 'getBoundingClientRect').mockReturnValue({
      top: 50, bottom: 600, left: 0, right: 1200, width: 1200, height: 550, x: 0, y: 50, toJSON: () => ({}),
    })

    window.dispatchEvent(new Event('scroll'))
    await nextTick()

    const buttons = wrapper.findAll('.admin-year-nav-button')
    expect(buttons[1]?.classes()).toContain('is-active')
  })

  it('keeps year quick nav visible on desktop when photo editor is open', async () => {
    useViewport(false)
    const observer = installIntersectionObserver()
    const state = library()
    const wrapper = mount(PhotoLibrary, { props: { library: state } })

    observer.setIntersecting(false)
    await nextTick()
    expect(wrapper.find('[data-year-nav]').exists()).toBe(true)

    await wrapper.get('[data-photo-id="photo-1"] button').trigger('click')
    await nextTick()

    // 桌面端编辑面板展开时，年份快捷导航依然保持显示，固定在右下方红框位置
    expect(wrapper.find('.admin-photo-editor').exists()).toBe(true)
    expect(wrapper.find('[data-year-nav]').exists()).toBe(true)

    const buttons = wrapper.findAll('.admin-year-nav-button')
    expect(buttons.length).toBeGreaterThan(0)

    await wrapper.get('[aria-label="返回照片库"]').trigger('click')
    await nextTick()

    expect(wrapper.find('.admin-photo-editor').exists()).toBe(false)
    expect(wrapper.find('[data-year-nav]').exists()).toBe(true)
  })

  it('labels missing date photos as undated in mobile browser year nav', async () => {
    useViewport(true)
    const observer = installIntersectionObserver()
    const photos = [
      photoRecord('p1', '日期待补充照片', null),
    ]
    const state = library({ photos: ref(photos) })
    const wrapper = mount(PhotoLibrary, { props: { library: state } })

    observer.setIntersecting(false)
    await nextTick()

    const nav = wrapper.get('[data-mobile-year-nav]')
    const button = nav.get('.admin-mobile-year-nav-button')
    expect(button.text()).toContain('待补充')
    expect(button.attributes('aria-label')).toBe('跳转到 待补充日期')
  })

  it('uses the same refresh action for the floating and original controls', async () => {
    useViewport(true)
    const observer = installIntersectionObserver()
    const state = library()
    const wrapper = mount(PhotoLibrary, { props: { library: state } })

    await wrapper.get('[data-refresh]').trigger('click')
    observer.setIntersecting(false)
    await nextTick()
    await wrapper.get('[data-mobile-floating-actions] [data-refresh]').trigger('click')
    await flushPromises()

    expect(state.refresh).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('refresh-success')).toEqual([[1], [1]])
  })

  it('ignores a second refresh click while the first control is refreshing', async () => {
    useViewport(true)
    const observer = installIntersectionObserver()
    const pending = deferred<boolean>()
    const isRefreshing = ref(false)
    const state = library({ isRefreshing })
    vi.mocked(state.refresh).mockImplementationOnce(() => {
      isRefreshing.value = true
      return pending.promise
    })
    const wrapper = mount(PhotoLibrary, { props: { library: state } })
    observer.setIntersecting(false)
    await nextTick()

    await wrapper.get('.admin-library-actions [data-refresh]').trigger('click')
    await wrapper.get('[data-mobile-floating-actions] [data-refresh]').trigger('click')

    expect(state.refresh).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('refresh-success')).toBeUndefined()

    isRefreshing.value = false
    pending.resolve(true)
    await flushPromises()

    expect(wrapper.emitted('refresh-success')).toEqual([[1]])
  })

  it('emits the merged photo count after a user refresh is accepted', async () => {
    const state = library()
    vi.mocked(state.refresh).mockImplementationOnce(async () => {
      state.photos.value = [photo, secondPhoto]
      return true
    })
    const wrapper = mount(PhotoLibrary, { props: { library: state } })

    expect(wrapper.emitted('refresh-success')).toBeUndefined()
    await wrapper.get('[data-refresh]').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('refresh-success')).toEqual([[2]])
  })

  it('does not emit for an accepted refresh from a replaced library', async () => {
    const pending = deferred<boolean>()
    const requestedLibrary = library({ refresh: vi.fn(() => pending.promise) })
    const replacementLibrary = library({ photos: ref([photo, secondPhoto]) })
    const activeLibrary = shallowRef(requestedLibrary)
    const wrapper = mount({
      setup: () => () => h(PhotoLibrary, { library: activeLibrary.value }),
    })
    const photoLibrary = wrapper.getComponent(PhotoLibrary)

    await photoLibrary.get('[data-refresh]').trigger('click')
    activeLibrary.value = replacementLibrary
    await nextTick()
    expect(photoLibrary.props('library')).toBe(replacementLibrary)
    expect(photoLibrary.emitted('refresh-success')).toBeUndefined()
    pending.resolve(true)
    await flushPromises()

    expect(photoLibrary.emitted('refresh-success')).toBeUndefined()
  })

  it('does not emit refresh success when the requested refresh is not accepted', async () => {
    const state = library({ refresh: vi.fn(async () => false) })
    const wrapper = mount(PhotoLibrary, { props: { library: state } })

    await flushPromises()
    expect(wrapper.emitted('refresh-success')).toBeUndefined()

    await wrapper.get('[data-refresh]').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('refresh-success')).toBeUndefined()
  })

  it('hides the floating actions while the mobile photo editor is open', async () => {
    useViewport(true)
    const observer = installIntersectionObserver()
    const wrapper = mount(PhotoLibrary, { props: { library: library() } })

    observer.setIntersecting(false)
    await nextTick()
    expect(wrapper.find('[data-mobile-floating-actions]').exists()).toBe(true)

    await wrapper.get('[data-photo-id="photo-1"] button').trigger('click')
    await nextTick()
    expect(wrapper.get('.admin-photo-editor')).toBeDefined()
    expect(wrapper.find('[data-mobile-floating-actions]').exists()).toBe(false)

    await wrapper.get('[aria-label="返回照片库"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-mobile-floating-actions]').exists()).toBe(true)
  })

  it('keeps the photo grid mounted while an in-place refresh is running', () => {
    const state = library({ status: ref('loading'), isRefreshing: ref(true) })
    const wrapper = mount(PhotoLibrary, { props: { library: state } })

    expect(wrapper.find('.admin-library-layout').exists()).toBe(true)
    expect(wrapper.find('.admin-photo-card').exists()).toBe(true)
    expect(wrapper.find('.baby-loading-container').exists()).toBe(false)
  })

  it('decorates the main upload button with six hidden sparkle stars', () => {
    const wrapper = mount(PhotoLibrary, { props: { library: library() } })
    const upload = wrapper.get('.admin-library-actions [data-upload]')
    const stars = upload.findAll('[data-sparkle-star]')

    expect(upload.classes()).toContain('admin-sparkle-button')
    expect(upload.text()).toBe('上传照片')
    expect(stars).toHaveLength(6)
    stars.forEach((star, index) => {
      expect(star.classes()).toContain(`admin-sparkle-star-${index + 1}`)
      expect(star.attributes('aria-hidden')).toBe('true')
    })
  })

  it('decorates the main refresh button with layered content wrapper and refresh icon', () => {
    const wrapper = mount(PhotoLibrary, { props: { library: library() } })
    const refresh = wrapper.get('.admin-library-actions [data-refresh]')
    const icon = refresh.get('.admin-refresh-icon')

    expect(refresh.classes()).toContain('admin-refresh-button')
    expect(refresh.text()).toBe('刷新')
    expect(refresh.find('.admin-refresh-content').exists()).toBe(true)
    expect(icon.attributes('aria-hidden')).toBe('true')
  })

  it('opens a bounded photo picker and passes selected File objects to the real queue', async () => {
    const state = uploadQueue()
    const wrapper = mount(PhotoLibrary, { props: { library: library(), uploadQueue: state } })
    const input = wrapper.get('input[type="file"]')
    const selected = [new File(['one'], 'one.jpg'), new File(['two'], 'two.heic')]
    Object.defineProperty(input.element, 'files', { configurable: true, value: selected })

    await wrapper.get('[data-upload]').trigger('click')
    await input.trigger('change')

    expect(input.attributes('multiple')).toBeDefined()
    expect(input.attributes('accept')).toContain('.heic')
    expect(input.attributes('tabindex')).toBe('-1')
    expect(state.add).toHaveBeenCalledWith(selected)
  })

  it('announces an over-limit selection without losing the existing library', async () => {
    const state = uploadQueue()
    vi.mocked(state.add).mockImplementation(() => {
      throw new Error('一次最多选择 10 张照片')
    })
    const wrapper = mount(PhotoLibrary, { props: { library: library(), uploadQueue: state } })
    const input = wrapper.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: Array.from({ length: 11 }, (_, index) => new File(['x'], `${index}.jpg`)),
    })

    await input.trigger('change')

    expect(wrapper.get('[role="alert"]').text()).toBe('一次最多选择 10 张照片')
    expect(wrapper.find('[data-photo-id="photo-1"]').exists()).toBe(true)
  })

  it('renders a square photo grid and a semantic editor region with stable source dimensions', async () => {
    const state = library()
    const wrapper = mount(PhotoLibrary, { props: { library: state } })

    const card = wrapper.get('[data-photo-id="photo-1"]')
    expect(card.classes()).toContain('admin-photo-card')
    expect(card.get('img').attributes()).toMatchObject({ width: '320', height: '240' })
    await card.get('button').trigger('click')
    expect(state.select).toHaveBeenCalledWith('photo-1')
    expect(wrapper.get('.admin-library-layout').attributes('data-mobile-editor')).toBe('fullscreen')
    expect(wrapper.get('.admin-photo-grid').attributes('data-mobile-columns')).toBe('2')
  })

  it('segments adjacent years without reordering photos and labels missing dates', async () => {
    const photos = [
      photoRecord('a', '春日', '2026-05-01'),
      photoRecord('b', '夏日', '2026-06-02'),
      photoRecord('c', '去年', '2025-12-31'),
      photoRecord('d', '再次出现的今年', '2026-01-01'),
      photoRecord('e', '日期待补', null),
    ]
    const wrapper = mount(PhotoLibrary, {
      props: { library: library({ photos: ref(photos) }) },
    })

    const sections = wrapper.findAll('[data-photo-year-section]')
    expect(sections.map((section) => section.get('h3').text())).toEqual([
      '2026 年 · 成长片段',
      '2025 年 · 成长片段',
      '2026 年 · 成长片段',
      '待补充日期',
    ])
    expect(sections.map((section) => (
      section.findAll('[data-photo-id]').map((card) => card.attributes('data-photo-id'))
    ))).toEqual([['a', 'b'], ['c'], ['d'], ['e']])
    expect(wrapper.get('[data-photo-id="a"] [data-captured-date]').text()).toBe('2026.05.01')
    expect(wrapper.get('[data-photo-id="e"] [data-captured-date]').text()).toBe('日期待补充')

    await wrapper.get('[data-photo-id="a"] button').trigger('click')
    expect(wrapper.get('[data-photo-id="a"] .admin-photo-selected').find('svg').exists()).toBe(true)
  })

  it('passes the selected photo save tone to the editor message', () => {
    const state = library({
      selectedId: ref('photo-1'),
      messageFor: vi.fn(() => '保存成功'),
      messageToneFor: vi.fn((): 'success' => 'success'),
    })
    const wrapper = mount(PhotoLibrary, { props: { library: state } })

    const message = wrapper.get('.admin-form-message')
    expect(message.text()).toBe('保存成功')
    expect(message.classes()).toContain('is-success')
  })

  it('shows migration preparation, disables upload, and keeps refresh available', async () => {
    const state = library({
      isMigrationPending: computed(() => true),
      uploadsDisabled: computed(() => true),
    })
    const wrapper = mount(PhotoLibrary, { props: { library: state } })

    expect(wrapper.get('[role="status"]').text()).toContain('正在准备旧照片，暂未开放上传')
    expect(wrapper.get('[data-upload]').attributes()).toHaveProperty('disabled')
    await wrapper.get('[data-refresh]').trigger('click')
    expect(state.refresh).toHaveBeenCalledTimes(1)
  })

  it('keeps the real editor node and its draft mounted when reauthentication opens', async () => {
    const status = ref<AdminSessionState['status']['value']>('authenticated')
    const session: AdminSessionState = {
      status,
      username: ref('alice'),
      csrfToken: ref('csrf-token'),
      initialize: vi.fn(async () => undefined),
      login: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
    }
    const api: AdminPhotoApiClient = {
      listPhotos: vi.fn(async () => [photo]),
      updatePhoto: vi.fn(),
      deletePhoto: vi.fn(),
    }
    const wrapper = mount(AdminApp, { props: { session, photoApi: api } })
    await flushPromises()
    await wrapper.get('[data-photo-id="photo-1"] button').trigger('click')
    const title = wrapper.get('input[name="title"]')
    await title.setValue('未提交标题')

    status.value = 'reauth-required'
    await nextTick()

    expect(wrapper.get('input[name="title"]').element).toBe(title.element)
    expect((title.element as HTMLInputElement).value).toBe('未提交标题')
    expect(wrapper.get('[role="dialog"]').text()).toContain('登录已过期')
  })

  it('keeps the draft and upload request ids across an explicit post-login resume', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation((file) => `blob:${(file as File).name}`)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const status = ref<AdminSessionState['status']['value']>('authenticated')
    const csrfToken = ref<string | null>('old-csrf')
    const session: AdminSessionState = {
      status,
      username: ref('alice'),
      csrfToken,
      initialize: vi.fn(async () => undefined),
      login: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
    }
    const photoApi: AdminPhotoApiClient = {
      listPhotos: vi.fn(async () => [photo]), updatePhoto: vi.fn(), deletePhoto: vi.fn(),
    }
    const uploadResults: Array<ReturnType<typeof deferred<AdminPhoto>>> = []
    const uploadApi: AdminUploadApiClient = {
      uploadPhoto: vi.fn((_file, _requestId, _token, reportProgress) => {
        reportProgress(50)
        const result = deferred<AdminPhoto>()
        uploadResults.push(result)
        return result.promise
      }),
    }
    const wrapper = mount(AdminApp, {
      props: { session, photoApi, uploadApi },
    })
    await flushPromises()
    await wrapper.get('[data-photo-id="photo-1"] button').trigger('click')
    const draftTitle = wrapper.get('input[name="title"]')
    await draftTitle.setValue('上传期间保留的草稿')
    const input = wrapper.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [
        new File(['one'], 'one.jpg'),
        new File(['two'], 'two.jpg'),
        new File(['three'], 'three.jpg'),
      ],
    })
    await input.trigger('change')
    await flushPromises()
    const firstRequestId = vi.mocked(uploadApi.uploadPhoto).mock.calls[0]?.[1]

    status.value = 'reauth-required'
    csrfToken.value = null
    uploadResults[0]?.reject(new AdminApiError('unauthorized', 'expired'))
    uploadResults[1]?.resolve(secondPhoto)
    await flushPromises()

    expect(wrapper.get('input[name="title"]').element).toBe(draftTitle.element)
    expect((draftTitle.element as HTMLInputElement).value).toBe('上传期间保留的草稿')
    expect(wrapper.find('[data-photo-id="photo-2"]').exists()).toBe(true)
    expect(uploadApi.uploadPhoto).toHaveBeenCalledTimes(2)

    csrfToken.value = 'fresh-csrf'
    status.value = 'authenticated'
    await nextTick()
    await flushPromises()
    expect(uploadApi.uploadPhoto).toHaveBeenCalledTimes(2)

    await wrapper.get('[data-continue-upload]').trigger('click')
    await flushPromises()
    expect(uploadApi.uploadPhoto).toHaveBeenCalledTimes(4)
    expect(vi.mocked(uploadApi.uploadPhoto).mock.calls[2]).toMatchObject([
      expect.any(File), firstRequestId, 'fresh-csrf', expect.any(Function), expect.any(AbortSignal),
    ])
    wrapper.unmount()
  })

  it('isolates the grid, focuses the fullscreen editor on mobile, and restores its card on close', async () => {
    useViewport(true)
    const state = library()
    const wrapper = mount(PhotoLibrary, { attachTo: document.body, props: { library: state } })
    const card = wrapper.get('[data-photo-id="photo-1"] button')
    ;(card.element as HTMLButtonElement).focus()

    await card.trigger('click')
    await nextTick()

    const editor = wrapper.get('.admin-photo-editor')
    expect(editor.attributes()).toMatchObject({
      role: 'dialog',
      'aria-modal': 'true',
      tabindex: '-1',
    })
    expect(document.activeElement).toBe(editor.element)
    expect(wrapper.get('.admin-photo-grid').attributes()).toMatchObject({
      inert: '',
      'aria-hidden': 'true',
    })

    await editor.get('[aria-label="返回照片库"]').trigger('click')
    await nextTick()

    expect(wrapper.find('.admin-photo-editor').exists()).toBe(false)
    expect(document.activeElement).toBe(card.element)
    expect(wrapper.get('.admin-photo-grid').attributes()).not.toHaveProperty('inert')
    wrapper.unmount()
  })

  it('keeps the editor non-modal and the grid interactive on desktop', async () => {
    useViewport(false)
    const state = library()
    const wrapper = mount(PhotoLibrary, { props: { library: state } })

    await wrapper.get('[data-photo-id="photo-1"] button').trigger('click')
    await nextTick()

    expect(wrapper.get('.admin-photo-editor').attributes()).not.toHaveProperty('aria-modal')
    expect(wrapper.get('.admin-photo-editor').attributes()).not.toHaveProperty('role')
    expect(wrapper.get('.admin-photo-grid').attributes()).not.toHaveProperty('inert')
  })

  it.each([
    { mobile: false, restoredRole: undefined },
    { mobile: true, restoredRole: 'dialog' },
  ])('keeps the delete confirmation as the sole modal and restores the editor on $mobile viewport', async ({
    mobile,
    restoredRole,
  }) => {
    useViewport(mobile)
    const state = library({ remove: vi.fn(async () => false) })
    const wrapper = mount(PhotoLibrary, {
      attachTo: document.body,
      props: { library: state, uploadQueue: uploadQueue() },
    })
    await wrapper.get('[data-photo-id="photo-1"] button').trigger('click')
    await nextTick()
    const deleteTrigger = wrapper.get('[data-open-delete]')
    ;(deleteTrigger.element as HTMLButtonElement).focus()

    await deleteTrigger.trigger('click')
    await nextTick()

    expect(wrapper.findAll('[role="dialog"]')).toHaveLength(1)
    expect(wrapper.get('[role="dialog"]').classes()).toContain('admin-delete-dialog')
    expect(wrapper.get('.admin-photo-library-content').attributes()).toMatchObject({
      inert: '',
      'aria-hidden': 'true',
    })
    expect(wrapper.get('.admin-photo-editor').attributes()).toMatchObject({
      inert: '',
      'aria-hidden': 'true',
    })
    expect(wrapper.get('.admin-photo-editor').attributes()).not.toHaveProperty('role')
    expect(wrapper.get('.admin-photo-editor').attributes()).not.toHaveProperty('aria-modal')

    await wrapper.get('[data-confirm-delete]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.admin-delete-dialog').exists()).toBe(true)
    expect(wrapper.get('.admin-photo-library-content').attributes()).toHaveProperty('inert')
    await wrapper.findAll('.admin-dialog-actions button')[0]!.trigger('click')
    await nextTick()

    expect(wrapper.find('.admin-delete-dialog').exists()).toBe(false)
    expect(wrapper.get('.admin-photo-library-content').attributes()).not.toHaveProperty('inert')
    expect(wrapper.get('.admin-photo-editor').attributes('role')).toBe(restoredRole)
    expect(document.activeElement).toBe(deleteTrigger.element)
    wrapper.unmount()
  })

  it('traps mobile Tab navigation and isolates all library controls behind the editor', async () => {
    useViewport(true)
    const state = uploadQueue()
    state.items.value = [{
      id: 'upload-1', requestId: '0195c681-9c63-7db0-8000-000000000001',
      file: new File(['one'], 'one.jpg'), previewUrl: 'blob:one',
      status: 'failed', progress: 0, errorCode: 'upload-unavailable', photo: null,
      hasUnrecognizedExtension: false,
    }]
    const wrapper = mount(PhotoLibrary, {
      attachTo: document.body,
      props: { library: library(), uploadQueue: state },
    })
    await wrapper.get('[data-photo-id="photo-1"] button').trigger('click')
    await nextTick()
    const editor = wrapper.get('.admin-photo-editor')
    const focusable = editor.findAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')
    const first = focusable[0]!
    const last = focusable.at(-1)!

    expect(document.activeElement).toBe(editor.element)
    await editor.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last.element)
    ;(last.element as HTMLElement).focus()
    await last.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(first.element)
    ;(first.element as HTMLElement).focus()
    await first.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last.element)
    expect(wrapper.get('.admin-library-actions').attributes()).toMatchObject({
      inert: '',
      'aria-hidden': 'true',
    })
    expect(wrapper.get('.admin-upload-queue').attributes()).toMatchObject({
      inert: '',
      'aria-hidden': 'true',
    })
    wrapper.unmount()
  })

  it('isolates the administrator toolbar while the mobile editor is modal', async () => {
    useViewport(true)
    const status = ref<AdminSessionState['status']['value']>('authenticated')
    const session: AdminSessionState = {
      status,
      username: ref('alice'),
      csrfToken: ref('csrf-token'),
      initialize: vi.fn(async () => undefined),
      login: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
    }
    const api: AdminPhotoApiClient = {
      listPhotos: vi.fn(async () => [photo]),
      updatePhoto: vi.fn(),
      deletePhoto: vi.fn(),
    }
    const wrapper = mount(AdminApp, { attachTo: document.body, props: { session, photoApi: api } })
    await flushPromises()

    await wrapper.get('[data-photo-id="photo-1"] button').trigger('click')
    await nextTick()

    expect(wrapper.get('.admin-toolbar').attributes()).toMatchObject({
      inert: '',
      'aria-hidden': 'true',
    })
    expect(wrapper.get('#photo-library-title').attributes()).toMatchObject({
      inert: '',
      'aria-hidden': 'true',
    })
    wrapper.unmount()
  })

  it('isolates the administrator chrome while the desktop delete dialog is modal', async () => {
    useViewport(false)
    const status = ref<AdminSessionState['status']['value']>('authenticated')
    const session: AdminSessionState = {
      status,
      username: ref('alice'),
      csrfToken: ref('csrf-token'),
      initialize: vi.fn(async () => undefined),
      login: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
    }
    const api: AdminPhotoApiClient = {
      listPhotos: vi.fn(async () => [photo]),
      updatePhoto: vi.fn(),
      deletePhoto: vi.fn(),
    }
    const wrapper = mount(AdminApp, { attachTo: document.body, props: { session, photoApi: api } })
    await flushPromises()
    await wrapper.get('[data-photo-id="photo-1"] button').trigger('click')
    await nextTick()
    const deleteTrigger = wrapper.get('[data-open-delete]')
    ;(deleteTrigger.element as HTMLButtonElement).focus()
    await deleteTrigger.trigger('click')
    await nextTick()

    expect(wrapper.get('.admin-toolbar').attributes()).toMatchObject({
      inert: '',
      'aria-hidden': 'true',
    })
    expect(wrapper.get('#photo-library-title').attributes()).toMatchObject({
      inert: '',
      'aria-hidden': 'true',
    })
    expect(wrapper.findAll('[role="dialog"]')).toHaveLength(1)
    wrapper.unmount()
  })

  it('lets reauthentication temporarily supersede a delete dialog without retrying deletion', async () => {
    useViewport(false)
    const status = ref<AdminSessionState['status']['value']>('authenticated')
    const session: AdminSessionState = {
      status,
      username: ref('alice'),
      csrfToken: ref('csrf-token'),
      initialize: vi.fn(async () => undefined),
      login: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
    }
    const deletePhoto = vi.fn(async () => {
      status.value = 'reauth-required'
      throw new AdminApiError('unauthorized', 'private session detail')
    })
    const api: AdminPhotoApiClient = {
      listPhotos: vi.fn(async () => [photo]),
      updatePhoto: vi.fn(),
      deletePhoto,
    }
    const wrapper = mount(AdminApp, { attachTo: document.body, props: { session, photoApi: api } })
    await flushPromises()
    await wrapper.get('[data-photo-id="photo-1"] button').trigger('click')
    await nextTick()
    const deleteTrigger = wrapper.get('[data-open-delete]')
    ;(deleteTrigger.element as HTMLButtonElement).focus()
    await deleteTrigger.trigger('click')
    await nextTick()
    await wrapper.get('[data-confirm-delete]').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('[role="dialog"]')).toHaveLength(1)
    expect(wrapper.get('[role="dialog"]').text()).toContain('登录已过期')
    expect(wrapper.find('.admin-delete-dialog').exists()).toBe(false)
    expect(deletePhoto).toHaveBeenCalledTimes(1)

    status.value = 'authenticated'
    await nextTick()
    await flushPromises()

    expect(wrapper.findAll('[role="dialog"]')).toHaveLength(1)
    expect(wrapper.get('[role="dialog"]').classes()).toContain('admin-delete-dialog')
    expect(deletePhoto).toHaveBeenCalledTimes(1)
    await wrapper.findAll('.admin-dialog-actions button')[0]!.trigger('click')
    await nextTick()
    expect(document.activeElement).toBe(deleteTrigger.element)
    wrapper.unmount()
  })

  it('focuses the next card after deleting the selected photo', async () => {
    useViewport(false)
    const wrapper = mount(PhotoLibrary, {
      attachTo: document.body,
      props: { library: deletableLibrary([photo, secondPhoto]) },
    })

    await deleteSelectedPhoto(wrapper, 'photo-1')

    expect(document.activeElement).toBe(wrapper.get('[data-photo-id="photo-2"] button').element)
    wrapper.unmount()
  })

  it('focuses the previous card when deleting the final card in the row', async () => {
    useViewport(false)
    const wrapper = mount(PhotoLibrary, {
      attachTo: document.body,
      props: { library: deletableLibrary([photo, secondPhoto]) },
    })

    await deleteSelectedPhoto(wrapper, 'photo-2')

    expect(document.activeElement).toBe(wrapper.get('[data-photo-id="photo-1"] button').element)
    wrapper.unmount()
  })

  it('focuses the library heading after deleting the only photo', async () => {
    useViewport(false)
    const heading = document.createElement('h2')
    heading.id = 'photo-library-title'
    heading.tabIndex = -1
    heading.textContent = '照片库'
    document.body.append(heading)
    const wrapper = mount(PhotoLibrary, {
      attachTo: document.body,
      props: { library: deletableLibrary([photo]) },
    })

    await deleteSelectedPhoto(wrapper, 'photo-1')

    expect(document.activeElement).toBe(heading)
    wrapper.unmount()
    heading.remove()
  })

})
