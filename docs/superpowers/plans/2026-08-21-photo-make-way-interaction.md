# Photo Make-Way Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enlarge a selected album photo at its original position while surrounding photos move aside responsively, accessibly, and without distorting the image.

**Architecture:** `PhotoGallery.vue` owns the active ID, measurements, GSAP timeline, global listeners, and cleanup. `PhotoCard.vue` exposes a native button and keeps the existing optimized image markup, while a new pure TypeScript helper converts stable slot rectangles into bounded desktop or mobile transforms. GSAP animates outer `.photo-slot` wrappers so the existing CSS rotation on each inner `.polaroid` remains independent.

**Tech Stack:** Vue 3 Composition API, TypeScript, GSAP Core, CSS transforms, Vitest, Vue Test Utils, happy-dom, pnpm

**Design Spec:** `docs/superpowers/specs/2026-08-21-photo-make-way-interaction-design.md`

---

## File Map

- Modify `package.json` and `pnpm-lock.yaml`: add GSAP Core as the only new runtime dependency.
- Create `src/utils/calculateMakeWayTransforms.ts`: pure layout-to-transform calculation with desktop, mobile, and edge-clamping rules.
- Create `src/utils/calculateMakeWayTransforms.test.ts`: deterministic geometry coverage without DOM animation timing.
- Modify `src/components/PhotoCard.vue`: add the outer animation slot, native trigger, selected state, and activation event.
- Modify `src/components/PhotoCard.test.ts`: preserve media assertions and cover accessible activation.
- Modify `src/components/PhotoGallery.vue`: own selection state, measurements, GSAP context/timeline, close actions, focus restoration, resize reset, and cleanup.
- Modify `src/components/PhotoGallery.test.ts`: cover selection, switching, closing, reduced motion, and lifecycle cleanup with a controlled GSAP mock.
- Modify `src/styles/global.css`: style the wrapper/trigger, selected state, hover isolation, mobile rules, and reduced-motion behavior.
- Modify `scripts/global-styles.test.ts`: protect the wrapper boundary, selected-state styling, and mobile constraints.

The original `codebase/` directory is not modified.

### Task 1: Add The GSAP Runtime Dependency

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add GSAP with pnpm**

Run:

```bash
pnpm add gsap@^3.13.0
```

Expected: `package.json` contains `"gsap": "^3.13.0"` under `dependencies`, and `pnpm-lock.yaml` records the resolved GSAP package.

- [ ] **Step 2: Verify the existing project still type-checks**

Run:

```bash
pnpm typecheck
```

Expected: exit code `0` with no TypeScript diagnostics.

- [ ] **Step 3: Commit the dependency change**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add gsap animation runtime"
```

### Task 2: Build The Pure Make-Way Geometry Helper

**Files:**
- Create: `src/utils/calculateMakeWayTransforms.test.ts`
- Create: `src/utils/calculateMakeWayTransforms.ts`

- [ ] **Step 1: Write failing geometry tests**

Create `src/utils/calculateMakeWayTransforms.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  calculateMakeWayTransforms,
  type MakeWayBounds,
  type MakeWayRect,
} from './calculateMakeWayTransforms'

const wideBounds: MakeWayBounds = {
  left: -240,
  top: -240,
  right: 1240,
  bottom: 1240,
}

