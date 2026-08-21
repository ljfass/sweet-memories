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
        overwrite: 'auto',
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
        overwrite: 'auto',
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
