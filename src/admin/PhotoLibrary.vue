<script setup lang="ts">
import { computed, ref } from 'vue'
import { RefreshCw, Upload } from '@lucide/vue'
import DeletePhotoDialog from './DeletePhotoDialog.vue'
import PhotoEditor from './PhotoEditor.vue'
import type { AdminPhoto, PhotoDraft, PhotoLibraryState } from './types'

const props = defineProps<{
  library: PhotoLibraryState
}>()

const deleteCandidate = ref<AdminPhoto | null>(null)
const selectedPhoto = computed(() =>
  props.library.photos.value.find((photo) => photo.id === props.library.selectedId.value) ?? null)

function sourceSet(sources: AdminPhoto['sources']['avif']): string {
  return sources.map((source) => `${source.url} ${source.width}w`).join(', ')
}

function updateDraft(draft: PhotoDraft): void {
  if (selectedPhoto.value !== null) props.library.updateDraft(selectedPhoto.value.id, draft)
}
</script>

<template>
  <div class="admin-photo-library">
    <div class="admin-library-actions">
      <button
        class="admin-primary-button admin-upload-button"
        type="button"
        data-upload
        :disabled="library.uploadsDisabled.value"
        :title="library.uploadsDisabled.value ? '旧照片准备完成后开放上传' : '上传照片'"
      >
        <Upload
          :size="18"
          aria-hidden="true"
        />
        上传照片
      </button>
      <button
        class="admin-secondary-button"
        type="button"
        data-refresh
        @click="library.refresh"
      >
        <RefreshCw
          :size="18"
          aria-hidden="true"
        />
        刷新
      </button>
    </div>

    <div
      v-if="library.isMigrationPending.value"
      class="admin-migration-banner"
      role="status"
    >
      <strong>正在准备旧照片，暂未开放上传</strong>
      <span>可继续补充拍摄日期、标题和图片描述。</span>
    </div>

    <p
      v-if="library.status.value === 'loading'"
      class="admin-empty-copy"
      aria-live="polite"
    >
      正在加载照片
    </p>
    <div
      v-else-if="library.status.value === 'error'"
      class="admin-library-error"
      role="alert"
    >
      <p>{{ library.messageFor('library') }}</p>
      <button
        class="admin-secondary-button"
        type="button"
        @click="library.refresh"
      >
        重试
      </button>
    </div>
    <p
      v-else-if="library.photos.value.length === 0"
      class="admin-empty-copy"
    >
      还没有照片
    </p>

    <div
      v-else
      class="admin-library-layout"
      data-mobile-editor="fullscreen"
    >
      <div
        class="admin-photo-grid"
        data-mobile-columns="2"
        aria-label="照片库"
      >
        <article
          v-for="photo in library.photos.value"
          :key="photo.id"
          class="admin-photo-card"
          :class="{ 'is-selected': library.selectedId.value === photo.id }"
          :data-photo-id="photo.id"
        >
          <button
            type="button"
            @click="library.select(photo.id)"
          >
            <picture>
              <source
                type="image/avif"
                :srcset="sourceSet(photo.sources.avif)"
              >
              <source
                type="image/webp"
                :srcset="sourceSet(photo.sources.webp)"
              >
              <img
                :src="photo.sources.fallback.url"
                :alt="photo.alt"
                :width="photo.sources.fallback.width"
                :height="photo.sources.fallback.height"
              >
            </picture>
            <span>{{ photo.title }}</span>
          </button>
        </article>
      </div>

      <PhotoEditor
        v-if="selectedPhoto !== null"
        :photo="selectedPhoto"
        :draft="library.draftFor(selectedPhoto.id)"
        :conflict="library.hasConflict(selectedPhoto.id)"
        :saving="library.isSaving(selectedPhoto.id)"
        :message="library.messageFor(selectedPhoto.id)"
        @update-draft="updateDraft"
        @save="library.save(selectedPhoto.id)"
        @load-latest="library.loadLatest(selectedPhoto.id)"
        @open-delete="deleteCandidate = selectedPhoto"
        @close="library.select(null)"
      />
      <aside
        v-else
        class="admin-editor-placeholder"
        aria-label="照片编辑器"
      >
        选择一张照片进行编辑
      </aside>
    </div>

    <DeletePhotoDialog
      v-if="deleteCandidate !== null"
      :open="true"
      :photo="deleteCandidate"
      :confirm="() => library.remove(deleteCandidate!.id)"
      :message="library.messageFor(deleteCandidate.id)"
      @cancel="deleteCandidate = null"
      @deleted="deleteCandidate = null"
    />
  </div>
</template>
