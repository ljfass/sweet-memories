<script setup lang="ts">
import type { Memory } from '../types/album'
import PhotoCard from './PhotoCard.vue'

defineProps<{
  memories: readonly Memory[]
}>()
</script>

<template>
  <section
    class="gallery"
    aria-label="成长照片墙"
  >
    <PhotoCard
      v-for="memory in memories"
      :key="memory.id"
      :memory="memory"
    />
  </section>
</template>
