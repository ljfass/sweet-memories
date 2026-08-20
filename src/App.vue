<script setup lang="ts">
import AlbumHeader from './components/AlbumHeader.vue'
import AmbientEffects from './components/AmbientEffects.vue'
import FloatingControls from './components/FloatingControls.vue'
import MemoryVideo from './components/MemoryVideo.vue'
import PhotoGallery from './components/PhotoGallery.vue'
import { useSleepMode } from './composables/useSleepMode'
import {
  audioSources,
  memories,
  videoPosterUrl,
  videoUrl,
} from './data/memories'

const { isSleepMode, isOverlayVisible, toggleSleepMode } = useSleepMode()
</script>

<template>
  <div
    class="album-app"
    :class="{ 'is-sleeping': isSleepMode }"
  >
    <FloatingControls
      :is-sleep-mode="isSleepMode"
      :is-overlay-visible="isOverlayVisible"
      :audio-sources="audioSources"
      @toggle-sleep="toggleSleepMode"
    />
    <AmbientEffects :is-sleep-mode="isSleepMode" />

    <main aria-label="宝贝成长相册">
      <AlbumHeader />
      <MemoryVideo
        :poster="videoPosterUrl"
        :src="videoUrl"
      />
      <PhotoGallery :memories="memories" />
    </main>
  </div>
</template>
