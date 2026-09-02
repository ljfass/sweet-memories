<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { AdminPhoto } from './types'

const props = defineProps<{
  open: boolean
  photo: AdminPhoto
  confirm: () => Promise<boolean>
  message: string
}>()

const emit = defineEmits<{
  deleted: []
  cancel: []
}>()

const confirmButton = ref<HTMLButtonElement | null>(null)
const isDeleting = ref(false)

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    await nextTick()
    confirmButton.value?.focus()
  },
  { immediate: true },
)

async function confirmDeletion(): Promise<void> {
  if (isDeleting.value) return
  isDeleting.value = true
  try {
    if (await props.confirm()) emit('deleted')
  } finally {
    isDeleting.value = false
  }
}
</script>

<template>
  <div
    v-if="open"
    class="admin-dialog-backdrop"
    @keydown.esc.prevent="emit('cancel')"
  >
    <section
      class="admin-dialog admin-delete-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-photo-title"
    >
      <header class="admin-dialog-header">
        <p class="admin-eyebrow">
          确认操作
        </p>
        <h2 id="delete-photo-title">
          永久删除照片
        </h2>
        <p>永久删除，无法恢复</p>
      </header>

      <div class="admin-delete-summary">
        <img
          :src="photo.sources.fallback.url"
          :alt="photo.alt"
          :width="photo.sources.fallback.width"
          :height="photo.sources.fallback.height"
        >
        <strong>{{ photo.title }}</strong>
      </div>

      <p
        class="admin-form-message"
        aria-live="polite"
      >
        {{ message }}
      </p>

      <div class="admin-dialog-actions">
        <button
          class="admin-secondary-button"
          type="button"
          :disabled="isDeleting"
          @click="emit('cancel')"
        >
          取消
        </button>
        <button
          ref="confirmButton"
          class="admin-danger-button"
          type="button"
          data-confirm-delete
          :disabled="isDeleting"
          @click="confirmDeletion"
        >
          {{ isDeleting ? '正在删除' : '确认永久删除' }}
        </button>
      </div>
    </section>
  </div>
</template>
