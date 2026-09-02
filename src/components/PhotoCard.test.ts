import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { Memory } from '../types/album'
import PhotoCard from './PhotoCard.vue'

const memory: Memory = {
  id: 'newborn',
  caption: '刚出生的时候 🍼',
  alt: '刚出生时安静躺着的宝宝',
  sources: {
    avif: '/photo-1-320.avif 320w, /photo-1-640.avif 640w, /photo-1-960.avif 960w',
    webp: '/photo-1-320.webp 320w, /photo-1-640.webp 640w, /photo-1-960.webp 960w',
    jpeg: '/photo-1-320.jpg 320w, /photo-1-640.jpg 640w, /photo-1-960.jpg 960w',
    fallback: '/photo-1-640.jpg',
    width: 640,
    height: 480,
  },
  transform: { rotation: -5, x: 0, y: 10 },
}

describe('PhotoCard', () => {
  it('renders responsive sources and stable image dimensions', () => {
    const wrapper = mount(PhotoCard, { props: { memory } })
    const sources = wrapper.findAll('source')
    const image = wrapper.get('img')

    expect(sources.map((source) => source.attributes('type'))).toEqual([
      'image/avif',
      'image/webp',
      'image/jpeg',
    ])
    expect(sources[0]?.attributes('srcset')).toBe(memory.sources.avif)
    expect(image.attributes()).toMatchObject({
      alt: memory.alt,
      loading: 'lazy',
      decoding: 'async',
      width: '640',
      height: '480',
    })
  })

  it('renders the caption and desktop transform variables', () => {
    const wrapper = mount(PhotoCard, { props: { memory } })
    const card = wrapper.get('article.polaroid')

    expect(wrapper.get('.caption').text()).toBe(memory.caption)
    expect(card.attributes('style')).toContain('--rotation: -5deg')
    expect(card.attributes('style')).toContain('--offset-x: 0px')
    expect(card.attributes('style')).toContain('--offset-y: 10px')
  })

  it('exposes selected state and emits activation from a native button', async () => {
    const wrapper = mount(PhotoCard, {
      props: { memory, isSelected: true },
    })
    const trigger = wrapper.get('button.polaroid-trigger')

    expect(wrapper.get('.photo-slot').attributes('data-memory-id')).toBe(memory.id)
    expect(wrapper.get('.photo-slot').classes()).toContain('is-selected')
    expect(trigger.attributes()).toMatchObject({
      type: 'button',
      'aria-expanded': 'true',
      'aria-label': `查看${memory.caption}`,
    })

    await trigger.trigger('click')

    expect(wrapper.emitted('activate')).toEqual([[memory.id]])
  })
})
