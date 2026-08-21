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
