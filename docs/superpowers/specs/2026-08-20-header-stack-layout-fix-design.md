# Header Stack Layout Fix Design

## Goal

Display the album subtitle and live age counter as two vertically stacked,
horizontally centered information blocks, matching the user's second reference
image at desktop and mobile widths.

## Scope

The existing `AlbumHeader.vue` structure, copy, component boundaries, spacing,
colors, and behavior remain unchanged. The fix only changes the shared CSS rule
that currently allows `.subtitle` and `.age-counter` to sit on the same line.

## Layout

Both elements will become block-level, content-width boxes with a maximum width
of their header container and automatic inline margins. The age counter retains
its existing top margin, creating the intended vertical gap. Existing mobile
rules continue to reduce padding and font size without changing the stacked
relationship.

## Verification

- A focused source-level regression test will assert that the shared rule uses
  block layout and automatic horizontal margins.
- Existing component and application tests must remain green.
- Type checking, linting, and the production build must pass.
- The original `codebase/` directory must remain unchanged.
