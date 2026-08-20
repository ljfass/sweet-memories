<script setup lang="ts">
import { LoaderCircle, Music2 } from '@lucide/vue'
import { computed, ref, type CSSProperties } from 'vue'
import { useAudioPlayer } from '../composables/useAudioPlayer'
import { useMusicNotes, type MusicNote } from '../composables/useMusicNotes'

defineProps<{
  isSleepMode: boolean
  isOverlayVisible: boolean
  audioSources: {
    aac: string
    mp3: string
  }
}>()

defineEmits<{
  'toggle-sleep': []
}>()

const audioElement = ref<HTMLAudioElement | null>(null)
const { status, errorMessage, togglePlayback } = useAudioPlayer(audioElement)
const isPlaying = computed(() => status.value === 'playing')
const isLoading = computed(() => status.value === 'loading')
const { notes } = useMusicNotes(isPlaying)
const noteStyle = (note: MusicNote): CSSProperties => ({
  '--note-x': `${note.travelX}px`,
  '--note-y': `${note.travelY}px`,
  '--note-scale': note.scale,
  '--note-rotation': `${note.rotation}deg`,
  '--note-duration': `${note.durationMs}ms`,
})
const musicLabel = computed(() => {
  if (isPlaying.value) return '暂停背景音乐'
  if (isLoading.value) return '正在加载背景音乐'
  return '播放背景音乐'
})
</script>

<template>
  <div class="floating-controls">
    <button
      class="icon-button sleep-toggle"
      type="button"
      data-testid="sleep-toggle"
      :aria-label="isSleepMode ? '退出哄睡模式' : '开启哄睡模式'"
      :title="isSleepMode ? '退出哄睡模式' : '开启哄睡模式'"
      :aria-pressed="isSleepMode"
      @click="$emit('toggle-sleep')"
    >
      <span
        class="sleep-icon"
        aria-hidden="true"
      >
        {{ isSleepMode ? '☀️' : '🌙' }}
      </span>
    </button>

    <div class="music-control">
      <div
        class="music-notes"
        aria-hidden="true"
      >
        <span
          v-for="note in notes"
          :key="note.id"
          class="music-note"
          :style="noteStyle(note)"
        >
          {{ note.glyph }}
        </span>
      </div>

      <button
        class="icon-button music-btn"
        :class="{ 'is-playing': isPlaying, 'is-loading': isLoading }"
        type="button"
        data-testid="music-toggle"
        :aria-label="musicLabel"
        :title="musicLabel"
        :aria-pressed="isPlaying"
        @click="togglePlayback"
      >
        <LoaderCircle
          v-if="isLoading"
          aria-hidden="true"
        />
        <Music2
          v-else
          aria-hidden="true"
        />
      </button>
    </div>

    <audio
      ref="audioElement"
      loop
      preload="none"
    >
      <source
        :src="audioSources.aac"
        type="audio/mp4"
      >
      <source
        :src="audioSources.mp3"
        type="audio/mpeg"
      >
    </audio>

    <p
      v-if="isOverlayVisible"
      class="sleep-overlay"
      role="status"
    >
      嘘，宝宝睡着了... 💤
    </p>
    <p
      v-if="errorMessage"
      class="sr-only"
      role="status"
    >
      {{ errorMessage }}
    </p>
  </div>
</template>
