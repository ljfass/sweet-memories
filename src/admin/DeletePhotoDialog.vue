<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
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
const dialog = ref<HTMLElement | null>(null)
const isDeleting = ref(false)
let focusReturnTarget: HTMLElement | null = null

function restoreFocus(): void {
  const returnTarget = focusReturnTarget
  focusReturnTarget = null
  if (returnTarget?.isConnected) returnTarget.focus()
}

watch(
  () => props.open,
  async (open, wasOpen) => {
    if (open) {
      if (!wasOpen) {
        focusReturnTarget = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null
      }
      await nextTick()
      confirmButton.value?.focus()
      return
    }
    if (wasOpen) {
      await nextTick()
      restoreFocus()
    }
  },
  { immediate: true },
)

onBeforeUnmount(restoreFocus)

function requestCancel(): void {
  if (!isDeleting.value) emit('cancel')
}

function focusableElements(): HTMLElement[] {
  if (dialog.value === null) return []
  return Array.from(dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled)'))
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    requestCancel()
    return
  }
  if (event.key !== 'Tab') return
  const focusable = focusableElements()
  const first = focusable[0]
  const last = focusable.at(-1)
  if (first === undefined || last === undefined) {
    event.preventDefault()
    return
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

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
  >
    <section
      ref="dialog"
      class="admin-dialog admin-delete-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-photo-title"
      @keydown="handleKeydown"
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
          @click="requestCancel"
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
