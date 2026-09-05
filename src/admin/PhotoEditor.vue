<script setup lang="ts">
import { ArrowLeft, CircleCheck, Trash } from '@lucide/vue'
import type { AdminPhoto, PhotoDraft, PhotoMessageTone } from './types'

const props = defineProps<{
  photo: AdminPhoto
  draft: PhotoDraft
  conflict: boolean
  saving: boolean
  message: string
  messageTone: PhotoMessageTone | null
}>()

const emit = defineEmits<{
  'update-draft': [draft: PhotoDraft]
  'save': []
  'load-latest': []
  'open-delete': []
  'close': []
}>()

function update(field: keyof PhotoDraft, event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return
  emit('update-draft', { ...props.draft, [field]: target.value })
}
</script>

<template>
  <aside
    class="admin-photo-editor"
    aria-label="照片编辑器"
  >
    <header class="admin-photo-editor-header">
      <button
        class="admin-editor-back"
        type="button"
        aria-label="返回照片库"
        title="返回照片库"
        @click="emit('close')"
      >
        <ArrowLeft
          :size="20"
          aria-hidden="true"
        />
      </button>
      <div>
        <p class="admin-photo-editor-kicker">
          照片信息
        </p>
        <h2>记录这张照片</h2>
      </div>
      <button
        class="admin-icon-button admin-delete-button"
        type="button"
        data-open-delete
        aria-label="永久删除照片"
        title="永久删除照片"
        @click="emit('open-delete')"
      >
        <Trash
          :size="19"
          aria-hidden="true"
        />
      </button>
    </header>

    <div class="admin-editor-mount">
      <img
        class="admin-editor-preview"
        :src="photo.sources.fallback.url"
        :alt="photo.alt"
        :width="photo.sources.fallback.width"
        :height="photo.sources.fallback.height"
      >
    </div>

    <form
      class="admin-editor-form"
      @submit.prevent="emit('save')"
    >
      <div class="admin-field">
        <label :for="`photo-title-${photo.id}`">标题</label>
        <input
          :id="`photo-title-${photo.id}`"
          name="title"
          type="text"
          :value="draft.title"
          :disabled="saving"
          @input="update('title', $event)"
        >
      </div>
      <div class="admin-field">
        <label :for="`photo-date-${photo.id}`">拍摄日期</label>
        <input
          :id="`photo-date-${photo.id}`"
          name="capturedDate"
          type="date"
          :value="draft.capturedDate"
          :disabled="saving"
          @input="update('capturedDate', $event)"
        >
      </div>
      <div class="admin-field">
        <label :for="`photo-description-${photo.id}`">图片描述（可选）</label>
        <textarea
          :id="`photo-description-${photo.id}`"
          name="description"
          rows="4"
          :value="draft.description"
          :disabled="saving"
          @input="update('description', $event)"
        />
        <p
          v-if="draft.description.trim() === ''"
          class="admin-field-hint"
          data-description-fallback
        >
          留空时，公开图片说明将使用标题
        </p>
      </div>

      <div
        v-if="conflict"
        class="admin-conflict-notice"
        role="alert"
      >
        <p>照片已在其他页面修改</p>
        <button
          class="admin-link-button"
          type="button"
          data-load-latest
          @click="emit('load-latest')"
        >
          载入最新内容
        </button>
      </div>

      <p
        class="admin-form-message"
        :class="{
          'is-success': messageTone === 'success',
          'is-error': messageTone === 'error',
        }"
        :role="messageTone === 'success' ? 'status' : undefined"
        :data-save-success="messageTone === 'success' ? '' : undefined"
        aria-live="polite"
      >
        <CircleCheck
          v-if="messageTone === 'success'"
          class="admin-form-message-icon"
          :size="18"
          aria-hidden="true"
        />
        <span>{{ message }}</span>
      </p>

      <button
        class="admin-primary-button"
        type="submit"
        :disabled="saving"
      >
        {{ saving ? '正在保存' : '保存修改' }}
      </button>
    </form>
  </aside>
</template>
