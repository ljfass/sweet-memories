<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RefreshCw, Upload } from '@lucide/vue'
import DeletePhotoDialog from './DeletePhotoDialog.vue'
import PhotoEditor from './PhotoEditor.vue'
import type { AdminPhoto, PhotoDraft, PhotoLibraryState, UploadQueueState } from './types'
import UploadQueue from './UploadQueue.vue'

const props = defineProps<{
  library: PhotoLibraryState
  uploadQueue?: UploadQueueState
}>()

const emit = defineEmits<{
  'mobile-modal-change': [open: boolean]
}>()

const deleteCandidate = ref<AdminPhoto | null>(null)
const deleteCandidateIndex = ref<number | null>(null)
const libraryRoot = ref<HTMLElement | null>(null)
const editorReturnTarget = ref<HTMLElement | null>(null)
const uploadInput = ref<HTMLInputElement | null>(null)
const uploadSelectionMessage = ref('')
const mobileMedia = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(max-width: 720px)')
  : null
const isMobile = ref(mobileMedia?.matches ?? false)
const selectedPhoto = computed(() =>
  props.library.photos.value.find((photo) => photo.id === props.library.selectedId.value) ?? null)
const isMobileEditorOpen = computed(() => isMobile.value && selectedPhoto.value !== null)

function updateViewport(event: MediaQueryListEvent): void {
  isMobile.value = event.matches
}

onMounted(() => mobileMedia?.addEventListener('change', updateViewport))
onBeforeUnmount(() => {
  mobileMedia?.removeEventListener('change', updateViewport)
  if (isMobileEditorOpen.value) emit('mobile-modal-change', false)
})

watch(isMobileEditorOpen, async (open) => {
  emit('mobile-modal-change', open)
  if (!open) return
  await nextTick()
  libraryRoot.value?.querySelector<HTMLElement>('.admin-photo-editor')?.focus()
})

function sourceSet(sources: AdminPhoto['sources']['avif']): string {
  return sources.map((source) => `${source.url} ${source.width}w`).join(', ')
}

function openPhotoPicker(): void {
  uploadInput.value?.click()
}

function addSelectedFiles(event: Event): void {
  const input = event.currentTarget
  if (!(input instanceof HTMLInputElement) || props.uploadQueue === undefined) return
  uploadSelectionMessage.value = ''
  try {
    props.uploadQueue.add(Array.from(input.files ?? []))
  } catch {
    uploadSelectionMessage.value = '一次最多选择 10 张照片'
  } finally {
    input.value = ''
  }
}

function updateDraft(draft: PhotoDraft): void {
  if (selectedPhoto.value !== null) props.library.updateDraft(selectedPhoto.value.id, draft)
}

function openPhoto(id: string, event: Event): void {
  editorReturnTarget.value = event.currentTarget instanceof HTMLElement
    ? event.currentTarget
    : null
  props.library.select(id)
}

async function closeEditor(): Promise<void> {
  props.library.select(null)
  const returnTarget = editorReturnTarget.value
  editorReturnTarget.value = null
  await nextTick()
  if (returnTarget?.isConnected) returnTarget.focus()
}

function openDelete(photo: AdminPhoto): void {
  deleteCandidateIndex.value = props.library.photos.value.findIndex(
    (candidate) => candidate.id === photo.id,
  )
  deleteCandidate.value = photo
}

function cancelDelete(): void {
  deleteCandidate.value = null
  deleteCandidateIndex.value = null
}

async function handleDeleted(): Promise<void> {
  const deletedIndex = deleteCandidateIndex.value ?? 0
  deleteCandidate.value = null
  deleteCandidateIndex.value = null
  editorReturnTarget.value = null
  await nextTick()
  const cards = Array.from(
    libraryRoot.value?.querySelectorAll<HTMLElement>('.admin-photo-card button') ?? [],
  )
  const focusTarget = cards[deletedIndex]
    ?? cards[deletedIndex - 1]
    ?? document.getElementById('photo-library-title')
  focusTarget?.focus()
}

function editorFocusableElements(): HTMLElement[] {
  const editor = libraryRoot.value?.querySelector<HTMLElement>('.admin-photo-editor')
  if (editor === null || editor === undefined) return []
  return Array.from(editor.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), '
    + 'select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
  ))
}

function handleMobileEditorKeydown(event: KeyboardEvent): void {
  if (!isMobileEditorOpen.value || event.key !== 'Tab') return
  const focusable = editorFocusableElements()
  const first = focusable[0]
  const last = focusable.at(-1)
  if (first === undefined || last === undefined) {
    event.preventDefault()
    return
  }
  const editor = libraryRoot.value?.querySelector<HTMLElement>('.admin-photo-editor')
  if (document.activeElement === editor || !editor?.contains(document.activeElement)) {
    event.preventDefault()
    const focusTarget = event.shiftKey ? last : first
    focusTarget.focus()
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
</script>

<template>
  <div
    ref="libraryRoot"
    class="admin-photo-library"
  >
    <div
      class="admin-library-actions"
      :inert="isMobileEditorOpen"
      :aria-hidden="isMobileEditorOpen ? 'true' : undefined"
    >
      <button
        class="admin-primary-button admin-upload-button"
        type="button"
        data-upload
        :disabled="library.uploadsDisabled.value"
        :title="library.uploadsDisabled.value ? '旧照片准备完成后开放上传' : '上传照片'"
        @click="openPhotoPicker"
      >
        <Upload
          :size="18"
          aria-hidden="true"
        />
        上传照片
      </button>
      <input
        v-if="uploadQueue !== undefined"
        ref="uploadInput"
        class="admin-visually-hidden"
        type="file"
        accept=".heic,.heif,.jpg,.jpeg,.png,.webp,image/heic,image/heif,image/jpeg,image/png,image/webp"
        multiple
        tabindex="-1"
        :disabled="library.uploadsDisabled.value"
        @change="addSelectedFiles"
      >
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

    <p
      v-if="uploadSelectionMessage !== ''"
      class="admin-upload-selection-message"
      role="alert"
    >
      {{ uploadSelectionMessage }}
    </p>

    <UploadQueue
      v-if="uploadQueue !== undefined"
      :queue="uploadQueue"
      :inert="isMobileEditorOpen"
      :aria-hidden="isMobileEditorOpen ? 'true' : undefined"
    />

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
        :inert="isMobileEditorOpen"
        :aria-hidden="isMobileEditorOpen ? 'true' : undefined"
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
            @click="openPhoto(photo.id, $event)"
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
        :role="isMobileEditorOpen ? 'dialog' : undefined"
        :aria-modal="isMobileEditorOpen ? 'true' : undefined"
        :tabindex="isMobileEditorOpen ? -1 : undefined"
        @update-draft="updateDraft"
        @save="library.save(selectedPhoto.id)"
        @load-latest="library.loadLatest(selectedPhoto.id)"
        @open-delete="openDelete(selectedPhoto)"
        @close="closeEditor"
        @keydown="handleMobileEditorKeydown"
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
      @cancel="cancelDelete"
      @deleted="handleDeleted"
    />
  </div>
</template>
