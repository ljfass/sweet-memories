import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { Memory } from '../types/album'
import PhotoGallery from './PhotoGallery.vue'

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

describe('PhotoGallery', () => {
  it('renders memories in their configured order', () => {
    const wrapper = mount(PhotoGallery, { props: { memories } })

    expect(wrapper.get('section').attributes('aria-label')).toBe('成长照片墙')
    expect(wrapper.findAll('article')).toHaveLength(2)
    expect(wrapper.findAll('.caption').map((caption) => caption.text())).toEqual([
      '第一张照片',
      '第二张照片',
    ])
  })
})
