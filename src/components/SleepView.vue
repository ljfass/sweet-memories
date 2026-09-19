<script setup lang="ts">
import { onMounted, ref } from "vue";
import sleepImageUrl from "../assets/generated/sleeping.jpg";

const stars = ref<
  Array<{
    id: number;
    top: string;
    left: string;
    size: string;
    duration: string;
    delay: string;
    opacity: number;
  }>
>([]);

onMounted(() => {
  const generatedStars = [];
  for (let i = 0; i < 150; i++) {
    generatedStars.push({
      id: i,
      top: `${Math.random() * 100}%`,
      left: `${Math.random() * 100}%`,
      size: `${Math.random() * 2 + 1}px`,
      duration: `${Math.random() * 3 + 2}s`,
      delay: `${Math.random() * 3}s`,
      opacity: Math.random() * 0.7 + 0.3,
    });
  }
  stars.value = generatedStars;
});
</script>

<template>
  <div
    class="sleep-view"
    aria-label="睡眠模式"
  >
    <div
      class="stars-container"
      aria-hidden="true"
    >
      <div
        v-for="star in stars"
        :key="star.id"
        class="star"
        :style="{
          top: star.top,
          left: star.left,
          width: star.size,
          height: star.size,
          opacity: star.opacity,
          '--twinkle-duration': star.duration,
          '--twinkle-delay': star.delay,
        }"
      />
    </div>

    <div class="sleep-content">
      <div class="moon-frame">
        <picture class="sleep-picture">
          <img
            :src="sleepImageUrl"
            alt="安静熟睡的宝宝"
            class="sleep-image"
          >
        </picture>
      </div>

      <div class="sleep-typography">
        <p class="sleep-title">
          嘘，宝宝睡着了... 💤
        </p>
        <p class="sleep-subtitle">
          Good night, sweet dreams
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sleep-view {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: radial-gradient(ellipse at 50% 38%, #1b2438 0%, #0b1220 55%, #070b14 100%);
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.stars-container {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.star {
  position: absolute;
  background-color: #fff;
  border-radius: 50%;
  box-shadow: 0 0 4px 1px rgba(255, 255, 255, 0.4);
  animation: twinkle var(--twinkle-duration) ease-in-out infinite alternate;
  animation-delay: var(--twinkle-delay);
}

@keyframes twinkle {
  0% {
    transform: scale(0.8);
    opacity: 0.2;
  }
  100% {
    transform: scale(1.2);
    opacity: 1;
  }
}

.sleep-content {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 28px;
  animation: settle-in 1.4s ease both;
}

@keyframes settle-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.moon-frame {
  position: relative;
  width: min(72vw, 340px);
  height: min(72vw, 340px);
  border-radius: 50%;
  padding: 7px;
  background:
    radial-gradient(circle at 32% 28%, rgb(255 248 230 / 55%), transparent 42%),
    rgb(255 248 230 / 8%);
  box-shadow:
    0 0 0 1px rgb(255 236 205 / 10%),
    0 0 28px rgb(245 214 160 / 12%),
    0 18px 48px rgb(0 0 0 / 42%);
  animation: moonlight 6.5s ease-in-out infinite;
}

.moon-frame::after {
  content: "";
  position: absolute;
  inset: 10%;
  border-radius: 50%;
  pointer-events: none;
  box-shadow: 0 0 36px 10px rgb(245 214 160 / 8%);
  animation: moonlight-halo 6.5s ease-in-out infinite;
}

@keyframes moonlight {
  0%,
  100% {
    box-shadow:
      0 0 0 1px rgb(255 236 205 / 8%),
      0 0 22px rgb(245 214 160 / 10%),
      0 18px 48px rgb(0 0 0 / 42%);
  }
  50% {
    box-shadow:
      0 0 0 1px rgb(255 248 230 / 55%),
      0 0 48px rgb(255 228 180 / 55%),
      0 0 96px rgb(245 214 160 / 38%),
      0 18px 48px rgb(0 0 0 / 42%);
  }
}

@keyframes moonlight-halo {
  0%,
  100% {
    opacity: 0.35;
    box-shadow: 0 0 28px 8px rgb(245 214 160 / 6%);
  }
  50% {
    opacity: 1;
    box-shadow: 0 0 72px 28px rgb(255 228 180 / 28%);
  }
}

.sleep-picture {
  display: block;
  border-radius: 50%;
  overflow: hidden;
  background-color: #1a2238;
  width: 100%;
  height: 100%;
}

.sleep-image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: 28% 42%;
  filter: saturate(0.92) contrast(0.98);
}

.sleep-typography {
  text-align: center;
  color: #d7cfc3;
  text-shadow: 0 1px 12px rgb(0 0 0 / 45%);
}

.sleep-title {
  margin: 0 0 8px;
  color: #f4efe6;
  font-size: 1.15rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  line-height: 1.5;
}

.sleep-subtitle {
  margin: 0;
  color: #9a9084;
  font-size: 0.82rem;
  font-weight: 400;
  letter-spacing: 0.12em;
}

@media (prefers-reduced-motion: reduce) {
  .star {
    animation: none;
  }
  .sleep-content {
    animation: none;
    transform: none;
  }
  .moon-frame {
    animation: none;
  }
}
</style>
