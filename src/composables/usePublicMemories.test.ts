import { defineComponent, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { memories as staticMemories } from '../data/memories'
import type { Memory } from '../types/album'
import { usePublicMemories } from './usePublicMemories'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function mountState(options: Parameters<typeof usePublicMemories>[0]) {
  let state!: ReturnType<typeof usePublicMemories>
  const wrapper = mount(defineComponent({
    setup() {
      state = usePublicMemories(options)
      return () => null
    },
  }))
  return { state, wrapper }
}

const apiMemory: Memory = {
  id: 'api-photo',
  caption: '新的成长瞬间',
  alt: '宝宝在公园里开心地笑',
  sources: {
    avif: '/media/api-photo/320.avif 320w',
    webp: '/media/api-photo/320.webp 320w',
    jpeg: '/media/api-photo/320.jpg 320w',
    fallback: '/media/api-photo/320.jpg',
    width: 320,
    height: 240,
  },
  transform: { rotation: 0, x: 0, y: 0 },
}

describe('usePublicMemories', () => {
  it('returns the five static memories synchronously without calling the network', () => {
    const load = vi.fn()

    const { state } = mountState({ config: { mode: 'static' }, load })

    expect(state.status.value).toBe('ready')
    expect(state.memories.value).toEqual(staticMemories)
    expect(state.memories.value).toHaveLength(5)
    expect(load).not.toHaveBeenCalled()
  })

  it('loads API memories only after mount and publishes them atomically', async () => {
    const pending = deferred<readonly Memory[]>()
    const load = vi.fn(() => pending.promise)

    const { state } = mountState({ config: { mode: 'api' }, load })
    expect(state.status.value).toBe('loading')
    expect(state.memories.value).toEqual([])
    expect(load).toHaveBeenCalledTimes(1)

    pending.resolve([apiMemory])
    await pending.promise
    await nextTick()

    expect(state.status.value).toBe('ready')
    expect(state.memories.value).toEqual([apiMemory])
  })

  it('treats an empty API album as ready without retrying', async () => {
    const load = vi.fn().mockResolvedValue([])

    const { state } = mountState({ config: { mode: 'api' }, load })

    await vi.waitFor(() => expect(state.status.value).toBe('ready'))
    expect(state.memories.value).toEqual([])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('shows an error and retries once without starting duplicate requests', async () => {
    const retryRequest = deferred<readonly Memory[]>()
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => retryRequest.promise)
    const { state } = mountState({ config: { mode: 'api' }, load })

    await vi.waitFor(() => expect(state.status.value).toBe('error'))

    const firstRetry = state.retry()
    const duplicateRetry = state.retry()
    expect(load).toHaveBeenCalledTimes(2)

    retryRequest.resolve([apiMemory])
    await Promise.all([firstRetry, duplicateRetry])

    expect(state.status.value).toBe('ready')
    expect(state.memories.value).toEqual([apiMemory])
  })

  it('aborts on unmount and ignores a request that settles afterwards', async () => {
    const pending = deferred<readonly Memory[]>()
    let signal: AbortSignal | undefined
    const load = vi.fn((requestSignal: AbortSignal) => {
      signal = requestSignal
      return pending.promise
    })
    const { state, wrapper } = mountState({ config: { mode: 'api' }, load })

    wrapper.unmount()
    expect(signal?.aborted).toBe(true)

    pending.resolve([apiMemory])
    await pending.promise
    await nextTick()

    expect(state.status.value).toBe('loading')
    expect(state.memories.value).toEqual([])
  })
})
