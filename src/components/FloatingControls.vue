<script setup lang="ts">
import { LoaderCircle, Music2 } from '@lucide/vue'
import { computed, ref, type CSSProperties } from 'vue'
import { useAudioPlayer } from '../composables/useAudioPlayer'
import { useMusicNotes, type MusicNote } from '../composables/useMusicNotes'

const props = defineProps<{
  isSleepMode: boolean
  isOverlayVisible: boolean
  audioSources: {
    aac: string
    mp3: string
  }
}>()

const emit = defineEmits<{
  'toggle-sleep': []
}>()

const audioElement = ref<HTMLAudioElement | null>(null)
const { status, errorMessage, play, togglePlayback } = useAudioPlayer(audioElement)
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

function playSwitchSound(isEnteringSleep: boolean) {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return
    const ctx = new AudioCtx()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    const now = ctx.currentTime

    // 1. 机械微动瞬间高频瞬态撞击 (Click transient)
    const bufferSize = Math.floor(ctx.sampleRate * 0.02)
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.003))
    }
    const noise = ctx.createBufferSource()
    noise.buffer = buffer

    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.setValueAtTime(isEnteringSleep ? 1600 : 2200, now)
    filter.Q.setValueAtTime(2.5, now)

    const noiseGain = ctx.createGain()
    noiseGain.gain.setValueAtTime(0.35, now)
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.02)

    noise.connect(filter)
    filter.connect(noiseGain)
    noiseGain.connect(ctx.destination)

    // 2. 翘板弹簧跳变低频共振 (Mechanical snap resonance)
    const osc = ctx.createOscillator()
    const oscGain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(isEnteringSleep ? 240 : 360, now)
    osc.frequency.exponentialRampToValueAtTime(isEnteringSleep ? 70 : 110, now + 0.035)

    oscGain.gain.setValueAtTime(0.4, now)
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.04)

    osc.connect(oscGain)
    oscGain.connect(ctx.destination)

    noise.start(now)
    osc.start(now)
    osc.stop(now + 0.05)
    noise.stop(now + 0.05)

    setTimeout(() => {
      void ctx.close()
    }, 120)
  } catch {
    // 忽略不受支持的浏览器或受限环境
  }
}

function handleSleepToggle() {
  const enteringSleep = !props.isSleepMode
  playSwitchSound(enteringSleep)
  emit('toggle-sleep')
  if (enteringSleep) {
    void play()
  }
}
</script>

<template>
  <div class="floating-controls">
    <button
      class="icon-button sleep-toggle wall-switch"
      :class="{ 'is-switched-off': isSleepMode, 'is-switched-on': !isSleepMode }"
      type="button"
      data-testid="sleep-toggle"
      :aria-label="isSleepMode ? '退出哄睡模式' : '开启哄睡模式'"
      :title="isSleepMode ? '退出哄睡模式' : '开启哄睡模式'"
      :aria-pressed="isSleepMode"
      @click="handleSleepToggle"
    >
      <span
        class="switch-inner-socket"
        aria-hidden="true"
      >
        <span class="switch-rocker-key">
          <span class="rocker-indicator" />
          <span class="rocker-thickness" />
        </span>
      </span>
      <span
        class="sr-only sleep-icon"
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
