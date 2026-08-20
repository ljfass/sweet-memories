<script setup lang="ts">
defineProps<{
  poster: string
  src: string
}>()
</script>

<template>
  <section class="video-section" aria-labelledby="memory-video-title">
    <h2 id="memory-video-title">🎥 成长放映室</h2>
    <div class="video-frame">
      <video controls preload="none" playsinline :poster="poster">
        <source :src="src" type="video/mp4" />
        您的浏览器不支持视频播放。
      </video>
    </div>
  </section>
</template>
