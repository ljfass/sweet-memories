<script setup lang="ts">
import { computed } from 'vue'
import type { Memory } from '../types/album'

const props = defineProps<{
  memory: Memory
}>()

const cardStyle = computed(() => ({
  '--rotation': `${props.memory.transform.rotation}deg`,
  '--offset-x': `${props.memory.transform.x}px`,
  '--offset-y': `${props.memory.transform.y}px`,
}))
</script>

<template>
  <article
    class="polaroid"
    :style="cardStyle"
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
    <p class="caption">
      {{ memory.caption }}
    </p>
  </article>
</template>