describe('calculateMakeWayTransforms', () => {
  it('enlarges the selected desktop card and pushes neighbors radially outward', () => {
    const items: MakeWayRect[] = [
      { id: 'left', left: 20, top: 100, width: 280, height: 360 },
      { id: 'selected', left: 340, top: 100, width: 280, height: 360 },
      { id: 'right', left: 660, top: 100, width: 280, height: 360 },
    ]

    const result = calculateMakeWayTransforms({
      items,
      selectedId: 'selected',
      mode: 'desktop',
      bounds: wideBounds,
      selectedScale: 1.7,
    })

    expect(result.selected).toMatchObject({
      scale: 1.7,
      rotation: 0,
      zIndex: 20,
    })
    expect(result.left?.x).toBeLessThan(0)
    expect(result.right?.x).toBeGreaterThan(0)
    expect(Math.abs(result.left?.x ?? 0)).toBeLessThanOrEqual(160)
    expect(Math.abs(result.right?.x ?? 0)).toBeLessThanOrEqual(160)
    expect(Math.abs(result.left?.rotation ?? 0)).toBeLessThanOrEqual(6)
    expect(Math.abs(result.right?.rotation ?? 0)).toBeLessThanOrEqual(6)
  })

  it('corrects an enlarged edge card back inside the safe bounds', () => {
    const result = calculateMakeWayTransforms({
      items: [
        { id: 'edge', left: 0, top: 100, width: 280, height: 360 },
        { id: 'neighbor', left: 320, top: 100, width: 280, height: 360 },
      ],
      selectedId: 'edge',
      mode: 'desktop',
      bounds: { left: 0, top: 0, right: 920, bottom: 720 },
      selectedScale: 1.7,
    })

    expect(result.edge?.x).toBeCloseTo(98)
    expect(result.edge?.y).toBeCloseTo(26)
  })

  it('uses vertical-only displacement on mobile', () => {
    const items: MakeWayRect[] = [
      { id: 'above', left: 20, top: 20, width: 280, height: 360 },
      { id: 'selected', left: 20, top: 420, width: 280, height: 360 },
      { id: 'below', left: 20, top: 820, width: 280, height: 360 },
    ]

    const result = calculateMakeWayTransforms({
      items,
      selectedId: 'selected',
      mode: 'mobile',
      bounds: wideBounds,
      selectedScale: 1.08,
    })

    expect(result.selected?.scale).toBe(1.08)
    expect(result.above).toMatchObject({ x: 0, rotation: 0 })
    expect(result.below).toMatchObject({ x: 0, rotation: 0 })
    expect(result.above?.y).toBeLessThan(0)
    expect(result.below?.y).toBeGreaterThan(0)
  })

  it('enlarges a single photo without requiring neighbors', () => {
    const result = calculateMakeWayTransforms({
      items: [{ id: 'only', left: 120, top: 120, width: 280, height: 360 }],
      selectedId: 'only',
      mode: 'desktop',
      bounds: wideBounds,
      selectedScale: 1.7,
    })

    expect(result.only).toMatchObject({
      scale: 1.7,
      rotation: 0,
      zIndex: 20,
    })
  })

  it('returns idle transforms when the selected ID is absent', () => {
    const result = calculateMakeWayTransforms({
      items: [{ id: 'only', left: 20, top: 20, width: 280, height: 360 }],
      selectedId: 'missing',
      mode: 'desktop',
      bounds: wideBounds,
      selectedScale: 1.7,
    })

    expect(result.only).toEqual({
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      zIndex: 0,
    })
  })
})
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
pnpm test -- src/utils/calculateMakeWayTransforms.test.ts
```

Expected: FAIL because `./calculateMakeWayTransforms` does not exist.

- [ ] **Step 3: Implement the geometry helper**

Create `src/utils/calculateMakeWayTransforms.ts`:

```ts
export type MakeWayMode = 'desktop' | 'mobile'

export interface MakeWayRect {
  id: string
  left: number
  top: number
  width: number
  height: number
}

export interface MakeWayBounds {
  left: number
  top: number
  right: number
  bottom: number
}

export interface MakeWayTransform {
  x: number
  y: number
  scale: number
  rotation: number
  zIndex: number
}

interface CalculateMakeWayInput {
  items: readonly MakeWayRect[]
  selectedId: string
  mode: MakeWayMode
  bounds: MakeWayBounds
  selectedScale: number
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value))

function constrainToBounds(
  rect: MakeWayRect,
  x: number,
  y: number,
  scale: number,
  bounds: MakeWayBounds,
) {
  const centerX = rect.left + rect.width / 2
  const centerY = rect.top + rect.height / 2
  const halfWidth = rect.width * scale / 2
  const halfHeight = rect.height * scale / 2
  let correctedX = x
  let correctedY = y

  const projectedLeft = centerX + correctedX - halfWidth
  if (projectedLeft < bounds.left) {
    correctedX += bounds.left - projectedLeft
  }

  const projectedRight = centerX + correctedX + halfWidth
  if (projectedRight > bounds.right) {
    correctedX -= projectedRight - bounds.right
  }

  const projectedTop = centerY + correctedY - halfHeight
  if (projectedTop < bounds.top) {
    correctedY += bounds.top - projectedTop
  }

  const projectedBottom = centerY + correctedY + halfHeight
  if (projectedBottom > bounds.bottom) {
    correctedY -= projectedBottom - bounds.bottom
  }

  return { x: correctedX, y: correctedY }
}

function createIdleTransforms(items: readonly MakeWayRect[]) {
  const transforms: Record<string, MakeWayTransform> = {}

  for (const item of items) {
    transforms[item.id] = {
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      zIndex: 0,
    }
  }

  return transforms
}

