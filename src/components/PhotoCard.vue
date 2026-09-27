<script setup lang="ts">
import { computed } from 'vue'
import { useBabyConfig } from '../composables/useBabyConfig'
import type { Memory } from '../types/album'
import { calculateMonthAge, formatMonthAge } from '../utils/calculateMonthAge'

const props = withDefaults(defineProps<{
  memory: Memory
  isSelected?: boolean
}>(), {
  isSelected: false,
})

const emit = defineEmits<{
  activate: [id: string]
}>()

const { birthDate } = useBabyConfig()

const cardStyle = computed(() => ({
  '--rotation': `${props.memory.transform.rotation}deg`,
  '--offset-x': `${props.memory.transform.x}px`,
  '--offset-y': `${props.memory.transform.y}px`,
}))

const ageLabel = computed(() =>
  formatMonthAge(calculateMonthAge(birthDate, props.memory.capturedDate)),
)
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
            sizes="(max-width: 768px) min(90vw, 340px), 440px"
          >
          <source
            type="image/webp"
            :srcset="memory.sources.webp"
            sizes="(max-width: 768px) min(90vw, 340px), 440px"
          >
          <source
            type="image/jpeg"
            :srcset="memory.sources.jpeg"
            sizes="(max-width: 768px) min(90vw, 340px), 440px"
          >
          <img
            :src="memory.sources.fallback"
            :alt="memory.alt"
            :width="memory.sources.width ?? 960"
            :height="memory.sources.height ?? 960"
            loading="lazy"
            decoding="async"
          >
        </picture>
        <span class="caption">
          {{ memory.caption }}
        </span>
      </button>
      <time
        v-if="ageLabel"
        class="photo-age"
        :datetime="memory.capturedDate"
      >
        <span class="sr-only">拍摄时宝宝</span>{{ ageLabel }}
      </time>
    </article>
  </div>
</template>
