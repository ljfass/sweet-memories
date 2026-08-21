import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Memory } from '../types/album'
import PhotoGallery from './PhotoGallery.vue'

const gsapMocks = vi.hoisted(() => {
  const timeline = {
    to: vi.fn(),
    set: vi.fn(),
    kill: vi.fn(),
  }
  timeline.to.mockReturnValue(timeline)
  timeline.set.mockReturnValue(timeline)

  return {
    timeline,
    set: vi.fn(),
    revert: vi.fn(),
  }
})

vi.mock('gsap', () => ({
  gsap: {
    context: vi.fn((callback: () => void) => {
      callback()
      return {
        add: (scopedCallback: () => void) => scopedCallback(),
        revert: gsapMocks.revert,
      }
    }),
    timeline: vi.fn(() => gsapMocks.timeline),
    set: gsapMocks.set,
  },
}))

const sourceSet = {
  avif: '/photo.avif 320w',
  webp: '/photo.webp 320w',
  jpeg: '/photo.jpg 320w',
  fallback: '/photo.jpg',
}

const memories: Memory[] = [
  {
    id: 'first',
    caption: '第一张照片',
    alt: '第一张宝宝照片',
    sources: sourceSet,
    transform: { rotation: -2, x: 0, y: 0 },
  },
  {
    id: 'second',
    caption: '第二张照片',
    alt: '第二张宝宝照片',
    sources: sourceSet,
    transform: { rotation: 2, x: 5, y: 5 },
  },
]

function createMediaQuery(matches: boolean): MediaQueryList {
  return {
    matches,
    media: '',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }
}

let reduceMotion = false

describe('PhotoGallery', () => {
  beforeEach(() => {
    reduceMotion = false
    vi.stubGlobal('matchMedia', vi.fn((query: string) =>
      createMediaQuery(query.includes('prefers-reduced-motion') && reduceMotion),
    ))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders memories in their configured order', () => {
    const wrapper = mount(PhotoGallery, { props: { memories } })

    expect(wrapper.get('section').attributes('aria-label')).toBe('成长照片墙')
    expect(wrapper.findAll('article')).toHaveLength(2)
    expect(wrapper.findAll('.caption').map((caption) => caption.text())).toEqual([
      '第一张照片',
      '第二张照片',
    ])
  })

  it('selects, switches, and toggles a photo closed', async () => {
    const wrapper = mount(PhotoGallery, { props: { memories } })
    const triggers = wrapper.findAll('.polaroid-trigger')

    await triggers[0]!.trigger('click')
    await nextTick()
    expect(wrapper.get('.gallery').classes()).toContain('has-selection')
    expect(triggers[0]!.attributes('aria-expanded')).toBe('true')

    await triggers[1]!.trigger('click')
    await nextTick()
    expect(triggers[0]!.attributes('aria-expanded')).toBe('false')
    expect(triggers[1]!.attributes('aria-expanded')).toBe('true')
    expect(gsapMocks.timeline.kill).toHaveBeenCalled()

    await triggers[1]!.trigger('click')
    expect(wrapper.get('.gallery').classes()).not.toContain('has-selection')
    expect(triggers[1]!.attributes('aria-expanded')).toBe('false')
  })

  it('closes from gallery whitespace', async () => {
    const wrapper = mount(PhotoGallery, { props: { memories } })

    await wrapper.findAll('.polaroid-trigger')[0]!.trigger('click')
    await nextTick()
    expect(wrapper.get('.gallery').classes()).toContain('has-selection')

    await wrapper.get('.gallery').trigger('click')

    expect(wrapper.get('.gallery').classes()).not.toContain('has-selection')
  })

  it('closes with Escape and restores focus to the selected trigger', async () => {
    const wrapper = mount(PhotoGallery, {
      props: { memories },
      attachTo: document.body,
    })
    const trigger = wrapper.findAll<HTMLButtonElement>('.polaroid-trigger')[0]!

    await trigger.trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()

    expect(wrapper.get('.gallery').classes()).not.toContain('has-selection')
    expect(document.activeElement).toBe(trigger.element)
  })

  it('uses an immediate restrained state for reduced motion', async () => {
    reduceMotion = true
    const wrapper = mount(PhotoGallery, { props: { memories } })

    await wrapper.findAll('.polaroid-trigger')[0]!.trigger('click')
    await nextTick()

    expect(gsapMocks.set).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        x: 0,
        y: 0,
        rotation: 0,
      }),
    )
    expect(gsapMocks.set.mock.calls.some(([, values]) =>
      values.scale === 1.04,
    )).toBe(true)
    expect(gsapMocks.timeline.to).not.toHaveBeenCalled()
  })

  it('resets on resize and cleans GSAP state on unmount', async () => {
    const wrapper = mount(PhotoGallery, { props: { memories } })

    await wrapper.findAll('.polaroid-trigger')[0]!.trigger('click')
    await nextTick()
    window.dispatchEvent(new Event('resize'))
    await nextTick()

    expect(wrapper.get('.gallery').classes()).not.toContain('has-selection')
    await wrapper.findAll('.polaroid-trigger')[0]!.trigger('click')
    await nextTick()
    wrapper.unmount()
    expect(gsapMocks.timeline.kill).toHaveBeenCalled()
    expect(gsapMocks.revert).toHaveBeenCalledOnce()
  })
})