export function calculateMakeWayTransforms({
  items,
  selectedId,
  mode,
  bounds,
  selectedScale,
}: CalculateMakeWayInput) {
  const transforms = createIdleTransforms(items)
  const selectedIndex = items.findIndex((item) => item.id === selectedId)
  const selected = items[selectedIndex]

  if (!selected) {
    return transforms
  }

  const selectedCenterX = selected.left + selected.width / 2
  const selectedCenterY = selected.top + selected.height / 2
  const selectedCorrection = constrainToBounds(
    selected,
    0,
    0,
    selectedScale,
    bounds,
  )

  transforms[selected.id] = {
    ...selectedCorrection,
    scale: selectedScale,
    rotation: 0,
    zIndex: 20,
  }

  items.forEach((item, index) => {
    if (item.id === selected.id) {
      return
    }

    const deltaX = item.left + item.width / 2 - selectedCenterX
    const deltaY = item.top + item.height / 2 - selectedCenterY
    const distance = Math.hypot(deltaX, deltaY)
    const fallbackDirection = index < selectedIndex ? -1 : 1
    const influenceRange = mode === 'desktop' ? 920 : 720
    const influence = clamp(1 - distance / influenceRange, 0, 1)

    let x = 0
    let y = 0
    let rotation = 0

    if (mode === 'mobile') {
      const directionY = Math.sign(deltaY) || fallbackDirection
      y = directionY * (62 + 50 * influence)
    } else {
      const safeDistance = distance || 1
      const directionX = distance ? deltaX / safeDistance : 0
      const directionY = distance ? deltaY / safeDistance : fallbackDirection
      const displacement = 48 + 112 * influence
      x = directionX * displacement
      y = directionY * displacement
      rotation = clamp(directionX * (2 + 4 * influence), -6, 6)
    }

    const correction = constrainToBounds(item, x, y, 1, bounds)
    transforms[item.id] = {
      ...correction,
      scale: 1,
      rotation,
      zIndex: 1,
    }
  })

  return transforms
}
```

- [ ] **Step 4: Run the geometry tests and verify they pass**

Run:

```bash
pnpm test -- src/utils/calculateMakeWayTransforms.test.ts
```

Expected: 1 test file passes with 5 passing tests.

- [ ] **Step 5: Commit the geometry unit**

```bash
git add src/utils/calculateMakeWayTransforms.ts src/utils/calculateMakeWayTransforms.test.ts
git commit -m "feat: calculate bounded photo make-way transforms"
```

### Task 3: Make Each Photo An Accessible Activation Target

**Files:**
- Modify: `src/components/PhotoCard.test.ts`
- Modify: `src/components/PhotoCard.vue`
- Modify: `src/styles/global.css`

- [ ] **Step 1: Extend the PhotoCard tests first**

Append this test inside the existing `describe('PhotoCard', ...)` block in `src/components/PhotoCard.test.ts`:

```ts
  it('exposes selected state and emits activation from a native button', async () => {
    const wrapper = mount(PhotoCard, {
      props: { memory, isSelected: true },
    })
    const trigger = wrapper.get('button.polaroid-trigger')

    expect(wrapper.get('.photo-slot').attributes('data-memory-id')).toBe(memory.id)
    expect(wrapper.get('.photo-slot').classes()).toContain('is-selected')
    expect(trigger.attributes()).toMatchObject({
      type: 'button',
      'aria-expanded': 'true',
      'aria-label': `查看${memory.caption}`,
    })

    await trigger.trigger('click')

    expect(wrapper.emitted('activate')).toEqual([[memory.id]])
  })
```

Update the existing transform assertion so it still reads the inner article:

```ts
    const card = wrapper.get('article.polaroid')
