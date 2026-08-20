import { onMounted, onUnmounted, readonly, ref, type Ref } from 'vue'

const MAX_CLICK_EFFECTS = 12
const MAX_FALLING_EFFECTS = 10
const CLICK_DURATION_MS = 1000
const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, video, audio, [role="button"], .polaroid, .video-frame'
const DAY_CLICK_GLYPHS = ['❤️', '🍼', '🧸', '🎈', '✨', '👣'] as const
const NIGHT_CLICK_GLYPHS = ['💤', '✨', '🌙', '🌌', '🦉'] as const

export interface ClickEffect {
  id: number
  glyph: string
  x: number
  y: number
  rotation: number
}

export interface FallingEffect {
  id: number
  glyph: string
  x: number
  size: number
  duration: number
}

interface AmbientOptions {
  random?: () => number
  fallIntervalMs?: number
}

export function useAmbientEffects(
  isSleepMode: Readonly<Ref<boolean>>,
  { random = Math.random, fallIntervalMs = 800 }: AmbientOptions = {},
) {
  const clickEffects = ref<ClickEffect[]>([])
  const fallingEffects = ref<FallingEffect[]>([])
  const prefersReducedMotion = ref(false)
  const removalTimers = new Set<ReturnType<typeof window.setTimeout>>()
  let fallingTimer: ReturnType<typeof window.setInterval> | undefined
  let mediaQuery: MediaQueryList | undefined
  let nextId = 0

  const removeEffectLater = (collection: Ref<Array<{ id: number }>>, id: number, delay: number) => {
    const timer = window.setTimeout(() => {
      collection.value = collection.value.filter((effect) => effect.id !== id)
      removalTimers.delete(timer)
    }, delay)
    removalTimers.add(timer)
  }

  const handleClick = (event: MouseEvent) => {
    if (prefersReducedMotion.value) return
    if (event.target instanceof Element && event.target.closest(INTERACTIVE_SELECTOR)) return

    const glyphs = isSleepMode.value ? NIGHT_CLICK_GLYPHS : DAY_CLICK_GLYPHS
    const effect: ClickEffect = {
      id: ++nextId,
      glyph: glyphs[Math.floor(random() * glyphs.length)] ?? glyphs[0],
      x: event.clientX,
      y: event.clientY,
      rotation: random() * 60 - 30,
    }

    clickEffects.value = [...clickEffects.value.slice(-(MAX_CLICK_EFFECTS - 1)), effect]
    removeEffectLater(clickEffects, effect.id, CLICK_DURATION_MS)
  }

  const spawnFallingEffect = () => {
    if (prefersReducedMotion.value) return

    const effect: FallingEffect = {
      id: ++nextId,
      glyph: isSleepMode.value ? '・' : '✨',
      x: random() * 100,
      size: random() * 10 + 10,
      duration: random() * 3 + 4,
    }

    fallingEffects.value = [
      ...fallingEffects.value.slice(-(MAX_FALLING_EFFECTS - 1)),
      effect,
    ]
    removeEffectLater(fallingEffects, effect.id, effect.duration * 1000)
  }

  const stopFalling = () => {
    if (fallingTimer === undefined) return
    window.clearInterval(fallingTimer)
    fallingTimer = undefined
  }

  const startFalling = () => {
    if (prefersReducedMotion.value || fallingTimer !== undefined) return
    fallingTimer = window.setInterval(spawnFallingEffect, fallIntervalMs)
  }

  const clearEffects = () => {
    for (const timer of removalTimers) window.clearTimeout(timer)
    removalTimers.clear()
    clickEffects.value = []
    fallingEffects.value = []
  }

  const handleMotionPreference = (event: MediaQueryListEvent) => {
    prefersReducedMotion.value = event.matches
    if (event.matches) {
      stopFalling()
      clearEffects()
      return
    }
    startFalling()
  }

  onMounted(() => {
    document.addEventListener('click', handleClick)
    mediaQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    prefersReducedMotion.value = mediaQuery?.matches ?? false
    mediaQuery?.addEventListener('change', handleMotionPreference)
    startFalling()
  })

  onUnmounted(() => {
    document.removeEventListener('click', handleClick)
    mediaQuery?.removeEventListener('change', handleMotionPreference)
    stopFalling()
    clearEffects()
  })

  return {
    clickEffects: readonly(clickEffects),
    fallingEffects: readonly(fallingEffects),
  }
}
