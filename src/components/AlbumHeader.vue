<script setup lang="ts">
import { useBabyConfig } from '../composables/useBabyConfig'
import AgeCounter from './AgeCounter.vue'

const { birthDate } = useBabyConfig()
</script>

<template>
  <header class="album-header">
    <h1>宝贝的快乐时光</h1>
    <p class="subtitle">
      记录成长的每一个心动瞬间 👶✨
    </p>
    <AgeCounter :birth-date="birthDate" />
  </header>
</template>
