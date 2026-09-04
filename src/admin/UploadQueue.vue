<script setup lang="ts">
import { RotateCcw, X } from '@lucide/vue'
import type { UploadErrorCode, UploadQueueItem, UploadQueueState } from './types'

const props = defineProps<{ queue: UploadQueueState }>()

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function errorMessage(code: UploadErrorCode | null): string {
  switch (code) {
    case 'file-too-large': return '单张图片不能超过 10MB'
    case 'invalid-photo': return '图片格式或内容无效'
    case 'uploads-disabled': return '图片上传暂未开放'
    case 'storage-full': return '服务器存储空间不足'
    case 'upload-busy': return '处理队列繁忙，请稍后重试'
    default: return '暂时无法上传，请稍后重试'
  }
}

function itemStatus(item: UploadQueueItem): string {
  switch (item.status) {
    case 'queued': return '等待上传'
    case 'uploading': return item.progress >= 100 ? '服务器处理中' : `正在上传 ${item.progress}%`
    case 'succeeded': return '上传完成'
    case 'paused': return '上传已暂停'
    case 'failed': return errorMessage(item.errorCode)
  }
}

function queueSummary(): string {
  if (props.queue.status.value === 'paused-auth') return '登录已过期，上传已暂停'
  if (props.queue.status.value === 'ready-to-resume') return '登录已恢复，上传仍处于暂停状态'
  const uploading = props.queue.items.value.filter(
    (item) => item.status === 'uploading' && item.progress < 100,
  ).length
  const processing = props.queue.items.value.filter(
    (item) => item.status === 'uploading' && item.progress >= 100,
  ).length
  if (uploading > 0 && processing > 0) {
    return `正在上传 ${uploading} 张照片，服务器正在处理 ${processing} 张照片`
  }
  if (uploading > 0) return `正在上传 ${uploading} 张照片`
  if (processing > 0) return `服务器正在处理 ${processing} 张照片`
  const queued = props.queue.items.value.filter((item) => item.status === 'queued').length
  if (queued > 0) return `${queued} 张照片等待上传`
  const failed = props.queue.items.value.filter((item) => item.status === 'failed').length
  if (failed > 0) return `${failed} 张照片上传失败`
  return '上传队列已完成'
}
</script>

<template>
  <section
    v-if="queue.items.value.length > 0"
    class="admin-upload-queue"
    aria-labelledby="upload-queue-title"
  >
    <div class="admin-upload-header">
      <h3 id="upload-queue-title">
        上传队列
      </h3>
      <p aria-live="polite">
        {{ queueSummary() }}
      </p>
    </div>

    <div
      v-if="queue.status.value === 'ready-to-resume'"
      class="admin-upload-resume"
    >
      <span>登录已恢复，上传仍处于暂停状态</span>
      <button
        class="admin-primary-button"
        type="button"
        data-continue-upload
        @click="queue.continueAfterLogin"
      >
        继续上传
      </button>
    </div>

    <ul class="admin-upload-list">
      <li
        v-for="item in queue.items.value"
        :key="item.id"
        class="admin-upload-item"
        :data-upload-item="item.id"
      >
        <img
          :src="item.previewUrl"
          alt=""
          width="64"
          height="64"
        >
        <div class="admin-upload-detail">
          <strong>{{ item.file.name }}</strong>
          <span>{{ formatBytes(item.file.size) }}</span>
          <span
            v-if="item.hasUnrecognizedExtension"
            class="admin-upload-format-hint"
          >
            扩展名不常见，将由服务器检查图片内容
          </span>
          <progress
            v-if="item.status === 'uploading'"
            max="100"
            :value="item.progress < 100 ? item.progress : undefined"
            :aria-label="item.progress < 100
              ? `上传 ${item.file.name}`
              : `服务器处理 ${item.file.name}`"
          >
            {{ item.progress < 100 ? `${item.progress}%` : '服务器处理中' }}
          </progress>
          <span :class="{ 'admin-upload-error': item.status === 'failed' }">
            {{ itemStatus(item) }}
          </span>
        </div>
        <div class="admin-upload-actions">
          <button
            v-if="item.status === 'failed' && item.errorCode !== 'file-too-large'"
            class="admin-icon-button"
            type="button"
            title="重试"
            :aria-label="`重试 ${item.file.name}`"
            @click="queue.retry(item.id)"
          >
            <RotateCcw
              :size="17"
              aria-hidden="true"
            />
          </button>
          <button
            class="admin-icon-button"
            type="button"
            title="移除"
            :aria-label="`移除 ${item.file.name}`"
            @click="queue.remove(item.id)"
          >
            <X
              :size="18"
              aria-hidden="true"
            />
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>