```

- [ ] **Step 2: Run the component test and verify it fails**

Run:

```bash
pnpm test -- src/components/PhotoCard.test.ts
```

Expected: FAIL because `.photo-slot`, `.polaroid-trigger`, `isSelected`, and the `activate` event are not implemented.

- [ ] **Step 3: Replace PhotoCard with the accessible wrapper structure**

Replace `src/components/PhotoCard.vue` with:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import type { Memory } from '../types/album'

const props = withDefaults(defineProps<{
  memory: Memory
  isSelected?: boolean
}>(), {
  isSelected: false,
})

const emit = defineEmits<{
  activate: [id: string]
}>()

const cardStyle = computed(() => ({
  '--rotation': `${props.memory.transform.rotation}deg`,
  '--offset-x': `${props.memory.transform.x}px`,
  '--offset-y': `${props.memory.transform.y}px`,
}))
</script>

<template>
  <div
    class="photo-slot"
    :class="{ 'is-selected': isSelected }"
    :data-memory-id="memory.id"
  >
    <article
      class="polaroid"
      :style="cardStyle"
    >
      <button
        type="button"
        class="polaroid-trigger"
        :aria-expanded="isSelected"
        :aria-label="`查看${memory.caption}`"
        @click="emit('activate', memory.id)"
      >
        <picture>
          <source
            type="image/avif"
            :srcset="memory.sources.avif"
            sizes="(max-width: 768px) min(90vw, 320px), 280px"
          >
          <source
            type="image/webp"
            :srcset="memory.sources.webp"
            sizes="(max-width: 768px) min(90vw, 320px), 280px"
          >
          <source
            type="image/jpeg"
            :srcset="memory.sources.jpeg"
            sizes="(max-width: 768px) min(90vw, 320px), 280px"
          >
          <img
            :src="memory.sources.fallback"
            :alt="memory.alt"
            width="960"
            height="960"
            loading="lazy"
            decoding="async"
          >
        </picture>
        <span class="caption">
          {{ memory.caption }}
        </span>
      </button>
    </article>
  </div>
</template>
```

- [ ] **Step 4: Preserve the existing gallery footprint after adding the wrapper**

In `src/styles/global.css`, add this rule immediately after `.gallery`:

```css
.photo-slot {
  position: relative;
  width: 280px;
  flex: 0 0 280px;
  transform-origin: 50% 50%;
}
```

In the existing `.polaroid` rule, replace the fixed sizing lines:

```css
  width: 280px;
  flex: 0 0 280px;
```

with:

```css
  width: 100%;
```

Add this trigger reset before `.polaroid picture`:

```css
.polaroid-trigger {
  display: block;
  width: 100%;
  padding: 0;
  color: inherit;
  background: transparent;
  cursor: zoom-in;
}
```

Add `display: block;` to the existing `.caption` rule. In the mobile media query, replace the existing `.polaroid` sizing rule with:

```css
  .photo-slot {
    width: min(100%, 320px);
    flex-basis: auto;
  }

  .polaroid {
    width: 100%;
    transform: none;
  }
```

- [ ] **Step 5: Run PhotoCard and App regression tests**

Run:

```bash
pnpm test -- src/components/PhotoCard.test.ts src/App.test.ts
```

Expected: both test files pass; App still finds 5 `.polaroid` elements and all captions.

- [ ] **Step 6: Commit the accessible card boundary**

```bash
git add src/components/PhotoCard.vue src/components/PhotoCard.test.ts src/styles/global.css
git commit -m "feat: make album photos accessible triggers"
```

### Task 4: Add Gallery Selection State And GSAP Orchestration

**Files:**
- Modify: `src/components/PhotoGallery.test.ts`
- Modify: `src/components/PhotoGallery.vue`

- [ ] **Step 1: Replace the gallery test with controlled interaction coverage**

Replace `src/components/PhotoGallery.test.ts` with:

