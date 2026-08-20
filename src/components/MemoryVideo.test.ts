import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MemoryVideo from './MemoryVideo.vue'

describe('MemoryVideo', () => {
  it('renders an accessible, deferred-loading video', () => {
    const wrapper = mount(MemoryVideo, {
      props: {
        poster: '/video-poster.jpg',
        src: '/memory.mp4',
      },
    })

    expect(wrapper.get('section').attributes('aria-labelledby')).toBe(
      'memory-video-title',
    )
    expect(wrapper.get('h2').classes()).toContain('video-title')
    expect(wrapper.get('h2').text()).toBe('🎥 成长放映室')

    const video = wrapper.get('video')
    expect(video.attributes('controls')).toBeDefined()
    expect(video.attributes('preload')).toBe('none')
    expect(video.attributes('poster')).toBe('/video-poster.jpg')
    expect(video.get('source').attributes()).toMatchObject({
      src: '/memory.mp4',
      type: 'video/mp4',
    })
    expect(video.text()).toContain('您的浏览器不支持视频播放。')
  })
})
