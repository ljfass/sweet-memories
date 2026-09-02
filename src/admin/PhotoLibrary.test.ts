import { flushPromises, mount } from '@vue/test-utils'
import { computed, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AdminApp from './AdminApp.vue'
import type {
  AdminPhoto,
  AdminPhotoApiClient,
  AdminSessionState,
  PhotoDraft,
  PhotoLibraryState,
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
function library(overrides: Partial<PhotoLibraryState> = {}): PhotoLibraryState {
  const draft: PhotoDraft = { title: photo.title, description: '', capturedDate: '2026-05-01' }
  const selectedId = ref<string | null>(null)
  return {
    photos: ref([photo]), status: ref('ready'), selectedId,
    isMigrationPending: computed(() => false), uploadsDisabled: computed(() => false),
    load: vi.fn(async () => undefined), refresh: vi.fn(async () => undefined),
    select: vi.fn((id) => { selectedId.value = id }), draftFor: vi.fn(() => draft), updateDraft: vi.fn(),
    isDirty: vi.fn(() => false), hasConflict: vi.fn(() => false),
    isSaving: vi.fn(() => false), messageFor: vi.fn(() => ''),
    save: vi.fn(async () => undefined), loadLatest: vi.fn(async () => undefined),
    remove: vi.fn(async () => true),
    ...overrides,
  }
}

function useViewport(matches: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches,
    media: '(max-width: 720px)',
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
})

describe('PhotoLibrary', () => {
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

  it('traps mobile Tab navigation and isolates the library controls behind the editor', async () => {
    useViewport(true)
    const wrapper = mount(PhotoLibrary, {
      attachTo: document.body,
      props: { library: library() },
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
