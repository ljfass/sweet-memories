import { onScopeDispose, readonly, ref } from 'vue'

const OVERLAY_DURATION_MS = 3000

export function useSleepMode() {
  const isSleepMode = ref(false)
  const isOverlayVisible = ref(false)
  let overlayTimer: ReturnType<typeof window.setTimeout> | undefined

  const clearOverlayTimer = () => {
    if (overlayTimer === undefined) return

    window.clearTimeout(overlayTimer)
    overlayTimer = undefined
  }

  const toggleSleepMode = () => {
    isSleepMode.value = !isSleepMode.value
    clearOverlayTimer()

    if (!isSleepMode.value) {
      isOverlayVisible.value = false
      return
    }

    isOverlayVisible.value = true
    overlayTimer = window.setTimeout(() => {
      isOverlayVisible.value = false
      overlayTimer = undefined
    }, OVERLAY_DURATION_MS)
  }

  onScopeDispose(clearOverlayTimer)

  return {
    isSleepMode: readonly(isSleepMode),
    isOverlayVisible: readonly(isOverlayVisible),
    toggleSleepMode,
  }
}
