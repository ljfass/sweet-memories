# Vue 3 Baby Album Refactor Design

## Context

The repository currently contains a single static implementation in
`codebase/index.html` plus six JPEG images, one MP3 file, and one MP4 file under
`codebase/assets/`. The page provides a live age counter, a native video player,
five polaroid-style memory cards, background music, day/sleep themes, click
emojis, and ambient falling decorations.

The repository root is not yet an application. The refactor will create a Vue 3
+ TypeScript project at the root while keeping `codebase/` intact as the original
reference and the sole source of full-quality media.

## Goals

- Preserve the current copy, content order, visual character, and user-facing
  interactions.
- Replace direct DOM manipulation with typed Vue components, data, and
  composables.
- Minimize initial network cost and avoid layout shifts caused by media.
- Produce a static Vite build that can be hosted from a domain root or a
  subdirectory.
- Add focused automated coverage for calculations and interactive behavior.
- Use `pnpm` for dependency management and every project command.

## Non-Goals

- Redesigning the album or adding new album-management features.
- Adding routing, server-side rendering, an API, authentication, Pinia, or a UI
  component framework.
- Modifying, moving, or deleting anything under `codebase/`.
- Loading the original multi-megabyte photos in the production page.

## Application Architecture

The repository root will contain a standard Vite Vue 3 TypeScript application.
`App.vue` will compose the page and own the shared sleep-mode state. No router or
global store is needed for a single view with one shared boolean state.

The implementation will use these responsibility boundaries:

- `src/App.vue`: page composition and shared theme state.
- `src/components/AlbumHeader.vue`: title, subtitle, and age-counter placement.
- `src/components/AgeCounter.vue`: live presentation of typed age parts.
- `src/components/MemoryVideo.vue`: optimized poster and native video controls.
- `src/components/PhotoGallery.vue`: gallery structure and typed memory list.
- `src/components/PhotoCard.vue`: one responsive polaroid photo and caption.
- `src/components/FloatingControls.vue`: accessible sleep and music controls.
- `src/components/AmbientEffects.vue`: bounded click and falling decorations.
- `src/composables/useAgeCounter.ts`: one-second updates and timer cleanup.
- `src/composables/useAudioPlayer.ts`: audio lifecycle and playback state.
- `src/composables/useSleepMode.ts`: theme state and three-second overlay.
- `src/composables/useAmbientEffects.ts`: effect creation, bounds, and cleanup.
- `src/utils/calculateAge.ts`: pure calendar-age calculation.
- `src/data/memories.ts`: typed captions, alt text, media imports, and transforms.
- `src/styles/`: reset, theme tokens, global layout, and reduced-motion rules.

Component props and emitted events will form the public boundaries. Components
will not query arbitrary DOM nodes or mutate `document.body` classes.

## Visual Fidelity

The production page will retain the warm dotted background, pink type, white
polaroid cards, push-pin decoration, slightly rotated frames, native video
controls, fixed music and sleep controls, dark sleep palette, and existing
Chinese copy. Layout improvements are limited to preventing overflow, keeping
fixed controls clear of content, and making hover effects appropriate for both
mouse and touch input.

Controls will use semantic `button` elements and Lucide Moon, Sun, and Music
icons while preserving their circular shape, location, and purpose. Focus-visible
styles, section landmarks, accurate image alt text, and live status semantics
will be added without introducing explanatory UI copy.

## State And Data Flow

`App.vue` will create the sleep-mode state and pass it to components that need a
visual variant. The state is intentionally not persisted; a refresh starts in
day mode like the original page.

The birth timestamp remains `2025-10-09T08:55:00` in the browser's local time.
`calculateAge()` will return completed calendar years plus days, hours, minutes,
and seconds since the most recent birthday. Future timestamps return zero for
every part. `useAgeCounter()` updates immediately, ticks once per second, and
clears its interval on unmount.

Sleep mode changes the palette and shows the existing sleep message for three
seconds. Repeated toggles replace the previous timeout, and unmounting clears it.
It does not persist state or silently change media playback.

`useAudioPlayer()` exposes `idle`, `loading`, `playing`, and `error` states. It
starts loading only after a user activates the control, handles rejected
`HTMLMediaElement.play()` promises, and keeps the button state synchronized with
native play, pause, ended, and error events. Failures are reported through an
accessible status instead of the current incorrect path alert.

Photo records are immutable typed data. Each record includes its caption, useful
alt text, responsive source URLs, intrinsic dimensions, and desktop transform.
The rendering components contain no hard-coded list items.

