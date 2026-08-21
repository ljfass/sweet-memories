# Photo Make-Way Interaction Design

## Goal

Add a focused photo-viewing interaction to the Vue album gallery. Clicking a photo enlarges it at its current position while nearby photos move outward to make room. The result should feel like the physical photo wall is rearranging itself, not like opening a modal or applying a detached visual effect.

The original `codebase/` remains unchanged.

## Approved Interaction

- Clicking a photo selects it and enlarges it in place.
- Neighboring photos move radially away from the selected photo on desktop.
- The selected photo keeps its visual identity, configured tilt, caption, and pushpin treatment.
- Clicking the selected photo again, clicking an empty area of the gallery, or pressing `Escape` restores the gallery.
- Clicking another photo transitions directly to the new selection.
- The selected photo remains anchored near its original grid position. It does not jump to the viewport center.
- Photos close to a viewport or gallery edge receive a small inward correction so the enlarged photo is not clipped or pushed into the section heading.

## Component Architecture

`PhotoGallery.vue` owns the active photo ID, gallery-level pointer and keyboard behavior, geometry measurement, and the GSAP animation lifecycle.

`PhotoCard.vue` remains responsible for rendering the optimized picture sources and caption. It gains:

- an `isSelected` prop;
- an `activate` event carrying the memory ID;
- a real button trigger with `aria-expanded` and an accessible name;
- an outer `.photo-slot` wrapper used exclusively for make-way transforms.

The existing `.polaroid` stays inside `.photo-slot`. Its configured rotation and offset continue to be applied by CSS, while GSAP animates the wrapper. This prevents the new animation from overwriting the card's existing transforms and hover styling.

A pure TypeScript geometry helper calculates selected and neighbor transforms. Keeping the calculations outside the components makes the behavior deterministic and directly testable.

## Geometry And Motion

The gallery measures each slot from its stable layout position using `offsetLeft`, `offsetTop`, `offsetWidth`, and `offsetHeight`. It does not use already transformed screen coordinates when switching selections.

On desktop:

- selected scale: approximately `1.7`;
- neighbor movement: radial, weighted by distance, with a practical maximum around `160px`;
- neighbor rotation: subtle and capped at approximately `6deg`;
- easing: a restrained spring-like settle rather than a strong bounce;
- selected translation: normally zero, except for edge correction;
- edge clearance: approximately `24px` from the viewport sides and a protected gap below the gallery heading.

The selected slot is raised above its neighbors with `z-index`. The shadow can deepen slightly during focus, but the photo pixels are not warped, refracted, blurred, or replaced by a shader effect.

Only wrapper transforms and visual shadow changes animate. Layout measurements are batched once per activation before writes begin.

## Responsive Behavior

At the mobile breakpoint, the gallery remains a vertical column:

- the selected photo expands near the available content width at its current vertical position;
- horizontal displacement and extra rotation are disabled;
- photos above and below move vertically away from the selected item;
- movement distance and elasticity are reduced;
- the expanded photo is clamped inside the content gutter.

On resize or orientation change while a photo is active, the gallery resets immediately. This avoids stale geometry and prevents transformed cards from being measured as a new base layout.

## State And Cleanup

The gallery has two states: idle and one active memory ID. A new selection replaces the previous ID; multiple cards cannot remain active.

GSAP is created after mount inside `gsap.context()` scoped to the gallery. Any running timeline is killed before a replacement animation starts. The context is reverted on component unmount so transforms, listeners, and inline styles do not leak across navigation or hot reload.

Hover enlargement is disabled while the gallery has an active selection so it cannot compete with the make-way transform.

## Accessibility

- Each photo uses a native button trigger and remains keyboard reachable.
- `Enter` and `Space` activate through native button behavior.
- `Escape` closes the active view and returns focus to the selected photo trigger.
- `aria-expanded` reflects the selected state.
- The current image `alt` text and captions remain unchanged.
- With `prefers-reduced-motion: reduce`, state changes are immediate or use a minimal opacity/shadow cue; cards do not spring or scatter.

## Performance And Dependencies

Use GSAP Core only. Three.js, WebGL, image displacement shaders, and additional physics libraries are out of scope because the approved effect is a DOM layout transition and does not need pixel-level rendering.

The implementation will:

- animate transform-friendly properties;
- avoid layout reads inside animation frames;
- reuse one coordinated timeline per state transition;
- clean up all animation state on unmount;
- retain existing lazy image loading and AVIF/WebP/JPEG source selection;
- avoid changing the existing audio and video asset strategy.

## Edge Cases

- Rapid repeated clicks cancel the current timeline before starting the next one.
- An unknown or missing card ID resets the gallery without throwing.
- A single-photo gallery enlarges the photo without attempting neighbor movement.
- Edge cards favor keeping the selected image visible over preserving a perfectly zero translation.
- The gallery retains sufficient bottom space so an enlarged last-row photo does not appear cut off by the page boundary.

## Testing And Acceptance

Unit tests cover:

- radial displacement direction and distance limits;
- desktop edge correction;
- mobile vertical-only movement;
- selection, switching, toggle-close, blank-area close, and `Escape` close;
- `aria-expanded` and focus restoration;
- reduced-motion behavior;
- animation cleanup on unmount.

Existing photo source, caption, gallery order, lint, type-check, and production-build checks must continue to pass.

Visual verification covers desktop and mobile viewports with real album photos. Acceptance requires that the selected photo visibly grows in place, neighbors make room without incoherent overlap, edge photos remain inspectable, and the mobile layout stays within its horizontal gutter.

## Out Of Scope

- modal or lightbox navigation;
- image zoom/pan controls;
- ripple, refraction, glass, or shader distortion;
- changing photo content, captions, ordering, or media assets;
- modifying or deleting `codebase/`.
