import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
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
    expect(sleepButton.get('.sleep-icon').text()).toBe('🌙')

    await sleepButton.trigger('click')
    expect(wrapper.emitted('toggle-sleep')).toHaveLength(1)

    await wrapper.setProps({ isSleepMode: true })
    expect(sleepButton.attributes('aria-label')).toBe('退出哄睡模式')
    expect(sleepButton.attributes('aria-pressed')).toBe('true')
    expect(sleepButton.get('.sleep-icon').text()).toBe('☀️')
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

  it('defers audio and orders the compact source before the fallback', () => {
    const wrapper = mount(FloatingControls, {
      props: { isSleepMode: false, isOverlayVisible: false, audioSources },
    })
    const audio = wrapper.get('audio')
    const sources = audio.findAll('source')

    expect(audio.attributes()).toMatchObject({ preload: 'none', loop: '' })
    expect(sources.map((source) => source.attributes('src'))).toEqual([
      audioSources.aac,
      audioSources.mp3,
    ])
    expect(sources.map((source) => source.attributes('type'))).toEqual([
      'audio/mp4',
      'audio/mpeg',
    ])
  })

  it('reflects successful playback state', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const wrapper = mount(FloatingControls, {
      props: { isSleepMode: false, isOverlayVisible: false, audioSources },
    })
    const button = wrapper.get('[data-testid="music-toggle"]')

    await button.trigger('click')
    await flushPromises()
    expect(button.classes()).toContain('is-playing')
    expect(button.attributes('aria-pressed')).toBe('true')
    expect(button.attributes('aria-label')).toBe('暂停背景音乐')
    expect(wrapper.find('.music-control').exists()).toBe(true)
    expect(wrapper.get('.music-notes').attributes('aria-hidden')).toBe('true')
    expect(wrapper.findAll('.music-note')).toHaveLength(1)
    expect(wrapper.get('.music-note').text()).toMatch(/^[🎵🎶🎼]$/u)
  })

  it('exposes failed playback as an accessible status', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new Error('blocked'))
    const errorWrapper = mount(FloatingControls, {
      props: { isSleepMode: false, isOverlayVisible: false, audioSources },
    })

    await errorWrapper.get('[data-testid="music-toggle"]').trigger('click')
    await flushPromises()
    expect(errorWrapper.get('[role="status"]').text()).toBe('音乐暂时无法播放')
    expect(errorWrapper.findAll('.music-note')).toHaveLength(0)
  })
})
