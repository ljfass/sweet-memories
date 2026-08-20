# Album Layout Detail Fixes Design

## Goal

Display the album subtitle and live age counter as two vertically stacked,
horizontally centered information blocks, matching the user's second reference
image at desktop and mobile widths. Restore the video-frame recording indicator
to the `REC 🔴` presentation shown in the user's second reference image. Match
the sleep control's dimensions and translucent surface to the original page.

## Scope

The existing Vue structure, copy, component boundaries, spacing, colors, and
behavior remain unchanged. The fix only changes the shared CSS rule that
currently allows `.subtitle` and `.age-counter` to sit on the same line, the
video-frame pseudo-element's recording-indicator content, and the sleep button's
visual presentation. The sleep button keeps its semantic button element,
accessible state, and existing fixed position.

## Layout

Both elements will become block-level, content-width boxes with a maximum width
of their header container and automatic inline margins. The age counter retains
its existing top margin, creating the intended vertical gap. Existing mobile
rules continue to reduce padding and font size without changing the stacked
relationship.

## Recording Indicator

The day-mode video frame will display `REC 🔴`, using the full red-circle emoji
instead of the current small text glyph. Its existing bottom-center placement,
font size, blink animation, and sleep-mode `PAUSED` replacement remain unchanged.

## Sleep Control

The desktop sleep control will match the original `55px` circular button and
`35px` emoji footprint, with the original 60%-opaque white day surface. At the
existing mobile breakpoint it will retain the original `45px` button and `28px`
emoji footprint. Day mode displays the original `🌙` command and sleep mode
displays the original `☀️` command. Sleep mode uses the original 80%-opaque dark
surface. The current keyboard focus indicator, accessible label, and pressed
state remain intact.

## Verification

- A focused source-level regression test will assert that the shared rule uses
  block layout and automatic horizontal margins, and that the video indicator
  uses the expected `REC 🔴` content. It will also lock the sleep control's
  desktop/mobile dimensions and day/sleep surface opacity to the original values.
- Existing component and application tests must remain green.
- Type checking, linting, and the production build must pass.
- The original `codebase/` directory must remain unchanged.