```ts
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { Memory } from '../types/album'
import PhotoGallery from './PhotoGallery.vue'

const gsapMocks = vi.hoisted(() => {
  const timeline = {
    to: vi.fn(),
    set: vi.fn(),
    kill: vi.fn(),
  }
  timeline.to.mockReturnValue(timeline)
  timeline.set.mockReturnValue(timeline)

  return {
    timeline,
    set: vi.fn(),
    revert: vi.fn(),
  }
})

vi.mock('gsap', () => ({
  gsap: {
    context: vi.fn((callback: () => void) => {
      callback()
      return {
        add: (scopedCallback: () => void) => scopedCallback(),
        revert: gsapMocks.revert,
      }
    }),
    timeline: vi.fn(() => gsapMocks.timeline),
    set: gsapMocks.set,
  },
}))

const sourceSet = {
  avif: '/photo.avif 320w',
  webp: '/photo.webp 320w',
  jpeg: '/photo.jpg 320w',
  fallback: '/photo.jpg',
}

const memories: Memory[] = [
  {
    id: 'first',
    caption: '第一张照片',
    alt: '第一张宝宝照片',
    sources: sourceSet,
    transform: { rotation: -2, x: 0, y: 0 },
  },
  {
    id: 'second',
    caption: '第二张照片',
    alt: '第二张宝宝照片',
    sources: sourceSet,
    transform: { rotation: 2, x: 5, y: 5 },
  },
]

function createMediaQuery(matches: boolean): MediaQueryList {
  return {
    matches,
    media: '',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }
}

let reduceMotion = false

describe('PhotoGallery', () => {
  beforeEach(() => {
    reduceMotion = false
    vi.stubGlobal('matchMedia', vi.fn((query: string) =>
      createMediaQuery(query.includes('prefers-reduced-motion') && reduceMotion),
    ))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders memories in their configured order', () => {
    const wrapper = mount(PhotoGallery, { props: { memories } })

    expect(wrapper.get('section').attributes('aria-label')).toBe('成长照片墙')
    expect(wrapper.findAll('article')).toHaveLength(2)
    expect(wrapper.findAll('.caption').map((caption) => caption.text())).toEqual([
      '第一张照片',
      '第二张照片',
    ])
  })

  it('selects, switches, and toggles a photo closed', async () => {
    const wrapper = mount(PhotoGallery, { props: { memories } })
    const triggers = wrapper.findAll('.polaroid-trigger')

    await triggers[0]!.trigger('click')
    await nextTick()
    expect(wrapper.get('.gallery').classes()).toContain('has-selection')
    expect(triggers[0]!.attributes('aria-expanded')).toBe('true')

    await triggers[1]!.trigger('click')
    await nextTick()
    expect(triggers[0]!.attributes('aria-expanded')).toBe('false')
    expect(triggers[1]!.attributes('aria-expanded')).toBe('true')
    expect(gsapMocks.timeline.kill).toHaveBeenCalled()

    await triggers[1]!.trigger('click')
    expect(wrapper.get('.gallery').classes()).not.toContain('has-selection')
    expect(triggers[1]!.attributes('aria-expanded')).toBe('false')
  })

  it('closes from gallery whitespace', async () => {
    const wrapper = mount(PhotoGallery, { props: { memories } })

    await wrapper.findAll('.polaroid-trigger')[0]!.trigger('click')
    await wrapper.get('.gallery').trigger('click')

    expect(wrapper.get('.gallery').classes()).not.toContain('has-selection')
  })

  it('closes with Escape and restores focus to the selected trigger', async () => {
    const wrapper = mount(PhotoGallery, {
      props: { memories },
      attachTo: document.body,
    })
    const trigger = wrapper.findAll<HTMLButtonElement>('.polaroid-trigger')[0]!

    await trigger.trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()

    expect(wrapper.get('.gallery').classes()).not.toContain('has-selection')
    expect(document.activeElement).toBe(trigger.element)
  })

  it('uses an immediate restrained state for reduced motion', async () => {
    reduceMotion = true
    const wrapper = mount(PhotoGallery, { props: { memories } })

    await wrapper.findAll('.polaroid-trigger')[0]!.trigger('click')
    await nextTick()

    expect(gsapMocks.set).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        x: 0,
        y: 0,
        rotation: 0,
      }),
    )
    expect(gsapMocks.set.mock.calls.some(([, values]) =>
      values.scale === 1.04,
    )).toBe(true)
    expect(gsapMocks.timeline.to).not.toHaveBeenCalled()
  })

  it('resets on resize and cleans GSAP state on unmount', async () => {
    const wrapper = mount(PhotoGallery, { props: { memories } })

    await wrapper.findAll('.polaroid-trigger')[0]!.trigger('click')
    await nextTick()
    window.dispatchEvent(new Event('resize'))

    expect(wrapper.get('.gallery').classes()).not.toContain('has-selection')
    await wrapper.findAll('.polaroid-trigger')[0]!.trigger('click')
    await nextTick()
    wrapper.unmount()
    expect(gsapMocks.timeline.kill).toHaveBeenCalled()
    expect(gsapMocks.revert).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run the gallery tests and verify the interaction tests fail**

Run:

```bash
pnpm test -- src/components/PhotoGallery.test.ts
```

Expected: the original render assertion passes; the new selection and GSAP lifecycle assertions fail because `PhotoGallery.vue` has no interaction state yet.

- [ ] **Step 3: Implement gallery ownership and animation lifecycle**

Replace `src/components/PhotoGallery.vue` with:

```vue
<script setup lang="ts">
import { gsap } from 'gsap'
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Memory } from '../types/album'
import {
  calculateMakeWayTransforms,
  type MakeWayBounds,
  type MakeWayMode,
  type MakeWayRect,
} from '../utils/calculateMakeWayTransforms'
import PhotoCard from './PhotoCard.vue'

const props = defineProps<{
  memories: readonly Memory[]
}>()

const galleryRef = ref<HTMLElement | null>(null)
const selectedId = ref<string | null>(null)
let animationContext: gsap.Context | null = null
let activeTimeline: gsap.core.Timeline | null = null

