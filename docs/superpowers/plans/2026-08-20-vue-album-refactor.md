# Vue 3 Baby Album Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rootless static baby-album page with a production-ready Vue 3 + TypeScript application while preserving `codebase/` and delivering optimized, deferred media.

**Architecture:** A Vite single-page application composes small Vue components around typed memory data and focused composables. Original media remains under `codebase/`; a reproducible Sharp/FFmpeg pipeline writes hashed build inputs to `src/assets/generated/`. Vitest and Vue Test Utils cover pure logic and user-visible state transitions before each implementation step.

**Tech Stack:** pnpm, Vue 3, TypeScript, Vite, Lucide Vue Next, Vitest, Vue Test Utils, happy-dom, ESLint, Sharp, ffmpeg-static, ffprobe-static

---

## File Map

- Root tooling: `package.json`, `pnpm-lock.yaml`, `vite.config.ts`, `tsconfig*.json`, `eslint.config.js`, `.gitignore`, `index.html`.
- App entry and shell: `src/main.ts`, `src/App.vue`, `src/env.d.ts`.
- Components: `src/components/{AlbumHeader,AgeCounter,MemoryVideo,PhotoGallery,PhotoCard,FloatingControls,AmbientEffects}.vue`.
- Composables: `src/composables/{useAgeCounter,useAudioPlayer,useSleepMode,useAmbientEffects}.ts`.
- Domain code: `src/types/album.ts`, `src/utils/calculateAge.ts`, `src/data/memories.ts`.
- Styling: `src/styles/{reset,theme,global}.css`.
- Media tools: `scripts/{media-config,optimize-media,verify-media}.mjs`.
- Tests: colocated `*.test.ts` files plus `tests/setup.ts`.
- Generated delivery assets: `src/assets/generated/`; originals remain unchanged in `codebase/assets/`.

### Task 1: Bootstrap The Typed Vue Toolchain

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `index.html`
- Create: `vite.config.ts`
- Create: `tsconfig.json`
- Create: `tsconfig.app.json`
- Create: `tsconfig.node.json`
- Create: `eslint.config.js`
- Create: `tests/setup.ts`
- Create: `src/env.d.ts`
- Create: `src/App.test.ts`
- Create: `src/App.vue`
- Create: `src/main.ts`

- [ ] **Step 1: Create package metadata and install dependencies with pnpm**

Create `package.json`:

```json
{
  "name": "sweet-memories",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "packageManager": "pnpm@8.6.1",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "vue-tsc --noEmit -p tsconfig.app.json",
    "lint": "eslint . --max-warnings=0",
    "test": "vitest run",
    "test:watch": "vitest",
    "media:build": "node scripts/optimize-media.mjs",
    "media:verify": "node scripts/verify-media.mjs"
  }
}
```

Run:

```bash
pnpm add vue lucide-vue-next
pnpm add -D @eslint/js @types/node @vitejs/plugin-vue @vue/test-utils eslint eslint-plugin-vue ffmpeg-static ffprobe-static globals happy-dom sharp typescript typescript-eslint vite vitest vue-tsc
```

Expected: `pnpm-lock.yaml` is created and both commands exit 0.

- [ ] **Step 2: Create strict build, test, lint, and ignore configuration**

Create `.gitignore`:

```gitignore
.DS_Store
node_modules/
dist/
coverage/
*.local
```

Create `vite.config.ts`:

```ts
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  base: './',
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    setupFiles: ['./tests/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
})
```

Create `tsconfig.json`:

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ]
}
```

Create `tsconfig.app.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "jsx": "preserve",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client", "vitest/globals"],
    "skipLibCheck": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  },
  "include": ["src/**/*.ts", "src/**/*.vue", "tests/**/*.ts"]
}
```

Create `tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": true,
    "types": ["node"],
    "skipLibCheck": true
  },
  "include": ["vite.config.ts", "eslint.config.js"]
}
```

Create `eslint.config.js`:

```js
import eslint from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'src/assets/generated/**', 'codebase/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['src/**/*.{ts,vue}', 'tests/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['scripts/**/*.mjs', '*.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
      },
    },
    rules: {
      'vue/multi-word-component-names': 'off',
    },
  },
)
```

Create `tests/setup.ts`:

```ts
import { enableAutoUnmount } from '@vue/test-utils'
import { afterEach } from 'vitest'

enableAutoUnmount(afterEach)
```

Create `src/env.d.ts`:

```ts
/// <reference types="vite/client" />
```

Create `index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#fffaf0" />
    <title>宝贝的成长相册</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Write the failing application smoke test**

