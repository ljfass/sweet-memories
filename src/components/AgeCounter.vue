<script setup lang="ts">
import { ref } from "vue";
import { useAgeCounter } from "../composables/useAgeCounter";
import Baby3DModal from "./Baby3DModal.vue";

const props = defineProps<{
  birthDate: Date;
}>();

const age = useAgeCounter(props.birthDate);
const isModalOpen = ref(false);

function openModal() {
  if (navigator.vibrate) {
    try {
      navigator.vibrate([15, 25, 15]);
    } catch {
      // 某些浏览器可能禁止
    }
  }
  isModalOpen.value = true;
}

function closeModal() {
  isModalOpen.value = false;
}
</script>

<template>
  <div class="age-counter-wrapper">
    <p
      class="age-counter is-clickable"
      aria-label="宝宝年龄实时计时"
      role="button"
      tabindex="0"
      title="点击查看宝宝 3D 空间心动定格"
      @click="openModal"
      @keydown.enter="openModal"
      @keydown.space.prevent="openModal"
    >
      来到这个美丽世界已经

      <br />
      <template v-if="age.years > 0">
        <strong>{{ age.years }}</strong> 年
      </template>
      <strong>{{ age.days }}</strong> 天 <strong>{{ age.hours }}</strong> 小时
      <strong>{{ age.minutes }}</strong> 分
      <strong>{{ age.seconds }}</strong> 秒
    </p>

    <Baby3DModal :is-open="isModalOpen" @close="closeModal" />
  </div>
</template>

<style scoped>
.age-counter-wrapper {
  display: contents;
}

.age-counter.is-clickable {
  position: relative;
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  transition:
    transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1),
    box-shadow 0.2s ease,
    background-color 0.2s ease;
}

.age-counter.is-clickable:hover {
  box-shadow: 0 6px 20px rgba(255, 143, 171, 0.25);
}

.age-counter.is-clickable:active {
  transform: scale(0.96);
}

.age-counter.is-clickable:focus-visible {
  outline: 3px solid var(--focus-color, #ff8fab);
  outline-offset: 4px;
}

@keyframes gentle-float {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-2px);
  }
}
</style>