function getSlots() {
  return Array.from(
    galleryRef.value?.querySelectorAll<HTMLElement>('.photo-slot') ?? [],
  )
}

function getMode(): MakeWayMode {
  return window.matchMedia?.('(max-width: 768px)').matches
    ? 'mobile'
    : 'desktop'
}

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function measureSlots(): MakeWayRect[] {
  return getSlots().flatMap((slot) => {
    const id = slot.dataset.memoryId
    if (!id) {
      return []
    }

    return [{
      id,
      left: slot.offsetLeft,
      top: slot.offsetTop,
      width: slot.offsetWidth,
      height: slot.offsetHeight,
    }]
  })
}

function getBounds(mode: MakeWayMode): MakeWayBounds {
  const gallery = galleryRef.value
  const margin = mode === 'mobile' ? 12 : 24

  return {
    left: margin,
    top: 16,
    right: Math.max(margin, (gallery?.clientWidth ?? 0) - margin),
    bottom: Math.max(16, (gallery?.clientHeight ?? 0) - 16),
  }
}

function runInContext(callback: () => void) {
  if (animationContext) {
    animationContext.add(callback)
    return
  }

  callback()
}

function killActiveTimeline() {
  activeTimeline?.kill()
  activeTimeline = null
}

function getSelectedScale(mode: MakeWayMode, selected: MakeWayRect) {
  if (mode === 'desktop') {
    return 1.7
  }

  const availableWidth = Math.max(0, (galleryRef.value?.clientWidth ?? 0) - 24)
  if (!selected.width) {
    return 1.06
  }

  return Math.min(1.16, Math.max(1.06, availableWidth / selected.width))
}

function animateSelection() {
  const currentId = selectedId.value
  if (!currentId) {
    return
  }

  const slots = getSlots()
  const items = measureSlots()
  const selected = items.find((item) => item.id === currentId)
  if (!selected) {
    closeSelection({ immediate: true })
    return
  }

  const mode = getMode()
  const transforms = calculateMakeWayTransforms({
    items,
    selectedId: currentId,
    mode,
    bounds: getBounds(mode),
    selectedScale: getSelectedScale(mode, selected),
  })

  killActiveTimeline()
  runInContext(() => {
    if (prefersReducedMotion()) {
      for (const slot of slots) {
        const isSelected = slot.dataset.memoryId === currentId
        gsap.set(slot, {
          x: 0,
          y: 0,
          scale: isSelected ? 1.04 : 1,
          rotation: 0,
          zIndex: isSelected ? 20 : 0,
        })
      }
      return
    }

    activeTimeline = gsap.timeline()
    for (const slot of slots) {
      const id = slot.dataset.memoryId ?? ''
      const transform = transforms[id]
      if (!transform) {
        continue
      }

      activeTimeline.to(slot, {
        ...transform,
        duration: id === currentId ? 0.56 : 0.68,
        ease: id === currentId ? 'power3.out' : 'back.out(1.15)',
        transformOrigin: '50% 50%',
      }, 0)
    }
  })
}

function restoreTriggerFocus(id: string) {
  void nextTick(() => {
    const slot = getSlots().find((item) => item.dataset.memoryId === id)
    slot?.querySelector<HTMLButtonElement>('.polaroid-trigger')?.focus()
  })
}

function resetSlots(immediate: boolean) {
  const slots = getSlots()
  killActiveTimeline()

  runInContext(() => {
    if (immediate || prefersReducedMotion()) {
      gsap.set(slots, { clearProps: 'transform,zIndex' })
      return
    }

    activeTimeline = gsap.timeline()
    activeTimeline
      .to(slots, {
        x: 0,
        y: 0,
        scale: 1,
        rotation: 0,
        duration: 0.38,
        ease: 'power2.out',
      }, 0)
      .set(slots, { clearProps: 'transform,zIndex' })
  })
}

function closeSelection(options: {
  restoreFocus?: boolean
  immediate?: boolean
} = {}) {
  const previousId = selectedId.value
  if (!previousId) {
    return
  }

  selectedId.value = null
  resetSlots(options.immediate ?? false)

  if (options.restoreFocus) {
    restoreTriggerFocus(previousId)
  }
}

function activatePhoto(id: string) {
  if (!props.memories.some((memory) => memory.id === id)) {
    closeSelection({ immediate: true })
    return
  }

  if (selectedId.value === id) {
    closeSelection()
    return
  }

  selectedId.value = id
  void nextTick(animateSelection)
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && selectedId.value) {
    closeSelection({ restoreFocus: true })
  }
}

function handleResize() {
  closeSelection({ immediate: true })
}

