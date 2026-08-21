<script setup lang="ts">
import AlbumHeader from "./components/AlbumHeader.vue";
import AmbientEffects from "./components/AmbientEffects.vue";
import FloatingControls from "./components/FloatingControls.vue";
import MemoryVideo from "./components/MemoryVideo.vue";
import PhotoGallery from "./components/PhotoGallery.vue";
import SleepView from "./components/SleepView.vue";
import { useSleepMode } from "./composables/useSleepMode";
import {
  audioSources,
  memories,
  videoPosterUrl,
  videoUrl,
} from "./data/memories";

const { isSleepMode, toggleSleepMode } = useSleepMode();
</script>

<template>
  <div
    class="album-app"
    :class="{ 'is-sleeping': isSleepMode }"
  >
    <FloatingControls
      :is-sleep-mode="isSleepMode"
      :is-overlay-visible="false"
      :audio-sources="audioSources"
      style="z-index: 20"
      @toggle-sleep="toggleSleepMode"
    />
    <AmbientEffects :is-sleep-mode="isSleepMode" />

    <transition
      name="fade"
      mode="out-in"
    >
      <SleepView v-if="isSleepMode" />
      <main
        v-else
        aria-label="宝贝成长相册"
      >
        <AlbumHeader />
        <MemoryVideo
          :poster="videoPosterUrl"
          :src="videoUrl"
        />
        <PhotoGallery :memories="memories" />
      </main>
    </transition>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 1.5s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
