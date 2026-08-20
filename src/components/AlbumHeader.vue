<script setup lang="ts">
import AgeCounter from './AgeCounter.vue'

const birthDate = new Date('2025-10-09T08:55:00')
</script>

<template>
  <header class="album-header">
    <h1>宝贝的快乐时光</h1>
    <p class="subtitle">记录成长的每一个心动瞬间 👶✨</p>
    <AgeCounter :birth-date="birthDate" />
  </header>
</template>
