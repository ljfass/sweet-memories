<script setup lang="ts">
import { gsap } from 'gsap'
import { onMounted, onUnmounted, ref } from 'vue'
import { useBabyConfig } from '../composables/useBabyConfig'
import AgeCounter from './AgeCounter.vue'

const { birthDate } = useBabyConfig()

const headerRef = ref<HTMLElement | null>(null)
const titleText = '宝贝的快乐时光'
const titleChars = Array.from(titleText)
let animationContext: gsap.Context | null = null

function handleCharHover(event: MouseEvent) {
  const target = event.currentTarget
  if (!(target instanceof HTMLElement)) return
  gsap.to(target, {
    scale: 1.18,
    y: -8,
    rotation: (Math.random() - 0.5) * 10,
    duration: 0.25,
    ease: 'back.out(2.5)',
    overwrite: 'auto',
  })
}

function handleCharLeave(event: MouseEvent) {
  const target = event.currentTarget
  if (!(target instanceof HTMLElement)) return
  gsap.to(target, {
    scale: 1,
    y: 0,
    rotation: 0,
    duration: 0.35,
    ease: 'back.out(1.8)',
    overwrite: 'auto',
  })
}

onMounted(() => {
  const prefersReducedMotion = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (prefersReducedMotion) return

  animationContext = gsap.context(() => {
    const chars = gsap.utils.toArray<HTMLElement>('.title-char')
    if (chars.length === 0) return

    // 入场：Q 弹错峰弹跳入场 (Playful Pop-in)
    const tl = gsap.timeline({
      delay: 0.15,
      onComplete: () => {
        // 入场后：轻柔的待机呼吸微浮 (Gentle idle floating wave)
        gsap.to(chars, {
          y: -4,
          rotation: (index) => (index % 2 === 0 ? 1.5 : -1.5),
          duration: 1.8,
          ease: 'sine.inOut',
          repeat: -1,
          yoyo: true,
          stagger: {
            each: 0.12,
            repeat: -1,
            yoyo: true,
          },
        })
      },
    })

    tl.from(chars, {
      opacity: 0,
      scale: 0.4,
      y: -35,
      rotation: (index) => (index % 2 === 0 ? -12 : 12),
      duration: 0.65,
      ease: 'back.out(2.2)',
      stagger: 0.08,
    })
  }, headerRef.value ?? undefined)
})

onUnmounted(() => {
  animationContext?.revert()
})
</script>

<template>
  <header
    ref="headerRef"
    class="album-header"
  >
    <h1>
      <span
        v-for="(char, index) in titleChars"
        :key="index"
        class="title-char"
        @mouseenter="handleCharHover"
        @mouseleave="handleCharLeave"
      >{{ char }}</span>
    </h1>
    <p class="subtitle">
      记录成长的每一个心动瞬间 👶✨
    </p>
    <AgeCounter :birth-date="birthDate" />
  </header>
</template>

<style scoped>
.title-char {
  display: inline-block;
  cursor: pointer;
  will-change: transform, opacity;
  transform-origin: center bottom;
  user-select: none;
}
</style>
