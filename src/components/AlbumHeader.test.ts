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

  it('splits title into animated character spans and handles mouse interactions', async () => {
    const wrapper = mount(AlbumHeader)
    const chars = wrapper.findAll('.title-char')

    expect(chars).toHaveLength(7)
    expect(chars.map((char) => char.text())).toEqual(['宝', '贝', '的', '快', '乐', '时', '光'])

    await chars[0]?.trigger('mouseenter')
    await chars[0]?.trigger('mouseleave')

    wrapper.unmount()
  })
})