onMounted(() => {
  animationContext = gsap.context(() => {}, galleryRef.value ?? undefined)
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('resize', handleResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('resize', handleResize)
  killActiveTimeline()
  animationContext?.revert()
  animationContext = null
})
</script>

<template>
  <section
    ref="galleryRef"
    class="gallery"
    :class="{ 'has-selection': selectedId }"
    aria-label="成长照片墙"
    @click.self="closeSelection()"
  >
    <PhotoCard
      v-for="memory in memories"
      :key="memory.id"
      :memory="memory"
      :is-selected="selectedId === memory.id"
      @activate="activatePhoto"
    />
  </section>
</template>
```

- [ ] **Step 4: Run focused interaction tests**

Run:

```bash
pnpm test -- src/components/PhotoGallery.test.ts src/components/PhotoCard.test.ts
```

Expected: both test files pass with no TypeScript or runtime diagnostics.

- [ ] **Step 5: Run the complete component regression set**

Run:

```bash
pnpm test -- src/App.test.ts src/components
```

Expected: all App and component tests pass with no duplicate listeners or unmount errors.

- [ ] **Step 6: Commit the gallery interaction**

```bash
git add src/components/PhotoGallery.vue src/components/PhotoGallery.test.ts
git commit -m "feat: animate photos making way for selection"
```

### Task 5: Add Wrapper, Focus, Responsive, And Motion Styles

**Files:**
- Modify: `scripts/global-styles.test.ts`
- Modify: `src/styles/global.css`

- [ ] **Step 1: Add failing structural style assertions**

Append this test inside the existing `describe('album visual fidelity styles', ...)` block in `scripts/global-styles.test.ts`:

```ts
  it('keeps make-way transforms on a responsive outer photo slot', () => {
    expect(globalCss).toMatch(
      /\.photo-slot\s*{[^}]*width:\s*280px;[^}]*flex:\s*0 0 280px;[^}]*transform-origin:\s*50% 50%;/s,
    )
    expect(globalCss).toMatch(
      /\.gallery\.has-selection \.photo-slot\s*{[^}]*will-change:\s*transform;/s,
    )
    expect(globalCss).toMatch(
      /\.polaroid-trigger:focus-visible\s*{[^}]*outline:\s*3px solid var\(--focus-color\);/s,
    )
    expect(globalCss).toMatch(
      /\.gallery:not\(\.has-selection\) \.polaroid:hover\s*{[^}]*scale\(1\.12\);/s,
    )
    expect(globalCss).toMatch(
      /@media \(max-width: 768px\)[\s\S]*?\.photo-slot\s*{[^}]*width:\s*min\(100%, 320px\);[^}]*flex-basis:\s*auto;/s,
    )
  })
```

- [ ] **Step 2: Run the style test and verify it fails**

Run:

```bash
pnpm test -- scripts/global-styles.test.ts
```

Expected: FAIL because `.photo-slot`, `.polaroid-trigger`, and `.gallery.has-selection` rules do not exist.

- [ ] **Step 3: Move layout sizing to the wrapper and add trigger states**

Replace the existing `.gallery` through `.caption` block in `src/styles/global.css` with:

```css
.gallery {
  position: relative;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  width: min(100%, 1200px);
  margin: 0 auto;
  padding: 40px 20px;
  gap: 40px;
}

.photo-slot {
  position: relative;
  z-index: 0;
  width: 280px;
  flex: 0 0 280px;
  transform-origin: 50% 50%;
}

.gallery.has-selection .photo-slot {
  will-change: transform;
}

.polaroid {
  position: relative;
  width: 100%;
  padding: 15px 15px 30px;
  border-radius: 8px;
  background: var(--surface-color);
  box-shadow: var(--surface-shadow);
  transform: rotate(var(--rotation)) translate(var(--offset-x), var(--offset-y));
  transition:
    transform var(--transition-speed) cubic-bezier(0.175, 0.885, 0.32, 1.275),
    background-color 1s ease,
    box-shadow 1s ease;
}

.photo-slot.is-selected .polaroid {
  box-shadow: var(--raised-shadow);
}

.polaroid::before {
  position: absolute;
  z-index: 2;
  top: -10px;
  left: 50%;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: radial-gradient(circle at 30% 30%, var(--accent-soft), var(--accent-color));
  box-shadow:
    0 3px 5px rgb(0 0 0 / 20%),
    inset 0 -2px 4px rgb(0 0 0 / 20%);
  content: "";
  transform: translateX(-50%);
  transition: background 1s ease;
}

