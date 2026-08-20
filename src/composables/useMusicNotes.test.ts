import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref, type Ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMusicNotes } from './useMusicNotes'

function createMotionPreference(initialMatches = false) {
  let matches = initialMatches
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const mediaQuery = {
    get matches() {
      return matches
    },
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: (
      _type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => {
      listeners.add(listener)
    },
    removeEventListener: (
      _type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => {
      listeners.delete(listener)
    },
  } as MediaQueryList

  return {
    mediaQuery,
    setMatches(value: boolean) {
      matches = value
      for (const listener of listeners) {
        listener({ matches: value } as MediaQueryListEvent)
      }
    },
    listenerCount: () => listeners.size,
  }
}

function mountNotes(isPlaying: Ref<boolean>, mediaQuery: MediaQueryList) {
  return mount(
    defineComponent({
      setup() {
        return useMusicNotes(isPlaying, {
          random: () => 0.5,
          mediaQuery,
        })
      },
      template: '<span v-for="note in notes" :key="note.id">{{ note.glyph }}</span>',
    }),
  )
}

describe('useMusicNotes', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('emits immediately and then every 300ms while playing', async () => {
    const isPlaying = ref(false)
    const motion = createMotionPreference()
    const wrapper = mountNotes(isPlaying, motion.mediaQuery)

    isPlaying.value = true
    await nextTick()
    expect(wrapper.vm.notes).toHaveLength(1)
    expect(wrapper.vm.notes[0]).toMatchObject({
      glyph: '🎶',
      travelX: -95,
      travelY: -135,
    })

    vi.advanceTimersByTime(600)
    await nextTick()
    expect(wrapper.vm.notes).toHaveLength(3)
  })

  it('stops new notes on pause and lets existing notes expire', async () => {
    const isPlaying = ref(true)
    const motion = createMotionPreference()
    const wrapper = mountNotes(isPlaying, motion.mediaQuery)

    vi.advanceTimersByTime(600)
    await nextTick()
    expect(wrapper.vm.notes).toHaveLength(3)

    isPlaying.value = false
    await nextTick()
    const pausedCount = wrapper.vm.notes.length
    vi.advanceTimersByTime(600)
    await nextTick()
    expect(wrapper.vm.notes).toHaveLength(pausedCount)

    vi.advanceTimersByTime(2200)
    await nextTick()
    expect(wrapper.vm.notes).toHaveLength(0)
  })

  it('bounds notes, reacts to reduced motion, and cleans up', async () => {
    const isPlaying = ref(true)
    const motion = createMotionPreference()
    const clearInterval = vi.spyOn(window, 'clearInterval')
    const clearTimeout = vi.spyOn(window, 'clearTimeout')
    const wrapper = mountNotes(isPlaying, motion.mediaQuery)

    vi.advanceTimersByTime(2400)
    await nextTick()
    expect(wrapper.vm.notes.length).toBeLessThanOrEqual(8)

    motion.setMatches(true)
    await nextTick()
    expect(wrapper.vm.notes).toHaveLength(0)

    motion.setMatches(false)
    await nextTick()
    expect(wrapper.vm.notes).toHaveLength(1)
    expect(motion.listenerCount()).toBe(1)

    wrapper.unmount()
    expect(motion.listenerCount()).toBe(0)
    expect(clearInterval).toHaveBeenCalled()
    expect(clearTimeout).toHaveBeenCalled()
  })
})
