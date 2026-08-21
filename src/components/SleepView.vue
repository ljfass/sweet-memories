<script setup lang="ts">
import { onMounted, ref } from "vue";
import sleepImageUrl from "../assets/generated/sleeping.jpg";

// Generate random stars for the background
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
      <div class="breathing-frame">
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
  background: linear-gradient(135deg, #050b14 0%, #0a1128 50%, #151b30 100%);
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
  gap: 40px;
  animation: float 6s ease-in-out infinite;
}

@keyframes float {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-15px);
  }
}

.breathing-frame {
  position: relative;
  border-radius: 20px;
  padding: 8px;
  background: rgba(255, 255, 255, 0.05);
  box-shadow:
    0 0 30px rgba(128, 160, 255, 0.2),
    inset 0 0 20px rgba(128, 160, 255, 0.1);
  animation: breathe 4s ease-in-out infinite;
}

.breathing-frame::before {
  content: "";
  position: absolute;
  top: -2px;
  left: -2px;
  right: -2px;
  bottom: -2px;
  border-radius: 22px;
  background: linear-gradient(
    45deg,
    rgba(128, 160, 255, 0.5),
    transparent,
    rgba(200, 180, 255, 0.5)
  );
  z-index: -1;
  opacity: 0.6;
  animation: breathe-border 4s ease-in-out infinite;
}

@keyframes breathe {
  0%,
  100% {
    box-shadow:
      0 0 30px rgba(128, 160, 255, 0.1),
      inset 0 0 20px rgba(128, 160, 255, 0.1);
  }
  50% {
    box-shadow:
      0 0 60px rgba(128, 160, 255, 0.4),
      inset 0 0 40px rgba(128, 160, 255, 0.2);
  }
}

@keyframes breathe-border {
  0%,
  100% {
    opacity: 0.3;
  }
  50% {
    opacity: 0.8;
  }
}

.sleep-picture {
  display: block;
  border-radius: 14px;
  overflow: hidden;
  background-color: #1a2238;
  width: min(80vw, 400px);
  height: min(80vw, 400px);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
}

.sleep-image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  filter: brightness(0.85) contrast(0.95);
  transition: filter 1s ease;
}

.sleep-typography {
  text-align: center;
  color: #e2e8f0;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.5);
}

.sleep-title {
  font-size: 2rem;
  font-weight: 700;
  letter-spacing: 2px;
  margin-bottom: 12px;
  background: linear-gradient(to right, #e2e8f0, #a5b4fc);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.sleep-subtitle {
  font-size: 1.1rem;
  color: #94a3b8;
  font-weight: 400;
  letter-spacing: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .star {
    animation: none;
  }
  .sleep-content {
    animation: none;
    transform: none;
  }
  .breathing-frame {
    animation: none;
  }
  .breathing-frame::before {
    animation: none;
  }
}
</style>
