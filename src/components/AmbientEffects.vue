<script setup lang="ts">
import { toRef, type CSSProperties } from 'vue'
import {
  useAmbientEffects,
  type ClickEffect,
  type FallingEffect,
} from '../composables/useAmbientEffects'

const props = defineProps<{
  isSleepMode: boolean
}>()

const { clickEffects, fallingEffects } = useAmbientEffects(toRef(props, 'isSleepMode'))

const clickStyle = (effect: ClickEffect): CSSProperties => ({
  left: `${effect.x - 15}px`,
  top: `${effect.y - 15}px`,
  '--rotation': `${effect.rotation}deg`,
})

const fallingStyle = (effect: FallingEffect): CSSProperties => ({
  left: `${effect.x}vw`,
  fontSize: `${effect.size}px`,
  '--fall-duration': `${effect.duration}s`,
})
</script>

<template>
  <div
    class="ambient-effects"
    aria-hidden="true"
  >
    <span
      v-for="effect in clickEffects"
      :key="`click-${effect.id}`"
      class="click-effect"
      :style="clickStyle(effect)"
    >
      {{ effect.glyph }}
    </span>
    <span
      v-for="effect in fallingEffects"
      :key="`fall-${effect.id}`"
      class="falling-effect"
      :style="fallingStyle(effect)"
    >
      {{ effect.glyph }}
    </span>
  </div>
</template>