Create `src/App.test.ts`:

```ts
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import App from './App.vue'

describe('App', () => {
  it('renders the baby album landmark and title', () => {
    const wrapper = mount(App)

    expect(wrapper.get('main').attributes('aria-label')).toBe('宝贝成长相册')
    expect(wrapper.get('h1').text()).toBe('宝贝的快乐时光')
  })
})
```

- [ ] **Step 4: Run the smoke test and verify RED**

Run: `pnpm test src/App.test.ts`

Expected: FAIL because `src/App.vue` does not exist.

- [ ] **Step 5: Add the minimal application shell**

Create `src/App.vue`:

```vue
<template>
  <main aria-label="宝贝成长相册">
    <h1>宝贝的快乐时光</h1>
  </main>
</template>
```

Create `src/main.ts`:

```ts
import { createApp } from 'vue'
import App from './App.vue'

createApp(App).mount('#app')
```

- [ ] **Step 6: Verify GREEN and commit**

Run: `pnpm test src/App.test.ts`

Expected: PASS.

Run: `pnpm typecheck`

Expected: PASS.

Commit:

```bash
git add .gitignore package.json pnpm-lock.yaml index.html vite.config.ts tsconfig*.json eslint.config.js tests src
git commit -m "chore: bootstrap Vue TypeScript app"
```

### Task 2: Implement Calendar Age As A Tested Domain Unit

**Files:**
- Create: `src/types/album.ts`
- Create: `src/utils/calculateAge.test.ts`
- Create: `src/utils/calculateAge.ts`
- Create: `src/composables/useAgeCounter.test.ts`
- Create: `src/composables/useAgeCounter.ts`
- Create: `src/components/AgeCounter.vue`
- Create: `src/components/AlbumHeader.vue`

- [ ] **Step 1: Write failing calendar-age tests**

Create `src/utils/calculateAge.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { calculateAge } from './calculateAge'

describe('calculateAge', () => {
  it('returns zero parts for a future birth date', () => {
    expect(calculateAge(new Date('2030-01-01T00:00:00'), new Date('2026-01-01T00:00:00'))).toEqual({
      years: 0,
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
    })
  })

  it('uses completed calendar years and elapsed time since the anniversary', () => {
    expect(calculateAge(new Date('2025-10-09T08:55:00'), new Date('2026-10-10T10:57:03'))).toEqual({
      years: 1,
      days: 1,
      hours: 2,
      minutes: 2,
      seconds: 3,
    })
  })

  it('increments years exactly on the birthday timestamp', () => {
    expect(calculateAge(new Date('2020-10-09T08:55:00'), new Date('2026-10-09T08:55:00')).years).toBe(6)
  })
})
```

- [ ] **Step 2: Verify RED**

Run: `pnpm test src/utils/calculateAge.test.ts`

Expected: FAIL because `calculateAge` is missing.

- [ ] **Step 3: Implement the pure calculation**

