import { effectScope, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAdminSuccessNotifications } from './useAdminSuccessNotifications'

function createNotifications() {
  const scope = effectScope()
  const notifications = scope.run(() => useAdminSuccessNotifications())

  if (!notifications) throw new Error('通知状态未在 effect scope 中创建')

  return { notifications, scope }
}

describe('useAdminSuccessNotifications', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('deduplicates an active key without replacing its message or lifetime', async () => {
    vi.useFakeTimers()
    const { notifications, scope } = createNotifications()

    notifications.show('photo:1', '照片已保存')
    vi.advanceTimersByTime(2_000)
    notifications.show('photo:1', '不应替换原文案')

    expect(notifications.items.value).toHaveLength(1)
    expect(notifications.items.value[0]).toMatchObject({
      key: 'photo:1',
      message: '照片已保存',
    })

    vi.advanceTimersByTime(1_500)
    await nextTick()
    expect(notifications.items.value).toEqual([])
    scope.stop()
  })

  it('keeps the two newest notifications and allows equal copy for distinct keys', () => {
    vi.useFakeTimers()
    const { notifications, scope } = createNotifications()

    notifications.show('photo:1', '已保存')
    notifications.show('photo:2', '已保存')
    notifications.show('photo:3', '已保存')

    expect(notifications.items.value.map(({ key }) => key)).toEqual(['photo:2', 'photo:3'])
    scope.stop()
  })

  it('automatically dismisses a notification after 3.5 seconds', async () => {
    vi.useFakeTimers()
    const { notifications, scope } = createNotifications()

    notifications.show('upload:1', '上传完成')
    vi.advanceTimersByTime(3_499)
    await nextTick()
    expect(notifications.items.value).toHaveLength(1)

    vi.advanceTimersByTime(1)
    await nextTick()
    expect(notifications.items.value).toEqual([])
    scope.stop()
  })

  it('pauses with the exact remaining lifetime and resumes idempotently', async () => {
    vi.useFakeTimers()
    const { notifications, scope } = createNotifications()

    notifications.show('edit:1', '修改已保存')
    const id = notifications.items.value[0]?.id
    expect(id).toBeDefined()

    vi.advanceTimersByTime(1_275)
    notifications.pause(id!)
    notifications.pause(id!)
    vi.advanceTimersByTime(10_000)
    await nextTick()
    expect(notifications.items.value).toHaveLength(1)

    notifications.resume(id!)
    notifications.resume(id!)
    vi.advanceTimersByTime(2_224)
    await nextTick()
    expect(notifications.items.value).toHaveLength(1)

    vi.advanceTimersByTime(1)
    await nextTick()
    expect(notifications.items.value).toEqual([])
    scope.stop()
  })

  it('manually dismisses, clears its timer, and releases the key', async () => {
    vi.useFakeTimers()
    const { notifications, scope } = createNotifications()

    notifications.show('delete:1', '照片已删除')
    const firstId = notifications.items.value[0]?.id
    notifications.dismiss(firstId!)
    expect(notifications.items.value).toEqual([])

    notifications.show('delete:1', '再次删除成功')
    expect(notifications.items.value[0]).toMatchObject({
      key: 'delete:1',
      message: '再次删除成功',
    })

    vi.advanceTimersByTime(3_500)
    await nextTick()
    expect(notifications.items.value).toEqual([])
    scope.stop()
  })

  it('clears every timer on scope disposal so late callbacks cannot change state', async () => {
    vi.useFakeTimers()
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout')
    const { notifications, scope } = createNotifications()

    notifications.show('photo:1', '第一条')
    notifications.show('photo:2', '第二条')
    const itemsAtDispose = [...notifications.items.value]
    scope.stop()

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(10_000)
    await nextTick()
    expect(notifications.items.value).toEqual(itemsAtDispose)
  })
})
