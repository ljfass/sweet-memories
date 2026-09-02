<script setup lang="ts">
import AlbumHeader from "./components/AlbumHeader.vue";
import AmbientEffects from "./components/AmbientEffects.vue";
import FloatingControls from "./components/FloatingControls.vue";
import MemoryVideo from "./components/MemoryVideo.vue";
import PhotoGallery from "./components/PhotoGallery.vue";
import SleepView from "./components/SleepView.vue";
import { useSleepMode } from "./composables/useSleepMode";
import { usePublicMemories } from "./composables/usePublicMemories";
import {
  audioSources,
  videoPosterUrl,
  videoUrl,
} from "./data/memories";

const { isSleepMode, toggleSleepMode } = useSleepMode();
const { memories, status: photoStatus, retry: retryPhotos } = usePublicMemories();
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
        <section
          class="public-album"
          :class="`is-${photoStatus}`"
          :aria-busy="photoStatus === 'loading'"
          aria-label="成长照片"
        >
          <div
            v-if="photoStatus !== 'ready'"
            class="album-load-state"
            role="status"
            aria-live="polite"
          >
            <span v-if="photoStatus === 'loading'">照片正在加载</span>
            <template v-else>
              <span>照片暂时无法加载</span>
              <button
                class="album-retry"
                type="button"
                @click="retryPhotos"
              >
                重试
              </button>
            </template>
          </div>
          <PhotoGallery :memories="memories" />
        </section>
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

.public-album {
  position: relative;
  min-height: 780px;
}

.album-load-state {
  position: absolute;
  z-index: 3;
  top: 56px;
  left: 50%;
  display: flex;
  align-items: center;
  min-height: 44px;
  color: var(--muted-color);
  font-weight: 700;
  gap: 12px;
  transform: translateX(-50%);
}

.album-retry {
  min-width: 68px;
  min-height: 40px;
  padding: 7px 16px;
  border: 2px solid var(--border-color);
  border-radius: 8px;
  background: var(--surface-color);
  box-shadow: 0 3px 10px rgb(71 50 57 / 10%);
  cursor: pointer;
  font-weight: 700;
}

.album-retry:focus-visible {
  outline: 3px solid var(--focus-color);
  outline-offset: 3px;
}

@media (max-width: 960px) {
  .public-album {
    min-height: 1120px;
  }
}

@media (max-width: 768px) {
  .public-album {
    min-height: 1960px;
  }
}
</style>
