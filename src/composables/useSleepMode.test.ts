import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSleepMode } from './useSleepMode'

const Harness = defineComponent({
  setup() {
    return useSleepMode()
  },
  template: `
    <button type="button" data-testid="toggle" @click="toggleSleepMode">toggle</button>
    <span data-testid="mode">{{ isSleepMode }}</span>
    <span data-testid="overlay">{{ isOverlayVisible }}</span>
  `,
})

describe('useSleepMode', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the sleep overlay for three seconds', async () => {
    vi.useFakeTimers()
    const wrapper = mount(Harness)

    expect(wrapper.get('[data-testid="mode"]').text()).toBe('false')
    await wrapper.get('[data-testid="toggle"]').trigger('click')
    expect(wrapper.get('[data-testid="mode"]').text()).toBe('true')
    expect(wrapper.get('[data-testid="overlay"]').text()).toBe('true')

    vi.advanceTimersByTime(2999)
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="overlay"]').text()).toBe('true')

    vi.advanceTimersByTime(1)
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="overlay"]').text()).toBe('false')
  })

  it('replaces pending overlay timeouts and cleans them up', async () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout')
    const wrapper = mount(Harness)

    await wrapper.get('[data-testid="toggle"]').trigger('click')
    vi.advanceTimersByTime(1000)
    await wrapper.get('[data-testid="toggle"]').trigger('click')
    await wrapper.get('[data-testid="toggle"]').trigger('click')

    const overlayTimers = setTimeoutSpy.mock.results
      .map((result) => result.value)
      .filter((timer): timer is ReturnType<typeof setTimeout> => timer !== undefined)
    expect(overlayTimers.length).toBeGreaterThanOrEqual(2)
    expect(clearTimeoutSpy).toHaveBeenCalledWith(overlayTimers.at(-2))

    wrapper.unmount()
    expect(clearTimeoutSpy).toHaveBeenCalledWith(overlayTimers.at(-1))
  })
})
