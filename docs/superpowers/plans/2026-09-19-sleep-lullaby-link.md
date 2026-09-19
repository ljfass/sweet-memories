# Sleep Mode Lullaby Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking the moon enters the night scene and starts the lullaby in the same gesture; leaving sleep restores the album without stopping playback.

**Architecture:** `useAudioPlayer` gains a play-only `play()` that is a no-op while `playing` or `loading`. `FloatingControls` handles the moon click: emit `toggle-sleep` first, then `void play()` only when entering sleep. Overlay stays unused. The music button remains the only pause/resume control.

**Tech Stack:** Vue 3 Composition API, TypeScript, Vue Test Utils, Vitest, existing `HTMLMediaElement` playback.

---

## File Map

- Modify `src/composables/useAudioPlayer.ts`: export `play()` that only starts playback.
- Modify `src/composables/useAudioPlayer.test.ts`: cover play-only, no-op, and failure.
- Modify `src/components/FloatingControls.vue`: moon click emits sleep toggle, then starts lullaby when entering sleep.
- Modify `src/components/FloatingControls.test.ts`: entering sleep plays, already-playing does not pause, leaving sleep does not pause, play failure still enters sleep without overlay.
- Modify `src/App.test.ts`: pin overlay hidden after entering sleep.
- Do not modify `src/App.vue` (`is-overlay-visible` is already `false`).
- Do not modify `src/composables/useSleepMode.ts` or `SleepView.vue`.

---

### Task 1: Add play-only audio control

**Files:**
- Modify: `src/composables/useAudioPlayer.ts`
- Modify: `src/composables/useAudioPlayer.test.ts`

- [ ] **Step 1: Write the failing play-only tests**

In `src/composables/useAudioPlayer.test.ts`, add a play button to the harness and append these cases. Keep the existing toggle tests.

Harness template becomes:

```ts
  template: `
    <audio ref="audioElement" preload="none" />
    <button type="button" data-testid="toggle" @click="togglePlayback">toggle</button>
    <button type="button" data-testid="play" @click="play">play</button>
    <span data-testid="status">{{ status }}</span>
    <span data-testid="error">{{ errorMessage }}</span>
  `,
```

Add:

```ts
  it('starts playback without toggling a playing track off', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const wrapper = mount(Harness)

    await wrapper.get('[data-testid="play"]').trigger('click')
    await flushPromises()
    expect(play).toHaveBeenCalledOnce()
    expect(wrapper.get('[data-testid="status"]').text()).toBe('playing')

    await wrapper.get('[data-testid="play"]').trigger('click')
    await flushPromises()
    expect(play).toHaveBeenCalledOnce()
    expect(pause).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="status"]').text()).toBe('playing')
  })

  it('does not start a second play() while loading', async () => {
    let resolvePlayback!: () => void
    const playback = new Promise<void>((resolve) => {
      resolvePlayback = resolve
    })
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockReturnValue(playback)
    const wrapper = mount(Harness)

    await wrapper.get('[data-testid="play"]').trigger('click')
    expect(wrapper.get('[data-testid="status"]').text()).toBe('loading')
    await wrapper.get('[data-testid="play"]').trigger('click')
    expect(play).toHaveBeenCalledOnce()

    resolvePlayback()
    await flushPromises()
    expect(wrapper.get('[data-testid="status"]').text()).toBe('playing')
  })

  it('keeps the stable error when play() is rejected', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(
      new DOMException('Not allowed', 'NotAllowedError'),
    )
    const wrapper = mount(Harness)

    await wrapper.get('[data-testid="play"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="status"]').text()).toBe('error')
    expect(wrapper.get('[data-testid="error"]').text()).toBe('音乐暂时无法播放')
  })
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
pnpm exec vitest run src/composables/useAudioPlayer.test.ts
```

Expected: FAIL because `play` is not returned from `useAudioPlayer` (Vue warn / click no-op, then assertions on call counts fail).

- [ ] **Step 3: Implement play-only**

In `src/composables/useAudioPlayer.ts`, add `play` next to `togglePlayback`. Do not change `togglePlayback` behavior.

```ts
  const play = async () => {
    if (status.value === 'playing' || status.value === 'loading') {
      return
    }

    const audio = audioElement.value
    if (!audio) {
      handleError()
      return
    }

    status.value = 'loading'
    errorMessage.value = ''

    try {
      await audio.play()
      handlePlay()
    } catch {
      handleError()
    }
  }
```

Return it:

```ts
  return {
    status: readonly(status),
    errorMessage: readonly(errorMessage),
    play,
    togglePlayback,
  }
```

- [ ] **Step 4: Run the test to verify GREEN**

Run:

```bash
pnpm exec vitest run src/composables/useAudioPlayer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/composables/useAudioPlayer.ts src/composables/useAudioPlayer.test.ts
git commit -m "feat: add play-only audio control"
```

---

### Task 2: Start the lullaby when entering sleep

**Files:**
- Modify: `src/components/FloatingControls.vue`
- Modify: `src/components/FloatingControls.test.ts`

- [ ] **Step 1: Write the failing control tests**

Keep the existing FloatingControls tests. Append:

