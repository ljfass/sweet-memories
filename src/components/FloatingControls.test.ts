import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import FloatingControls from './FloatingControls.vue'

const audioSources = {
  aac: '/lullaby.m4a',
  mp3: '/lullaby.mp3',
}

describe('FloatingControls', () => {
  it('emits sleep toggles with an accessible pressed state', async () => {
    const wrapper = mount(FloatingControls, {
      props: { isSleepMode: false, isOverlayVisible: false, audioSources },
    })
    const sleepButton = wrapper.get('[data-testid="sleep-toggle"]')

    expect(sleepButton.element.tagName).toBe('BUTTON')
    expect(sleepButton.attributes()).toMatchObject({
      type: 'button',
      'aria-label': '开启哄睡模式',
      'aria-pressed': 'false',
    })

    await sleepButton.trigger('click')
    expect(wrapper.emitted('toggle-sleep')).toHaveLength(1)

    await wrapper.setProps({ isSleepMode: true })
    expect(sleepButton.attributes('aria-label')).toBe('退出哄睡模式')
    expect(sleepButton.attributes('aria-pressed')).toBe('true')
  })

  it('renders the music command and sleep status overlay', () => {
    const wrapper = mount(FloatingControls, {
      props: { isSleepMode: true, isOverlayVisible: true, audioSources },
    })

    expect(wrapper.get('[data-testid="music-toggle"]').attributes()).toMatchObject({
      type: 'button',
      'aria-label': '播放背景音乐',
    })
    expect(wrapper.get('[role="status"]').text()).toBe('嘘，宝宝睡着了... 💤')
  })

  it('does not expose the overlay when it is hidden', () => {
    const wrapper = mount(FloatingControls, {
      props: { isSleepMode: false, isOverlayVisible: false, audioSources },
    })

    expect(wrapper.find('[role="status"]').exists()).toBe(false)
  })
})
