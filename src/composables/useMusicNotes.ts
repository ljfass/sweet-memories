import {
  onMounted,
  onUnmounted,
  readonly,
  ref,
  watch,
  type Ref,
} from 'vue'

const NOTE_GLYPHS = ['🎵', '🎶', '🎼'] as const
const MAX_NOTES = 8

export interface MusicNote {
  id: number
  glyph: (typeof NOTE_GLYPHS)[number]
  travelX: number
  travelY: number
  scale: number
  rotation: number
  durationMs: number
}

interface MusicNoteOptions {
  random?: () => number
  intervalMs?: number
  mediaQuery?: MediaQueryList
}

export function useMusicNotes(
  isPlaying: Readonly<Ref<boolean>>,
  {
    random = Math.random,
    intervalMs = 300,
    mediaQuery: providedMediaQuery,
  }: MusicNoteOptions = {},
) {
  const notes = ref<MusicNote[]>([])
  const removalTimers = new Set<ReturnType<typeof window.setTimeout>>()
  let emissionTimer: ReturnType<typeof window.setInterval> | undefined
  let mediaQuery: MediaQueryList | undefined
  let mounted = false
  let prefersReducedMotion = false
  let nextId = 0

  const stopEmitting = () => {
    if (emissionTimer === undefined) return
    window.clearInterval(emissionTimer)
    emissionTimer = undefined
  }

  const removeNoteLater = (note: MusicNote) => {
    const timer = window.setTimeout(() => {
      notes.value = notes.value.filter(({ id }) => id !== note.id)
      removalTimers.delete(timer)
    }, note.durationMs)
    removalTimers.add(timer)
  }

  const createNote = () => {
    if (prefersReducedMotion) return

    const note: MusicNote = {
      id: ++nextId,
      glyph:
        NOTE_GLYPHS[Math.floor(random() * NOTE_GLYPHS.length)] ?? NOTE_GLYPHS[0],
      travelX: -Math.round(60 + random() * 70),
      travelY: -Math.round(95 + random() * 80),
      scale: 1.35 + random() * 0.55,
      rotation: Math.round(random() * 40 - 20),
      durationMs: Math.round(1600 + random() * 600),
    }

    notes.value = [...notes.value.slice(-(MAX_NOTES - 1)), note]
    removeNoteLater(note)
  }

  const startEmitting = () => {
    if (
      !mounted ||
      !isPlaying.value ||
      prefersReducedMotion ||
      emissionTimer !== undefined
    ) {
      return
    }

    createNote()
    emissionTimer = window.setInterval(createNote, intervalMs)
  }

  const clearNotes = () => {
    for (const timer of removalTimers) window.clearTimeout(timer)
    removalTimers.clear()
    notes.value = []
  }

  const handleMotionPreference = (event: MediaQueryListEvent) => {
    prefersReducedMotion = event.matches
    if (event.matches) {
      stopEmitting()
      clearNotes()
      return
    }
    startEmitting()
  }

  watch(isPlaying, (playing) => {
    if (!mounted) return
    if (playing) startEmitting()
    else stopEmitting()
  })

  onMounted(() => {
    mounted = true
    mediaQuery =
      providedMediaQuery ?? window.matchMedia?.('(prefers-reduced-motion: reduce)')
    prefersReducedMotion = mediaQuery?.matches ?? false
    mediaQuery?.addEventListener('change', handleMotionPreference)
    startEmitting()
  })

  onUnmounted(() => {
    mounted = false
    mediaQuery?.removeEventListener('change', handleMotionPreference)
    stopEmitting()
    clearNotes()
  })

  return { notes: readonly(notes) }
}
