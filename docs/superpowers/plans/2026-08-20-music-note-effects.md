# Music Note Effects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit bounded, upper-left flowing music-note animations only while background audio is actually playing.

**Architecture:** A focused Vue composable converts readonly playback state into transient typed note records with deterministic timers and cleanup. `FloatingControls.vue` renders those records in a noninteractive layer next to the music button, while CSS handles transform-and-opacity animation without affecting layout.

**Tech Stack:** Vue 3 Composition API, TypeScript, CSS keyframes, Vitest, Vue Test Utils, pnpm

---

## File Map

- Create: `src/composables/useMusicNotes.ts` - owns note records, cadence, motion preference, bounds, and cleanup.
- Create: `src/composables/useMusicNotes.test.ts` - verifies timing, pause semantics, bounds, and reduced motion.
- Modify: `src/components/FloatingControls.vue` - renders the note layer from real audio playback state.
- Modify: `src/components/FloatingControls.test.ts` - verifies successful playback exposes notes and rejected playback does not.
- Modify: `src/styles/global.css` - anchors the music-control wrapper and animates notes using transforms and opacity.
- Modify: `scripts/global-styles.test.ts` - locks the animation's positioning and compositor-friendly properties.

### Task 1: Build The Bounded Music Note Composable

**Files:**
- Create: `src/composables/useMusicNotes.test.ts`
- Create: `src/composables/useMusicNotes.ts`

- [ ] **Step 1: Write failing timing and lifecycle tests**

Create `src/composables/useMusicNotes.test.ts`:

```ts
import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
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
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
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

function mountNotes(
  isPlaying: ReturnType<typeof ref<boolean>>,
  mediaQuery: MediaQueryList,
) {
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
    expect(wrapper.vm.notes[0]).toMatchObject({ glyph: '🎶', travelX: -95, travelY: -135 })

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
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm test -- src/composables/useMusicNotes.test.ts
```

Expected: FAIL because `useMusicNotes.ts` does not exist.

- [ ] **Step 3: Implement the composable**

Create `src/composables/useMusicNotes.ts`:

```ts
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
      glyph: NOTE_GLYPHS[Math.floor(random() * NOTE_GLYPHS.length)] ?? NOTE_GLYPHS[0],
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
    if (!mounted || !isPlaying.value || prefersReducedMotion || emissionTimer !== undefined) {
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
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm test -- src/composables/useMusicNotes.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit the composable**

```bash
git add src/composables/useMusicNotes.ts src/composables/useMusicNotes.test.ts
git commit -m "feat: add bounded music note effects"
```

### Task 2: Render And Animate Notes From Real Playback State

**Files:**
- Modify: `src/components/FloatingControls.test.ts`
- Modify: `src/components/FloatingControls.vue`
- Modify: `src/styles/global.css`
- Modify: `scripts/global-styles.test.ts`

- [ ] **Step 1: Write the failing component integration assertions**

In the successful playback test in `FloatingControls.test.ts`, add:

```ts
expect(wrapper.find('.music-control').exists()).toBe(true)
expect(wrapper.get('.music-notes').attributes('aria-hidden')).toBe('true')
expect(wrapper.findAll('.music-note')).toHaveLength(1)
expect(wrapper.get('.music-note').text()).toMatch(/^[🎵🎶🎼]$/u)
```

In the rejected playback test, add:

```ts
expect(errorWrapper.findAll('.music-note')).toHaveLength(0)
```

In `scripts/global-styles.test.ts`, add a new test:

```ts
it('anchors music notes and animates only transforms and opacity', () => {
  expect(globalCss).toMatch(
    /\.music-control\s*{[^}]*position:\s*fixed;[^}]*right:\s*30px;[^}]*bottom:\s*30px;/s,
  )
  expect(globalCss).toMatch(
    /\.music-note\s*{[^}]*pointer-events:\s*none;[^}]*will-change:\s*transform, opacity;[^}]*animation:\s*music-note-flow/s,
  )
  expect(globalCss).toMatch(
    /@keyframes music-note-flow\s*{[\s\S]*?transform:[^;]+;[\s\S]*?opacity:\s*0;/s,
  )
})
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm test -- src/components/FloatingControls.test.ts scripts/global-styles.test.ts
```

Expected: FAIL because the music wrapper, note layer, and animation rules do not exist.

- [ ] **Step 3: Connect the composable and render the note layer**

Update `FloatingControls.vue` imports:

```ts
import { computed, ref, type CSSProperties } from 'vue'
import { useMusicNotes, type MusicNote } from '../composables/useMusicNotes'
```

After deriving `isPlaying`, add:

```ts
const { notes } = useMusicNotes(isPlaying)
const noteStyle = (note: MusicNote): CSSProperties => ({
  '--note-x': `${note.travelX}px`,
  '--note-y': `${note.travelY}px`,
  '--note-scale': note.scale,
  '--note-rotation': `${note.rotation}deg`,
  '--note-duration': `${note.durationMs}ms`,
})
```

Wrap the existing music button in this structure without changing its attributes
or event handler:

```vue
<div class="music-control">
  <div class="music-notes" aria-hidden="true">
    <span
      v-for="note in notes"
      :key="note.id"
      class="music-note"
      :style="noteStyle(note)"
    >
      {{ note.glyph }}
    </span>
  </div>

  <button class="icon-button music-btn" ...>
    ...
  </button>
</div>
```

- [ ] **Step 4: Add fixed wrapper and note animation styles**

Replace the music button positioning rules and add:

```css
.music-control {
  position: fixed;
  z-index: 99;
  right: 30px;
  bottom: 30px;
  width: 52px;
  height: 52px;
}

.music-btn {
  position: relative;
  z-index: 2;
  right: auto;
  bottom: auto;
  color: #5d4048;
  background: var(--accent-soft);
}

.music-notes {
  position: absolute;
  z-index: 1;
  inset: 0;
  overflow: visible;
  pointer-events: none;
}

.music-note {
  position: absolute;
  top: 50%;
  left: 50%;
  font-size: 20px;
  line-height: 1;
  opacity: 0;
  pointer-events: none;
  will-change: transform, opacity;
  animation: music-note-flow var(--note-duration) ease-out forwards;
}
```

Inside the mobile breakpoint, replace `.music-btn` offsets with:

```css
.music-control {
  right: 20px;
  bottom: 20px;
}
```

Add the keyframe:

```css
@keyframes music-note-flow {
  0% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.65) rotate(0deg);
  }
  14% {
    opacity: 0.95;
  }
  100% {
    opacity: 0;
    transform: translate(
        calc(-50% + var(--note-x)),
        calc(-50% + var(--note-y))
      )
      scale(var(--note-scale)) rotate(var(--note-rotation));
  }
}
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
pnpm test -- src/components/FloatingControls.test.ts scripts/global-styles.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 6: Run complete verification**

Run each command and require exit code 0:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --exit-code -- codebase
```

Expected: lint and type checking pass, all tests pass, the production build succeeds, and `codebase/` remains unchanged.

- [ ] **Step 7: Commit the integration**

```bash
git add src/components/FloatingControls.vue src/components/FloatingControls.test.ts src/styles/global.css scripts/global-styles.test.ts
git commit -m "feat: animate notes from background music"
```