```ts
  it('starts the lullaby when entering sleep from a user click', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const wrapper = mount(FloatingControls, {
      props: { isSleepMode: false, isOverlayVisible: false, audioSources },
    })

    await wrapper.get('[data-testid="sleep-toggle"]').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('toggle-sleep')).toHaveLength(1)
    expect(play).toHaveBeenCalledOnce()
    expect(wrapper.get('[data-testid="music-toggle"]').classes()).toContain('is-playing')
    expect(wrapper.find('.sleep-overlay').exists()).toBe(false)
  })

  it('does not pause an already playing lullaby when entering sleep', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const wrapper = mount(FloatingControls, {
      props: { isSleepMode: false, isOverlayVisible: false, audioSources },
    })

    await wrapper.get('[data-testid="music-toggle"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="music-toggle"]').classes()).toContain('is-playing')

    await wrapper.get('[data-testid="sleep-toggle"]').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('toggle-sleep')).toHaveLength(1)
    expect(pause).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="music-toggle"]').classes()).toContain('is-playing')
  })

  it('leaves playback alone when exiting sleep', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const wrapper = mount(FloatingControls, {
      props: { isSleepMode: false, isOverlayVisible: false, audioSources },
    })

    await wrapper.get('[data-testid="music-toggle"]').trigger('click')
    await flushPromises()
    await wrapper.setProps({ isSleepMode: true })

    await wrapper.get('[data-testid="sleep-toggle"]').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('toggle-sleep')).toHaveLength(1)
    expect(pause).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="music-toggle"]').classes()).toContain('is-playing')
  })

  it('still enters sleep when lullaby playback is rejected', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new Error('blocked'))
    const wrapper = mount(FloatingControls, {
      props: { isSleepMode: false, isOverlayVisible: false, audioSources },
    })

    await wrapper.get('[data-testid="sleep-toggle"]').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('toggle-sleep')).toHaveLength(1)
    expect(wrapper.get('[role="status"]').text()).toBe('音乐暂时无法播放')
    expect(wrapper.find('.sleep-overlay').exists()).toBe(false)
  })
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
pnpm exec vitest run src/components/FloatingControls.test.ts
```

Expected: FAIL because the moon button only emits `toggle-sleep` and never calls `play()`.

- [ ] **Step 3: Wire the moon click**

In `src/components/FloatingControls.vue`:

Replace `defineProps` / `defineEmits` / audio setup with:

```ts
const props = defineProps<{
  isSleepMode: boolean
  isOverlayVisible: boolean
  audioSources: {
    aac: string
    mp3: string
  }
}>()

const emit = defineEmits<{
  'toggle-sleep': []
}>()

const audioElement = ref<HTMLAudioElement | null>(null)
const { status, errorMessage, play, togglePlayback } = useAudioPlayer(audioElement)
```

Add:

```ts
function handleSleepToggle() {
  const enteringSleep = !props.isSleepMode
  emit('toggle-sleep')
  if (enteringSleep) {
    void play()
  }
}
```

Change the moon button from `@click="$emit('toggle-sleep')"` to `@click="handleSleepToggle"`.

Leave overlay rendering unchanged (`v-if="isOverlayVisible"`). Do not pass overlay true from App.

- [ ] **Step 4: Run the test to verify GREEN**

Run:

```bash
pnpm exec vitest run src/components/FloatingControls.test.ts
```

Expected: PASS, including the existing overlay-visible unit test (that test still passes `isOverlayVisible: true` directly).

- [ ] **Step 5: Commit**

```bash
git add src/components/FloatingControls.vue src/components/FloatingControls.test.ts
git commit -m "feat: start lullaby when entering sleep"
```

---

### Task 3: Pin the public album overlay stays off

**Files:**
- Modify: `src/App.test.ts`
- Do not modify: `src/App.vue`

- [ ] **Step 1: Extend the existing sleep-mode App test**

In `src/App.test.ts`, update `applies sleep mode from the floating control` so entering sleep still works and the unused overlay stays hidden. Mock `play` so the new autoplay does not leak a media error into this composition test.

```ts
  it('applies sleep mode from the floating control', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const wrapper = mount(App)

    expect(wrapper.get('.album-app').classes()).not.toContain('is-sleeping')
    expect(wrapper.get('audio').exists()).toBe(true)

    await wrapper.get('[data-testid="sleep-toggle"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('.album-app').classes()).toContain('is-sleeping')
    expect(wrapper.get('.sleep-title').text()).toBe('嘘，宝宝睡着了... 💤')
    expect(wrapper.find('.sleep-overlay').exists()).toBe(false)
    expect(componentSource).toMatch(/:is-overlay-visible="false"/)
  })
```

- [ ] **Step 2: Run the test**

Run:

```bash
pnpm exec vitest run src/App.test.ts
```

Expected: PASS (App already passes `:is-overlay-visible="false"`). If it fails, only then change `src/App.vue` back to that exact binding — do not wire `isOverlayVisible`.

- [ ] **Step 3: Commit**

```bash
git add src/App.test.ts
git commit -m "test: keep sleep overlay unused on the album"
```

---

### Task 4: Verify the linked sleep experience

**Files:**
- None unless a command fails

- [ ] **Step 1: Run focused tests, then typecheck and lint**

```bash
pnpm exec vitest run src/components/FloatingControls.test.ts src/composables/useAudioPlayer.test.ts src/App.test.ts
pnpm typecheck
pnpm lint
```

Expected: all pass, lint with `--max-warnings=0`.

- [ ] **Step 2: Commit only if Step 1 forced extra fixes**

If typecheck or lint required edits, commit those fixes. Otherwise stop; the feature commits from Tasks 1–3 are enough.

---

## Spec coverage

| Spec | Task |
| --- | --- |
| Enter sleep emits toggle then play-only | Task 2 |
| Already playing / loading is not paused | Task 1 no-op + Task 2 |
| Leave sleep does not pause | Task 2 |
| Play failure still enters sleep, existing error copy, no overlay | Task 2 |
| Overlay stays unused in App | Task 3 |
| `play()` API on `useAudioPlayer` | Task 1 |
| Music button still toggles | existing tests kept in Tasks 1–2 |
| No SleepView / video / API changes | File map |

No placeholders. `play` is the only new method name and is used consistently.
