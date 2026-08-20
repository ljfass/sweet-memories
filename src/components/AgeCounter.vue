<script setup lang="ts">
import { useAgeCounter } from '../composables/useAgeCounter'

const props = defineProps<{
  birthDate: Date
}>()

const age = useAgeCounter(props.birthDate)
</script>

<template>
  <p class="age-counter" aria-label="宝宝年龄实时计时">
    来到这个美丽世界已经
    <br />
    <strong>{{ age.years }}</strong> 年
    <strong>{{ age.days }}</strong> 天
    <strong>{{ age.hours }}</strong> 小时
    <strong>{{ age.minutes }}</strong> 分
    <strong>{{ age.seconds }}</strong> 秒
  </p>
</template>