Add `AgeParts` to `src/types/album.ts` and implement `calculateAge()` in
`src/utils/calculateAge.ts`. Use a clamped calendar anniversary, return zeros for
invalid/future input, then split the remaining milliseconds using integer day,
hour, minute, and second units. Export a frozen zero value and return fresh
objects so callers cannot mutate shared state.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm test src/utils/calculateAge.test.ts`

Expected: 3 tests PASS.

- [ ] **Step 5: Write a failing composable/component timer test**

Create `src/composables/useAgeCounter.test.ts` with a small harness component
that calls `useAgeCounter(new Date('2025-10-09T08:55:00'))`. Use fake timers and
`vi.setSystemTime()` to assert immediate rendering, a one-second increment, and
`vi.getTimerCount() === 0` after unmount.

- [ ] **Step 6: Verify RED, implement, and verify GREEN**

Run: `pnpm test src/composables/useAgeCounter.test.ts`

Expected: FAIL because the composable is missing.

Implement `useAgeCounter()` with a readonly `ref`, immediate calculation,
`window.setInterval(update, 1000)`, and `onScopeDispose(clearInterval)`. Create
`AgeCounter.vue` to render the five values with the existing Chinese copy and
`AlbumHeader.vue` to render the title, subtitle, and counter.

Run: `pnpm test src/utils/calculateAge.test.ts src/composables/useAgeCounter.test.ts`

Expected: all tests PASS and no timers remain.

- [ ] **Step 7: Commit**

```bash
git add src/types src/utils src/composables/useAgeCounter* src/components/AgeCounter.vue src/components/AlbumHeader.vue
git commit -m "feat: add typed live age counter"
```

### Task 3: Build Typed Responsive Photo Components

**Files:**
- Modify: `src/types/album.ts`
- Create: `src/components/PhotoCard.test.ts`
- Create: `src/components/PhotoCard.vue`
- Create: `src/components/PhotoGallery.test.ts`
- Create: `src/components/PhotoGallery.vue`

- [ ] **Step 1: Define the desired typed rendering contract in a failing test**

Add `ResponsiveImageSources` and `Memory` types to `src/types/album.ts`, then
create `src/components/PhotoCard.test.ts` with this fixture:

```ts
const memory = {
  id: 'newborn',
  caption: '刚出生的时候 🍼',
  alt: '刚出生时安静躺着的宝宝',
  sources: {
    avif: '/photo-1-320.avif 320w, /photo-1-640.avif 640w, /photo-1-960.avif 960w',
    webp: '/photo-1-320.webp 320w, /photo-1-640.webp 640w, /photo-1-960.webp 960w',
    jpeg: '/photo-1-320.jpg 320w, /photo-1-640.jpg 640w, /photo-1-960.jpg 960w',
    fallback: '/photo-1-640.jpg',
  },
  transform: { rotation: -5, x: 0, y: 10 },
} as const
```

Assert that `PhotoCard` renders AVIF/WebP/JPEG `<source>` elements, a lazy and
async 960-by-960 `<img>` with the exact alt text, the caption, and CSS custom
properties `--rotation`, `--offset-x`, and `--offset-y`.

- [ ] **Step 2: Verify RED, implement PhotoCard, and verify GREEN**

Run: `pnpm test src/components/PhotoCard.test.ts`

Expected: FAIL because `PhotoCard.vue` is missing.

Implement `PhotoCard.vue` as an `<article class="polaroid">` with a `<picture>`
and semantic `<p class="caption">`. Use `type="image/avif"`,
`type="image/webp"`, JPEG fallback, `sizes="(max-width: 768px) min(90vw, 320px), 280px"`,
and a typed style object for transforms.

Run: `pnpm test src/components/PhotoCard.test.ts`

Expected: PASS.

- [ ] **Step 3: Test and implement PhotoGallery**

Create `PhotoGallery.test.ts` with two fixture records. Assert one labelled
`<section>`, two articles, preserved order, and both captions. Verify RED, then
implement `PhotoGallery.vue` as a pure `v-for` over a readonly `memories` prop,
using `memory.id` as the key.

Run: `pnpm test src/components/PhotoGallery.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/types/album.ts src/components/PhotoCard* src/components/PhotoGallery*
git commit -m "feat: add responsive photo gallery components"
```

### Task 4: Implement Sleep Mode And Accessible Floating Controls

**Files:**
- Create: `src/composables/useSleepMode.test.ts`
- Create: `src/composables/useSleepMode.ts`
- Create: `src/components/FloatingControls.test.ts`
- Create: `src/components/FloatingControls.vue`

- [ ] **Step 1: Write failing sleep-state tests**

Create `useSleepMode.test.ts` with a harness. Assert initial day mode, toggle to
sleep mode, overlay visibility for 2999ms, overlay hidden at 3000ms, a second
toggle replacing the previous timeout, and zero timers after unmount.

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run: `pnpm test src/composables/useSleepMode.test.ts`

Expected: FAIL because `useSleepMode` is missing.

Implement refs for `isSleepMode` and `isOverlayVisible`, one stored timeout,
`toggleSleepMode()`, and `onScopeDispose()` cleanup. Toggling back to day mode
hides the overlay immediately.

Run: `pnpm test src/composables/useSleepMode.test.ts`

Expected: PASS.

- [ ] **Step 3: Write the final control contract before implementation**

Create `FloatingControls.test.ts`. Mount with typed AAC/MP3 URLs and assert:

- the sleep button emits `toggle-sleep` and swaps Moon/Sun accessible labels;
- `aria-pressed` matches the sleep state;
- the music button exists with an idle label;
- the three-second overlay uses `role="status"` only while visible;
- both controls are real buttons with `type="button"`.

- [ ] **Step 4: Verify RED, implement the visual control shell, and verify GREEN**

Run: `pnpm test src/components/FloatingControls.test.ts`

Expected: FAIL because the component is missing.

Implement the final props (`isSleepMode`, `isOverlayVisible`, `audioSources`) and
the `toggle-sleep` emit. Use Lucide `Moon`, `Sun`, `Music2`, and `LoaderCircle`.
Leave audio behavior delegated to `useAudioPlayer`, which is added test-first in
Task 5.

Run: `pnpm test src/components/FloatingControls.test.ts`

Expected: sleep-control assertions PASS.

- [ ] **Step 5: Commit**

```bash
git add src/composables/useSleepMode* src/components/FloatingControls*
git commit -m "feat: add accessible sleep controls"
```

### Task 5: Add Deferred Audio Playback With Stable Error States

**Files:**
- Create: `src/composables/useAudioPlayer.test.ts`
- Create: `src/composables/useAudioPlayer.ts`
- Modify: `src/components/FloatingControls.test.ts`
- Modify: `src/components/FloatingControls.vue`

- [ ] **Step 1: Write failing audio-state tests**

Create `useAudioPlayer.test.ts` with a harness containing a real `<audio
preload="none">`. Substitute only `play()` and `pause()`. Assert:

- `toggle()` moves `idle -> loading -> playing` after resolved play;
- rejected play produces `error` and the concise message `音乐暂时无法播放`;
- native `pause`, `play`, and `error` events synchronize state;
- a second toggle while playing calls `pause()`.

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run: `pnpm test src/composables/useAudioPlayer.test.ts`

Expected: FAIL because `useAudioPlayer` is missing.

Implement `useAudioPlayer(audioElement)` with readonly status/error refs,
`togglePlayback()`, native event listeners registered after mount and removed on
unmount, plus promise rejection handling. Do not preload or autoplay.

Run: `pnpm test src/composables/useAudioPlayer.test.ts`

Expected: PASS.

- [ ] **Step 3: Integrate the composable into FloatingControls test-first**

Extend `FloatingControls.test.ts` to assert `<audio loop preload="none">`, AAC
before MP3 source order, button loading/playing classes, `aria-pressed`, and the
screen-reader error status.

Run: `pnpm test src/components/FloatingControls.test.ts`

Expected: FAIL on missing audio integration.

Add the hidden audio element, template ref, sources, and `useAudioPlayer()`
bindings. The music button calls `togglePlayback()` and updates its label between
`播放背景音乐`, `正在加载背景音乐`, and `暂停背景音乐`.

Run: `pnpm test src/components/FloatingControls.test.ts src/composables/useAudioPlayer.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/composables/useAudioPlayer* src/components/FloatingControls*
git commit -m "feat: add deferred background audio"
```

### Task 6: Replace Imperative Decorations With Bounded Vue State

**Files:**
- Create: `src/composables/useAmbientEffects.test.ts`
- Create: `src/composables/useAmbientEffects.ts`
- Create: `src/components/AmbientEffects.vue`

- [ ] **Step 1: Write failing bounded-effect tests**

Create a harness around `useAmbientEffects(isSleepMode, { random, fallIntervalMs })`.
Stub `matchMedia` in `tests/setup.ts`. Assert that:

- clicking the document background adds a daytime click effect;
- clicking a button, video, or `.polaroid` adds none;
- sleep mode uses a night symbol set;
- click records never exceed 12 and falling records never exceed 10;
- reduced-motion mode creates neither kind of effect;
- unmount removes the document listener and all timers.

- [ ] **Step 2: Verify RED**

Run: `pnpm test src/composables/useAmbientEffects.test.ts`

Expected: FAIL because the composable is missing.

- [ ] **Step 3: Implement the composable and component**

Implement typed effect records containing id, glyph, x, y, rotation, size, and
duration. Register one document click listener, maintain bounded arrays, expire
clicks after 1000ms, spawn falls every 800ms, and remove falls after their own
duration. Observe `matchMedia('(prefers-reduced-motion: reduce)')` changes and
stop/restart the falling interval accordingly.

Create `AmbientEffects.vue` to render fixed, pointer-events-none decorative spans
with inline CSS variables. Give the container `aria-hidden="true"`.

- [ ] **Step 4: Verify GREEN and commit**

Run: `pnpm test src/composables/useAmbientEffects.test.ts`

Expected: PASS with no leaked timers.

```bash
git add tests/setup.ts src/composables/useAmbientEffects* src/components/AmbientEffects.vue
git commit -m "feat: add bounded ambient effects"
```

### Task 7: Build And Verify Optimized Media

**Files:**
- Create: `scripts/media-config.mjs`
- Create: `scripts/media-config.test.ts`
- Create: `scripts/verify-media.mjs`
- Create: `scripts/optimize-media.mjs`
- Create: `src/assets/generated/*`

- [ ] **Step 1: Write a failing media-contract test**

Create `media-config.mjs` exports only after writing `media-config.test.ts`.
The test must require five photo ids, widths `[320, 640, 960]`, formats
`['avif', 'webp', 'jpg']`, one 1280-by-720 JPEG poster, AAC/MP3 audio outputs,
and one MP4 output. Assert all generated names are unique.

Run: `pnpm test scripts/media-config.test.ts`

Expected: FAIL because the config module is missing.

- [ ] **Step 2: Implement the manifest and verify GREEN**

Create `scripts/media-config.mjs` with absolute paths derived from
`import.meta.url`, explicit quality values (AVIF 62, WebP 78, JPEG 82), and size
budgets: 400KB per 960px AVIF, 550KB per 960px WebP, 700KB per 960px JPEG,
400KB poster, 1.6MB AAC, 3.5MB MP3 fallback, and 3.2MB MP4.

Run: `pnpm test scripts/media-config.test.ts`

Expected: PASS.

- [ ] **Step 3: Create the verifier first and observe missing-output failure**

Implement `verify-media.mjs` to use Sharp metadata for image format/dimensions,
`stat()` for every budget, and ffprobe JSON for H.264 video plus AAC-or-MP3
audio compatibility. Aggregate errors, print each once, and set exit code 1.

Run: `pnpm media:verify`

Expected: FAIL listing missing files under `src/assets/generated/`.

- [ ] **Step 4: Implement deterministic optimization**

Implement `optimize-media.mjs` with `spawn()` argument arrays, not shell strings:

- call `sharp(input).rotate().resize(width, width, { fit: 'cover', position: 'centre' })` for all 45 photo variants;
- create a black-contained 1280-by-720 JPEG poster from `7777.jpg`;
- strip metadata by never calling `withMetadata()`;
- encode AAC-LC 128kbps with `ffmpeg-static` and copy the MP3 fallback;
- create a fast-start remux plus a CRF 23 H.264/AAC candidate bounded to
  1280-by-720, selecting the smaller valid output;
- overwrite only named files in `src/assets/generated/` and remove temporary
  candidates after comparison;
- finish by invoking `verify-media.mjs` and propagate its exit status.

- [ ] **Step 5: Generate and verify media**

Run: `pnpm media:build`

Expected: exit 0 and create 45 photo files, one poster, two audio files, and one
video file without changing hashes under `codebase/`.

Run: `pnpm media:verify`

Expected: PASS with a concise file-count and total-size summary.

Run: `git diff --exit-code -- codebase`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts src/assets/generated
git commit -m "feat: add optimized media pipeline"
```

### Task 8: Connect Typed Media Data And Compose The Page

**Files:**
- Create: `src/data/memories.test.ts`
- Create: `src/data/memories.ts`
- Create: `src/components/MemoryVideo.test.ts`
- Create: `src/components/MemoryVideo.vue`
- Modify: `src/App.test.ts`
- Modify: `src/App.vue`

- [ ] **Step 1: Write the failing memory-data test**

Assert exactly five records in the original order, exact existing captions,
useful non-generic alt text, three widths in every source set, unique ids, and
the original transform values. Assert exported poster, video, AAC, and MP3 URLs
are non-empty hashed-input URLs.

Run: `pnpm test src/data/memories.test.ts`

Expected: FAIL because `memories.ts` is missing.

- [ ] **Step 2: Implement typed asset discovery and data**

Use eager `import.meta.glob<string>('../assets/generated/*', {
query: '?url', import: 'default' })`. Add an `asset(filename)` helper that throws
for missing entries, a `srcset(photoId, extension)` helper, the five exact
captions and transform values, descriptive Chinese alt text, and exported media
URLs. Freeze the exported memory array.

Run: `pnpm test src/data/memories.test.ts`

Expected: PASS.

- [ ] **Step 3: Test and implement MemoryVideo**

Write a component test asserting the existing heading, `controls`,
`preload="none"`, optimized poster, MP4 source type, and fallback text. Verify
RED, then implement a labelled `<section>` containing the existing tilted video
frame and native `<video>`.

Run: `pnpm test src/components/MemoryVideo.test.ts`

Expected: PASS.

- [ ] **Step 4: Expand App integration test before composition**

Update `App.test.ts` to assert the header, age counter, video section, five photo
cards, both fixed controls, ambient container, and sleep class after activating
the sleep button.

Run: `pnpm test src/App.test.ts`

Expected: FAIL because the shell has not composed these units.

- [ ] **Step 5: Compose the final page and verify GREEN**

In `App.vue`, call `useSleepMode()`, render `FloatingControls`,
`AmbientEffects`, and a `<main>` containing `AlbumHeader`, `MemoryVideo`, and
`PhotoGallery`. Pass generated media URLs and the immutable memories. Toggle
`is-sleeping` on the root `.album-app`; do not mutate `document.body`.

Run: `pnpm test src/App.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/data src/components/MemoryVideo* src/App*
git commit -m "feat: compose the Vue baby album"
```

### Task 9: Restore The Existing Visual System Responsively

**Files:**
- Create: `src/styles/reset.css`
- Create: `src/styles/theme.css`
- Create: `src/styles/global.css`
- Modify: `src/main.ts`
- Modify: component scoped styles in `src/components/*.vue`
- Modify: `src/App.test.ts`

- [ ] **Step 1: Lock required layout hooks in a failing integration test**

Add assertions for `.album-app`, `.album-header`, `.video-section`, `.gallery`,
`.polaroid`, `.floating-controls`, `.sleep-overlay`, and `.ambient-effects`.

Run: `pnpm test src/App.test.ts`

Expected: FAIL for any missing class contract.

- [ ] **Step 2: Add exact theme and global rules**

Create reset rules for border-box sizing, zero margins, inherited controls, and
responsive media. Create CSS variables for the existing warm day palette and
dark sleep palette. Port the current dotted background, header bounce, counter,
16:9 tilted video frame, REC/PAUSED decoration, 280px polaroids, push pins,
fixed circular controls, three-second overlay, click float, falling decorations,
and mobile breakpoint.

Use these constraints while porting:

- cards remain at or below 8px radius and never nest inside other cards;
- all fixed controls have 48px minimum hit areas and visible focus rings;
- animations use transform/opacity, and hover transforms apply only under
  `(hover: hover) and (pointer: fine)`;
- `prefers-reduced-motion: reduce` disables bounce, blink, spin, fall, click
  float, and large transforms;
- type sizes use rem values and breakpoints, never viewport-width scaling;
- letter spacing remains `0`;
- `.album-app` owns the full-viewport background and theme transition;
- mobile widths have no forced rotation or horizontal overflow.

Import reset, theme, and global CSS from `src/main.ts`. Keep component-specific
selectors scoped inside their Vue files.

- [ ] **Step 3: Verify component contracts and static quality**

Run: `pnpm test`

Expected: all tests PASS.

Run: `pnpm lint`

Expected: PASS with zero warnings.

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/styles src/components src/main.ts src/App.test.ts
git commit -m "style: restore responsive album presentation"
```

### Task 10: Production Verification And Handoff

**Files:**
- Modify only files required by failures found in this task

- [ ] **Step 1: Run the complete automated gate**

Run each command independently:

```bash
pnpm media:verify
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: every command exits 0 with no warnings or unhandled errors.

- [ ] **Step 2: Verify build boundaries and preserved originals**

Run:

```bash
git diff --exit-code -- codebase
find dist -maxdepth 4 -type f -print
du -sh dist
```

Expected: `codebase/` has no changes; `dist/` contains hashed optimized media and
does not contain a `codebase/` directory or any original full-resolution JPEG.

- [ ] **Step 3: Start the development server and inspect the real page**

Run: `pnpm dev --host 127.0.0.1`

Expected: Vite prints a working local URL. Keep the server running for user
review. Check 1440x900, 768x1024, and 390x844 viewports; day/sleep modes; keyboard
focus; the three-second overlay; music success/pause; video controls; click
effects; and reduced-motion behavior. Confirm the network panel does not request
AAC, MP3, or MP4 before user activation.

- [ ] **Step 4: Re-run the automated gate after visual fixes**

Run `pnpm media:verify`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
`pnpm build` as independent commands.

Expected: every command exits 0.

- [ ] **Step 5: Commit the verified result**

```bash
git add .
git commit -m "chore: verify Vue album production build"
```

- [ ] **Step 6: Report the handoff**

Provide the local URL, test/build results, optimized-versus-original media size
summary, the unchanged `codebase/` status, and any browser automation gap that
could not be closed.
