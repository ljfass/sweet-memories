import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import App from './App.vue'

describe('App', () => {
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
  })

  it('applies sleep mode from the floating control', async () => {
    const wrapper = mount(App)

    expect(wrapper.get('.album-app').classes()).not.toContain('is-sleeping')

    await wrapper.get('[data-testid="sleep-toggle"]').trigger('click')

    expect(wrapper.get('.album-app').classes()).toContain('is-sleeping')
    expect(wrapper.get('.sleep-overlay').text()).toBe('嘘，宝宝睡着了... 💤')
  })
})
