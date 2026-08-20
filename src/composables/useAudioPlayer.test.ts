import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useAudioPlayer } from './useAudioPlayer'

const Harness = defineComponent({
  setup() {
    const audioElement = ref<HTMLAudioElement | null>(null)
    return {
      audioElement,
      ...useAudioPlayer(audioElement),
    }
  },
  template: `
    <audio ref="audioElement" preload="none" />
    <button type="button" data-testid="toggle" @click="togglePlayback">toggle</button>
    <span data-testid="status">{{ status }}</span>
    <span data-testid="error">{{ errorMessage }}</span>
  `,
})

describe('useAudioPlayer', () => {
  it('loads only after user intent and enters the playing state', async () => {
    let resolvePlayback!: () => void
    const playback = new Promise<void>((resolve) => {
      resolvePlayback = resolve
    })
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockReturnValue(playback)
    const wrapper = mount(Harness)

    expect(play).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="status"]').text()).toBe('idle')

    await wrapper.get('[data-testid="toggle"]').trigger('click')
    expect(wrapper.get('[data-testid="status"]').text()).toBe('loading')
    resolvePlayback()
    await flushPromises()

    expect(play).toHaveBeenCalledOnce()
    expect(wrapper.get('[data-testid="status"]').text()).toBe('playing')
  })

  it('returns a stable error when playback is rejected', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(
      new DOMException('Not allowed', 'NotAllowedError'),
    )
    const wrapper = mount(Harness)

    await wrapper.get('[data-testid="toggle"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="status"]').text()).toBe('error')
    expect(wrapper.get('[data-testid="error"]').text()).toBe('音乐暂时无法播放')
  })

  it('synchronizes native events and pauses on a second toggle', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const wrapper = mount(Harness)
    const audio = wrapper.get('audio')

    await audio.trigger('play')
    expect(wrapper.get('[data-testid="status"]').text()).toBe('playing')

    await wrapper.get('[data-testid="toggle"]').trigger('click')
    expect(pause).toHaveBeenCalledOnce()
    expect(wrapper.get('[data-testid="status"]').text()).toBe('idle')

    await audio.trigger('pause')
    expect(wrapper.get('[data-testid="status"]').text()).toBe('idle')

    await audio.trigger('error')
    expect(wrapper.get('[data-testid="status"]').text()).toBe('error')
  })
})
