# Music Note Effects Design

## Goal

Add a lightweight music visualization to the fixed music control. After audio
playback actually succeeds, the control continuously releases `🎵`, `🎶`, and
`🎼` notes toward the upper left. Each note expands, rotates slightly, and fades
away. Pausing stops new notes immediately while notes already in flight finish
their animation.

## Architecture

`FloatingControls.vue` already derives `isPlaying` from the audio composable's
real `playing` state. It will pass that readonly state to a new
`useMusicNotes()` composable. This keeps effect timing and cleanup separate from
audio lifecycle code and leaves `useAudioPlayer()` unchanged.

The music button and a decorative note layer will share a fixed
`.music-control` wrapper at the current bottom-right position. Notes are sibling
elements rather than button children so the button's rotation does not rotate
their coordinate system. The button remains the only interactive element.

## State And Timing

`useMusicNotes()` owns an immutable-style array of note records. Each record
contains a unique id, one of the three approved glyphs, a negative horizontal
travel distance, a negative vertical travel distance, a final scale, a small
rotation, and a duration.

When `isPlaying` changes to true, the composable creates one note immediately
and starts a `300ms` interval. When it changes to false, the interval stops
without clearing existing records. Each note has a removal timeout matching its
animation duration, so it leaves Vue state after naturally fading out. At most
eight records are retained at once.

Native `play`, `pause`, `ended`, and `error` events already update the audio
status. Consequently the effect starts only after successful playback and stops
for button pauses, native pauses, playback completion, or errors without adding
another audio event layer.

## Motion And Layout

The note layer is fixed to the music button center and ignores pointer input.
Every note begins slightly scaled down at the center, becomes visible quickly,
then travels to a randomized upper-left endpoint while scaling up and fading to
zero. CSS custom properties carry each record's travel, rotation, scale, and
duration into one transform-and-opacity keyframe animation.

Desktop keeps the current `30px` right/bottom offset. The existing mobile
breakpoint keeps its `20px` right/bottom offset. The layer does not participate
in document layout and cannot create page overflow.

## Performance And Accessibility

Animation uses only `transform` and `opacity`, with a maximum of eight transient
nodes. All interval and removal timers are cleared on unmount. The effect is
decorative, uses `aria-hidden="true"`, and cannot receive focus or clicks.

If `prefers-reduced-motion: reduce` is active, the composable does not create
notes. If that preference becomes active during playback, generation stops and
active notes are cleared immediately. Returning to normal motion restarts note
generation only when audio is still playing.

## Error Handling

Rejected playback never reaches `playing`, so it creates no notes. A missing
audio element and native media errors follow the same stable audio error state
already exposed to assistive technology. The effect itself performs no media
operations and cannot alter playback.

## Testing

- Deterministic composable tests use fake timers and an injected random source.
- Tests verify immediate emission, the `300ms` cadence, approved glyphs,
  upper-left travel, and the eight-note bound.
- Pause tests verify that no new notes appear while existing notes remain until
  their individual duration expires.
- Tests verify reduced-motion changes and all timer/listener cleanup.
- `FloatingControls` integration tests verify that successful playback exposes
  the decorative layer and a second click stops further emission.
- Existing audio, sleep-mode, application, lint, type-check, and build checks
  must remain green, and `codebase/` must remain unchanged.