.polaroid-trigger {
  display: block;
  width: 100%;
  padding: 0;
  color: inherit;
  background: transparent;
  cursor: zoom-in;
}

.photo-slot.is-selected .polaroid-trigger {
  cursor: zoom-out;
}

.polaroid-trigger:focus-visible {
  border-radius: 4px;
  outline: 3px solid var(--focus-color);
  outline-offset: 5px;
}

.polaroid picture {
  aspect-ratio: 1;
  overflow: hidden;
  border-radius: 4px;
  background: color-mix(in srgb, var(--accent-soft) 25%, var(--surface-color));
}

.polaroid img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: filter 1.5s ease;
}

.caption {
  display: block;
  margin-top: 15px;
  color: var(--text-color);
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.4;
  text-align: center;
  transition: color 1s ease;
}
```

- [ ] **Step 4: Isolate hover and add the mobile wrapper rule**

In the fine-pointer media query, replace:

```css
  .polaroid:hover {
```

with:

```css
  .gallery:not(.has-selection) .polaroid:hover {
```

In the `@media (max-width: 768px)` block, replace the current mobile `.polaroid` sizing rule with:

```css
  .photo-slot {
    width: min(100%, 320px);
    flex-basis: auto;
  }

  .polaroid {
    width: 100%;
    transform: none;
  }
```

In the `@media (prefers-reduced-motion: reduce)` block, retain the existing inner `.polaroid` transform reset and add:

```css
  .gallery.has-selection .photo-slot {
    will-change: auto;
  }
```

- [ ] **Step 5: Run style, card, and gallery tests**

Run:

```bash
pnpm test -- scripts/global-styles.test.ts src/components/PhotoCard.test.ts src/components/PhotoGallery.test.ts
```

Expected: all three test files pass.

- [ ] **Step 6: Commit the responsive visual treatment**

```bash
git add src/styles/global.css scripts/global-styles.test.ts
git commit -m "style: polish responsive photo make-way states"
```

### Task 6: Verify Behavior, Performance, And Original Assets

**Files:**
- Verify only: all source, test, generated media, and original `codebase/` files

- [ ] **Step 1: Run the complete automated verification suite**

Run each command independently:

```bash
pnpm lint
```

```bash
pnpm typecheck
```

```bash
pnpm test
```

```bash
pnpm media:verify
```

```bash
pnpm build
```

Expected: every command exits `0`; the test report includes the new geometry tests; media verification confirms all optimized image, audio, video, and poster outputs; Vite emits a production bundle without warnings that block deployment.

- [ ] **Step 2: Confirm the original HTML reference remains untouched**

Run:

```bash
git diff --quiet main -- codebase
```

Expected: exit code `0` and no output.

- [ ] **Step 3: Start a local visual verification server**

Run:

```bash
pnpm dev --host 127.0.0.1 --port 4173
```

Expected: Vite serves the album at `http://127.0.0.1:4173/`. Keep the process running through the browser checks.

- [ ] **Step 4: Verify the desktop interaction at 1440 x 1100**

Use the in-app browser to open `http://127.0.0.1:4173/`, set the viewport to `1440 x 1100`, and check these exact states:

- click the middle photo in the first visible row: it grows near `1.7x` without leaving its grid neighborhood;
- confirm nearby cards move away in the direction of their centers and do not cover the selected caption;
- click a left or right edge card: the selected photo remains fully inspectable inside the viewport;
- click gallery whitespace, select again and press `Escape`, then select one photo and immediately select another: every route returns or switches cleanly;
- confirm image pixels remain undistorted and the sleep/music fixed controls remain usable.

Capture one idle and one selected-state screenshot for comparison.

- [ ] **Step 5: Verify the mobile interaction at 390 x 844**

With the in-app browser viewport at `390 x 844`:

- select a middle photo and confirm its width grows but remains inside the horizontal gutter;
- confirm photos above and below move only vertically, with no horizontal scatter or added rotation;
- select the final photo and confirm the enlarged card and caption are not clipped by the page bottom;
- rotate or resize the viewport and confirm the gallery resets immediately;
- emulate `prefers-reduced-motion: reduce` and confirm selection is immediate with no spring or neighbor scattering.

Capture one selected-state mobile screenshot and inspect it for overlap, clipping, and text fit.

- [ ] **Step 6: Check the final branch state**

Run:

```bash
git status --short
```

Expected: only the untracked `.superpowers/` preview workspace may appear; no production source or test file remains uncommitted.

Run:

```bash
git log --oneline -6
```

Expected: the dependency, geometry, card, gallery, and style commits appear above the approved design and plan commits.