Ambient decorations are transient typed records rendered by Vue. Click effects
ignore interactive elements. Falling effects have a fixed upper bound so an
inactive tab or long session cannot grow the DOM indefinitely. All timers are
cleaned up, and decorative motion is disabled when
`prefers-reduced-motion: reduce` is active.

## Media Pipeline

Full-quality source media remains under `codebase/assets/`. A reproducible
`scripts/optimize-media.mjs` command reads those files and writes committed
delivery assets to `src/assets/generated/`. Vite imports these files so the
production build emits content-hashed URLs. Normal builds use the committed
outputs and do not repeat media conversion.

Sharp will generate each gallery photo as a center-cropped square at 320, 640,
and 960 pixels in AVIF, WebP, and optimized JPEG. This matches the existing
`object-fit: cover` framing. Generated files omit EXIF and other unused metadata.
`PhotoCard.vue` will render AVIF and WebP sources plus JPEG fallback with `srcset`,
`sizes`, explicit dimensions, lazy loading, and asynchronous decoding.

The portrait video poster will be rendered into a lightweight 16:9 frame that
matches the existing contained presentation. The video uses `preload="none"`, so
the MP4 is not requested during initial page load.

The 79-second 320kbps MP3 will be converted to AAC-LC at 128kbps for normal
playback, with the original MP3 copied as a compatibility fallback. The audio
element also uses `preload="none"` and begins downloading only after user intent.

The media script will inspect the MP4 and create a fast-start H.264/AAC candidate
with a maximum 1280-by-720 bounding box and visually conservative quality. It
will use the candidate only when it is smaller than the compatible source;
otherwise it will retain the current 2.9MB media. Conversion uses local
development dependencies for reproducibility and never changes the source file.

`scripts/verify-media.mjs` will fail when required variants are missing, empty,
have incorrect dimensions or formats, or exceed the documented delivery size
budgets. Production output must not copy the `codebase/` directory.

## Styling And Accessibility

CSS custom properties will define the day and sleep palettes, surface colors,
shadows, and motion timing. Stable dimensions and aspect ratios will prevent
loading and interaction states from moving the layout. Font sizes will use
fixed responsive breakpoints rather than viewport-scaled type.

Animations will primarily use transforms and opacity. The reduced-motion media
query disables ambient decoration, continuous music-button rotation, entrance
bounces, and large hover transforms. Interactive controls have accessible names,
pressed state where applicable, keyboard focus indicators, and a minimum usable
touch target. Decorative icons are hidden from assistive technology.

## Error Handling

- A future birth date produces zeros rather than a negative duration.
- Audio play rejection or media failure returns the control to a stable state and
  exposes a concise accessible error.
- All intervals and timeouts are cleared on component unmount.
- Generated-asset omissions fail media verification and the production build
  instead of shipping broken URLs.
- Native video controls retain their browser-provided loading and playback error
  behavior.

## Testing And Verification

Vitest and Vue Test Utils will cover:

- Calendar-age boundaries, including a future date and a birthday transition.
- Immediate counter rendering, one-second updates, and interval cleanup.
- Sleep-mode toggling, icon labels, overlay timeout replacement, and cleanup.
- Photo records, captions, alt text, responsive sources, and lazy-loading hints.
- Audio success, rejection, native pause/play synchronization, and error state.
- Effect exclusion for interactive targets, upper bounds, cleanup, and reduced
  motion behavior.

Browser-only media methods will receive the smallest necessary test substitutes;
other assertions will exercise real components and DOM events.

The project exposes `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
`pnpm media:build`, and `pnpm media:verify`. Completion requires all six commands
to pass. A final local-server check will cover desktop and mobile widths,
horizontal overflow, keyboard operation, day/sleep presentation, audio/video
request timing, and reduced motion. If automated browser control remains
unavailable, that visual automation gap will be reported explicitly.

## Acceptance Criteria

- The root project builds as Vue 3 + TypeScript using `pnpm`.
- The original `codebase/` directory and every file inside it remain present and
  unchanged.
- All existing content and core interactions remain available.
- Gallery photos use responsive generated sources rather than original JPEGs.
- Audio and video are not requested on initial page load.
- Type checking, linting, unit/component tests, media verification, and the
  production build pass without warnings or errors.
- The built output excludes original source media and works at responsive desktop
  and mobile widths without incoherent overlap or horizontal scrolling.
