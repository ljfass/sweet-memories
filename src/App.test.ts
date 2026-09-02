import { mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memories } from './data/memories'
import type { Memory } from './types/album'
import App from './App.vue'
import componentSource from './App.vue?raw'

interface PublicAlbumMock {
  memories: Ref<readonly Memory[]>
  retry: ReturnType<typeof vi.fn<() => Promise<void>>>
  status: Ref<'loading' | 'ready' | 'error'>
}

const publicAlbum = vi.hoisted(() => ({
  current: undefined as PublicAlbumMock | undefined,
}))

vi.mock('./composables/usePublicMemories', async () => {
  const { ref } = await import('vue')
  const state: PublicAlbumMock = {
    memories: ref([]),
    retry: vi.fn<() => Promise<void>>(),
    status: ref('ready'),
  }
  publicAlbum.current = state
  return { usePublicMemories: () => state }
})

function albumState(): PublicAlbumMock {
  if (!publicAlbum.current) {
    throw new Error('public album mock is not initialized')
  }
  return publicAlbum.current
}

describe('App', () => {
  beforeEach(() => {
    const album = albumState()
    album.memories.value = memories
    album.status.value = 'ready'
    album.retry.mockResolvedValue()
  })

  it('composes the complete baby album experience', () => {
    const wrapper = mount(App)

    expect(wrapper.get('main').attributes('aria-label')).toBe('宝贝成长相册')
    expect(wrapper.get('h1').text()).toBe('宝贝的快乐时光')
    expect(wrapper.find('.age-counter').exists()).toBe(true)
    expect(wrapper.find('.video-section').exists()).toBe(true)
    expect(wrapper.findAll('.polaroid')).toHaveLength(5)
    expect(wrapper.findAll('.caption').map((caption) => caption.text())).toEqual([
      '刚出生的时候 🍼',
      '第一次笑得这么开心 😄',
      '满月啦 🎈',
      '睡觉的样子最乖 💤',
      '带去公园玩 🌳',
    ])
    expect(wrapper.find('[data-testid="sleep-toggle"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="music-toggle"]').exists()).toBe(true)
    expect(wrapper.find('.ambient-effects').exists()).toBe(true)
    expect(wrapper.get('.public-album').attributes('aria-busy')).toBe('false')
  })

  it('reserves a stable photo wall while API photos are loading', () => {
    const album = albumState()
    album.memories.value = []
    album.status.value = 'loading'

    const wrapper = mount(App)

    expect(wrapper.get('.public-album').classes()).toContain('is-loading')
    expect(wrapper.get('.public-album').attributes('aria-busy')).toBe('true')
    expect(componentSource).toMatch(/\.public-album\.is-loading\s*\{[^}]*min-height:\s*780px/s)
    expect(componentSource).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*\.public-album\.is-loading\s*\{[^}]*min-height:\s*1960px/)
    expect(wrapper.get('[role="status"]').text()).toBe('照片正在加载')
    expect(wrapper.find('.video-section').exists()).toBe(true)
    expect(wrapper.find('audio').exists()).toBe(true)
  })

  it('keeps a ready empty album compact and shows a short empty state', () => {
    const album = albumState()
    album.memories.value = []
    album.status.value = 'ready'

    const wrapper = mount(App)

    expect(wrapper.get('.public-album').classes()).toContain('is-ready')
    expect(wrapper.get('.album-empty-state').text()).toBe('还没有照片')
    expect(componentSource).not.toMatch(/\.public-album\.is-ready\s*\{[^}]*min-height/s)
    expect(componentSource).not.toMatch(/\.public-album\s*\{[^}]*min-height/s)
  })

  it('lets a ready single photo determine the album height naturally', () => {
    const album = albumState()
    album.memories.value = [memories[0]!]
    album.status.value = 'ready'

    const wrapper = mount(App)

    expect(wrapper.findAll('.polaroid')).toHaveLength(1)
    expect(wrapper.find('.album-empty-state').exists()).toBe(false)
    expect(wrapper.get('.public-album').classes()).toContain('is-ready')
  })

  it('keeps other media usable and exposes an accessible retry after an API failure', async () => {
    const album = albumState()
    album.memories.value = []
    album.status.value = 'error'

    const wrapper = mount(App)
    const retry = wrapper.get('button.album-retry')

    expect(wrapper.get('[role="status"] > span').text()).toBe('照片暂时无法加载')
    expect(retry.attributes('type')).toBe('button')
    expect(retry.text()).toBe('重试')
    expect(componentSource).toMatch(/\.public-album\.is-error\s*\{[^}]*min-height:\s*180px/s)
    expect(componentSource).not.toMatch(/\.public-album\.is-error\s*\{[^}]*min-height:\s*1960px/s)
    expect(wrapper.find('.video-section').exists()).toBe(true)
    expect(wrapper.find('[data-testid="music-toggle"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="sleep-toggle"]').exists()).toBe(true)

    await retry.trigger('click')
    expect(album.retry).toHaveBeenCalledTimes(1)
  })

  it('applies sleep mode from the floating control', async () => {
    const wrapper = mount(App)

    expect(wrapper.get('.album-app').classes()).not.toContain('is-sleeping')

    await wrapper.get('[data-testid="sleep-toggle"]').trigger('click')

    expect(wrapper.get('.album-app').classes()).toContain('is-sleeping')
    expect(wrapper.get('.sleep-title').text()).toBe('嘘，宝宝睡着了... 💤')
  })
})
