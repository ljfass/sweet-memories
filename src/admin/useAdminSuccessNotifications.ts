import { getCurrentScope, onScopeDispose, readonly, ref } from 'vue'

export interface AdminSuccessNotification {
  readonly id: number
  readonly key: string
  readonly message: string
}

interface NotificationTimer {
  timer: number | undefined
  deadline: number
  remaining: number
  paused: boolean
}

const AUTO_DISMISS_MS = 3_500
const MAX_ACTIVE_NOTIFICATIONS = 2

export function useAdminSuccessNotifications() {
  const items = ref<AdminSuccessNotification[]>([])
  const timers = new Map<number, NotificationTimer>()
  let nextId = 1
  let disposed = false

  function clearTimer(record: NotificationTimer): void {
    if (record.timer === undefined) return

    window.clearTimeout(record.timer)
    record.timer = undefined
  }

  function dismiss(id: number): void {
    const record = timers.get(id)
    if (record) clearTimer(record)
    timers.delete(id)
    items.value = items.value.filter((item) => item.id !== id)
  }

  function schedule(id: number, record: NotificationTimer): void {
    record.deadline = Date.now() + record.remaining
    record.timer = window.setTimeout(() => {
      if (disposed || timers.get(id) !== record) return
      dismiss(id)
    }, record.remaining)
  }

  function show(key: string, message: string): void {
    if (disposed || items.value.some((item) => item.key === key)) return

    if (items.value.length === MAX_ACTIVE_NOTIFICATIONS) {
      dismiss(items.value[0]!.id)
    }

    const notification: AdminSuccessNotification = {
      id: nextId,
      key,
      message,
    }
    nextId += 1

    const record: NotificationTimer = {
      timer: undefined,
      deadline: 0,
      remaining: AUTO_DISMISS_MS,
      paused: false,
    }
    items.value = [...items.value, notification]
    timers.set(notification.id, record)
    schedule(notification.id, record)
  }

  function pause(id: number): void {
    const record = timers.get(id)
    if (!record || record.paused) return

    record.remaining = Math.max(0, record.deadline - Date.now())
    record.paused = true
    clearTimer(record)
  }

  function resume(id: number): void {
    const record = timers.get(id)
    if (!record || !record.paused) return

    record.paused = false
    if (record.remaining === 0) {
      dismiss(id)
      return
    }
    schedule(id, record)
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true
      timers.forEach(clearTimer)
      timers.clear()
    })
  }

  return {
    items: readonly(items),
    show,
    dismiss,
    pause,
    resume,
  }
}
