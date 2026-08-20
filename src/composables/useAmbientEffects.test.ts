import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAmbientEffects } from './useAmbientEffects'

let prefersReducedMotion = false
const addMotionListener = vi.fn()
const removeMotionListener = vi.fn()

const Harness = defineComponent({
  setup() {
    const isSleepMode = ref(false)
    return {
      isSleepMode,
      ...useAmbientEffects(isSleepMode, {
        random: () => 0,
        fallIntervalMs: 10,
      }),
    }
  },
  template: `
    <button type="button" data-testid="button">button</button>
    <button type="button" data-testid="sleep" @click="isSleepMode = true">sleep</button>
    <span data-testid="click-count">{{ clickEffects.length }}</span>
    <span data-testid="fall-count">{{ fallingEffects.length }}</span>
    <span data-testid="glyph">{{ clickEffects.at(-1)?.glyph }}</span>
  `,
})

describe('useAmbientEffects', () => {
  beforeEach(() => {
    prefersReducedMotion = false
    addMotionListener.mockClear()
    removeMotionListener.mockClear()
    vi.stubGlobal('matchMedia', () => ({
      matches: prefersReducedMotion,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: addMotionListener,
      removeEventListener: removeMotionListener,
      dispatchEvent: () => true,
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('creates daytime and nighttime click effects outside interactive elements', async () => {
    const wrapper = mount(Harness, { attachTo: document.body })

    document.body.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 12, clientY: 24 }),
    )
    await nextTick()
    expect(wrapper.get('[data-testid="click-count"]').text()).toBe('1')
    expect(wrapper.get('[data-testid="glyph"]').text()).toBe('❤️')

    await wrapper.get('[data-testid="button"]').trigger('click')
    expect(wrapper.get('[data-testid="click-count"]').text()).toBe('1')

    await wrapper.get('[data-testid="sleep"]').trigger('click')
    document.body.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 20, clientY: 30 }),
    )
    await nextTick()
    expect(wrapper.get('[data-testid="glyph"]').text()).toBe('💤')
  })

  it('bounds click and falling effects', async () => {
    vi.useFakeTimers()
    const wrapper = mount(Harness, { attachTo: document.body })

    for (let index = 0; index < 20; index += 1) {
      document.body.dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientX: index, clientY: index }),
      )
    }
    vi.advanceTimersByTime(150)
    await nextTick()

    expect(Number(wrapper.get('[data-testid="click-count"]').text())).toBeLessThanOrEqual(12)
    expect(Number(wrapper.get('[data-testid="fall-count"]').text())).toBeLessThanOrEqual(10)
  })

  it('disables decorations when reduced motion is requested', async () => {
    prefersReducedMotion = true
    const wrapper = mount(Harness, { attachTo: document.body })

    document.body.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 }),
    )
    await nextTick()

    expect(wrapper.get('[data-testid="click-count"]').text()).toBe('0')
    expect(wrapper.get('[data-testid="fall-count"]').text()).toBe('0')
  })

  it('removes listeners and interval timers on unmount', () => {
    vi.useFakeTimers()
    const setIntervalSpy = vi.spyOn(window, 'setInterval')
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval')
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener')
    const wrapper = mount(Harness)
    const effectTimer = setIntervalSpy.mock.results.find(
      (_result, index) => setIntervalSpy.mock.calls[index]?.[1] === 10,
    )?.value

    wrapper.unmount()

    expect(clearIntervalSpy).toHaveBeenCalledWith(effectTimer)
    expect(removeDocumentListener).toHaveBeenCalledWith('click', expect.any(Function))
    expect(removeMotionListener).toHaveBeenCalledOnce()
  })
})
