import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAgeCounter } from './useAgeCounter'

const Harness = defineComponent({
  setup() {
    const age = useAgeCounter(new Date('2025-10-09T08:55:00'))
    return { age }
  },
  template: '<span data-testid="seconds">{{ age.seconds }}</span>',
})

describe('useAgeCounter', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders immediately, advances each second, and cleans up its timer', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-10-09T08:55:00'))
    const setIntervalSpy = vi.spyOn(window, 'setInterval')
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval')

    const wrapper = mount(Harness)
    expect(wrapper.get('[data-testid="seconds"]').text()).toBe('0')

    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(wrapper.get('[data-testid="seconds"]').text()).toBe('1')

    wrapper.unmount()
    expect(clearIntervalSpy).toHaveBeenCalledWith(setIntervalSpy.mock.results[0]?.value)
  })
})
