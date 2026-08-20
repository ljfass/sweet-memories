<script setup lang="ts">
import { Moon, Music2, Sun } from '@lucide/vue'

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
      <Sun v-if="isSleepMode" aria-hidden="true" />
      <Moon v-else aria-hidden="true" />
    </button>

    <button
      class="icon-button music-btn"
      type="button"
      data-testid="music-toggle"
      aria-label="播放背景音乐"
      title="播放背景音乐"
      aria-pressed="false"
    >
      <Music2 aria-hidden="true" />
    </button>

    <p v-if="isOverlayVisible" class="sleep-overlay" role="status">
      嘘，宝宝睡着了... 💤
    </p>
  </div>
</template>
