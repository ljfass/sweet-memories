import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AlbumHeader from './AlbumHeader.vue'

afterEach(() => {
  vi.useRealTimers()
})

describe('AlbumHeader', () => {
  it('renders the album title and subtitle', () => {
    const wrapper = mount(AlbumHeader)

    expect(wrapper.get('h1').text()).toBe('宝贝的快乐时光')
    expect(wrapper.get('.subtitle').text()).toBe('记录成长的每一个心动瞬间 👶✨')
  })

  it('counts from the configured birth date rather than a local constant', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T10:57:03'))

    const wrapper = mount(AlbumHeader)

    // src/config/baby.json pins 2025-10-09T08:55:00.
    expect(wrapper.get('.age-counter').text()).toContain('1 年')
    expect(wrapper.get('.age-counter').text()).toContain('1 天')
  })
})
