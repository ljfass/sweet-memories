<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Baby, Camera, Check, Images, RefreshCw, Sparkles, Upload } from '@lucide/vue'
import DeletePhotoDialog from './DeletePhotoDialog.vue'
import PhotoEditor from './PhotoEditor.vue'
import type { AdminPhoto, PhotoDraft, PhotoLibraryState, UploadQueueState } from './types'
import UploadQueue from './UploadQueue.vue'

const props = defineProps<{
  library: PhotoLibraryState
  uploadQueue?: UploadQueueState
  suspended?: boolean
}>()

const emit = defineEmits<{
  'mobile-modal-change': [open: boolean]
  'modal-change': [open: boolean]
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
const isDeleteDialogOpen = computed(() =>
  deleteCandidate.value !== null && props.suspended !== true)
const isAnyPhotoModalOpen = computed(() => isMobileEditorOpen.value || isDeleteDialogOpen.value)

interface PhotoSection {
  readonly key: string
  readonly group: string
  readonly label: string
  readonly photos: AdminPhoto[]
}

const photoSections = computed<PhotoSection[]>(() => {
  const sections: PhotoSection[] = []

  for (const photo of props.library.photos.value) {
    const year = photo.capturedDate?.slice(0, 4) ?? null
    const group = year ?? 'undated'
    const previous = sections.at(-1)

    if (previous?.group === group) {
      previous.photos.push(photo)
      continue
    }

    sections.push({
      key: `${group}-${sections.length}`,
      group,
      label: year === null ? '待补充日期' : `${year} 年 · 成长片段`,
      photos: [photo],
    })
  }

  return sections
})

function updateViewport(event: MediaQueryListEvent): void {
  isMobile.value = event.matches
}

onMounted(() => mobileMedia?.addEventListener('change', updateViewport))
onBeforeUnmount(() => {
  mobileMedia?.removeEventListener('change', updateViewport)
  if (isMobileEditorOpen.value) emit('mobile-modal-change', false)
  if (isAnyPhotoModalOpen.value) emit('modal-change', false)
})

watch(isMobileEditorOpen, async (open) => {
  emit('mobile-modal-change', open)
  if (!open) return
  await nextTick()
  libraryRoot.value?.querySelector<HTMLElement>('.admin-photo-editor')?.focus()
})

watch(isAnyPhotoModalOpen, (open) => emit('modal-change', open))

function sourceSet(sources: AdminPhoto['sources']['avif']): string {
  return sources.map((source) => `${source.url} ${source.width}w`).join(', ')
}

function capturedDateLabel(value: string | null): string {
  return value === null ? '日期待补充' : value.replaceAll('-', '.')
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
      class="admin-photo-library-content"
      :inert="isDeleteDialogOpen"
      :aria-hidden="isDeleteDialogOpen ? 'true' : undefined"
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

      <!-- 萌趣治愈的宝宝时光相册加载动效 -->
      <div
        v-if="library.status.value === 'loading'"
        class="baby-loading-container"
        role="status"
        aria-live="polite"
      >
        <div class="baby-loader-card">
          <!-- 悬浮光芒小点缀 -->
          <div
            class="bubble-sparkle sparkle-1"
            aria-hidden="true"
          >
            <Sparkles
              class="sparkle-svg-icon"
              :size="18"
            />
          </div>
          <div
            class="bubble-sparkle sparkle-2"
            aria-hidden="true"
          >
            🍼
          </div>
          <div
            class="bubble-sparkle sparkle-3"
            aria-hidden="true"
          >
            💛
          </div>

          <!-- 拟物宝宝相机 / 胶卷微动画徽章 -->
          <div class="baby-camera-badge">
            <div class="camera-lens">
              <Camera
                class="camera-icon"
                :size="28"
              />
              <span class="flash-shimmer" />
            </div>
            <div class="baby-badge-pill">
              <Baby
                class="baby-pill-icon"
                :size="14"
              />
              <span>Baby Memories</span>
            </div>
          </div>

          <!-- 萌趣三色跳跳球进度点 -->
          <div
            class="bouncing-bubbles"
            aria-hidden="true"
          >
            <span class="bubble bubble-pink" />
            <span class="bubble bubble-yellow" />
            <span class="bubble bubble-teal" />
          </div>

          <!-- 充满温度的文案设计 -->
          <h3 class="baby-loading-title">
            正在翻开宝贝的成长相册
            <span class="dot-typing">
              <span>.</span><span>.</span><span>.</span>
            </span>
          </h3>
          <p class="baby-loading-subtitle">
            正在冲洗满满的回忆胶卷，稍等一下下哦
          </p>
        </div>

        <!-- 治愈系相册骨架卡片预览 (Skeleton Grid) -->
        <div
          class="baby-skeleton-grid"
          aria-hidden="true"
        >
          <div
            v-for="i in 4"
            :key="i"
            class="skeleton-card"
          >
            <div class="skeleton-photo">
              <Images
                class="skeleton-placeholder-icon"
                :size="24"
              />
            </div>
            <div class="skeleton-copy">
              <div class="skeleton-line skeleton-title" />
              <div class="skeleton-line skeleton-date" />
            </div>
          </div>
        </div>
      </div>
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
          <section
            v-for="section in photoSections"
            :key="section.key"
            class="admin-photo-year-section"
            :data-photo-year-section="section.key"
            :aria-labelledby="`photo-year-${section.key}`"
          >
            <header class="admin-photo-year-heading">
              <span aria-hidden="true" />
              <h3 :id="`photo-year-${section.key}`">
                {{ section.label }}
              </h3>
            </header>
            <div class="admin-photo-section-grid">
              <article
                v-for="photo in section.photos"
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
                  <span
                    v-if="library.selectedId.value === photo.id"
                    class="admin-photo-selected"
                    aria-hidden="true"
                  >
                    <Check :size="16" />
                  </span>
                  <span class="admin-photo-card-copy">
                    <strong>{{ photo.title }}</strong>
                    <small data-captured-date>{{ capturedDateLabel(photo.capturedDate) }}</small>
                  </span>
                </button>
              </article>
            </div>
          </section>
        </div>

        <PhotoEditor
          v-if="selectedPhoto !== null"
          :photo="selectedPhoto"
          :draft="library.draftFor(selectedPhoto.id)"
          :conflict="library.hasConflict(selectedPhoto.id)"
          :saving="library.isSaving(selectedPhoto.id)"
          :message="library.messageFor(selectedPhoto.id)"
          :message-tone="library.messageToneFor(selectedPhoto.id)"
          :role="isMobileEditorOpen && !isDeleteDialogOpen ? 'dialog' : undefined"
          :aria-modal="isMobileEditorOpen && !isDeleteDialogOpen ? 'true' : undefined"
          :tabindex="isMobileEditorOpen && !isDeleteDialogOpen ? -1 : undefined"
          :inert="isDeleteDialogOpen"
          :aria-hidden="isDeleteDialogOpen ? 'true' : undefined"
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
    </div>

    <DeletePhotoDialog
      v-if="deleteCandidate !== null"
      :open="true"
      :suspended="suspended === true"
      :photo="deleteCandidate"
      :confirm="() => library.remove(deleteCandidate!.id)"
      :message="library.messageFor(deleteCandidate.id)"
      @cancel="cancelDelete"
      @deleted="handleDeleted"
    />
  </div>
</template>

<style scoped>
/* ================= 宝宝风格萌趣加载状态 ================= */
.baby-loading-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  padding: 12px 0 36px;
  gap: 28px;
}

/* 治愈系主加载卡片 */
.baby-loader-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  width: min(100%, 420px);
  padding: 28px 24px 22px;
  border: 1.5px dashed #f5c4d0;
  border-radius: 20px;
  background: linear-gradient(145deg, #fffcfd 0%, #fff7f8 50%, #fffbf5 100%);
  box-shadow: 0 12px 32px rgb(184 64 97 / 8%), 0 2px 6px rgb(0 0 0 / 2%);
}

/* 漂浮装饰微光 */
.bubble-sparkle {
  position: absolute;
  user-select: none;
  pointer-events: none;
  animation: floatSparkle 3s ease-in-out infinite alternate;
}

.sparkle-1 {
  top: 14px;
  right: 28px;
  animation-delay: -0.5s;
}

.sparkle-svg-icon {
  color: var(--admin-sun, #efa95a);
  filter: drop-shadow(0 2px 4px rgb(239 169 90 / 30%));
}

.sparkle-2 {
  top: 22px;
  left: 28px;
  font-size: 1.15rem;
  animation-delay: -1.6s;
}

.sparkle-3 {
  bottom: 20px;
  right: 36px;
  font-size: 1.05rem;
  animation-delay: -2.2s;
}

@keyframes floatSparkle {
  0% {
    transform: translateY(0) rotate(0deg) scale(1);
    opacity: 0.7;
  }
  50% {
    transform: translateY(-8px) rotate(8deg) scale(1.15);
    opacity: 1;
  }
  100% {
    transform: translateY(-4px) rotate(-6deg) scale(0.95);
    opacity: 0.8;
  }
}

/* 宝宝相机徽章 */
.baby-camera-badge {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.camera-lens {
  position: relative;
  display: grid;
  place-items: center;
  width: 58px;
  height: 58px;
  border: 2px solid #fecdd3;
  border-radius: 18px;
  background: #ffffff;
  color: var(--admin-berry, #b84061);
  box-shadow: 0 8px 18px rgb(184 64 97 / 14%), 0 2px 0 #fbcfe8;
  animation: cameraWiggle 3.6s ease-in-out infinite;
}

.flash-shimmer {
  position: absolute;
  top: 6px;
  right: 8px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--admin-sun, #efa95a);
  animation: flashPulse 1.8s ease-in-out infinite;
}

@keyframes cameraWiggle {
  0%, 100% {
    transform: translateY(0) rotate(0deg);
  }
  15% {
    transform: translateY(-4px) rotate(-4deg);
  }
  30% {
    transform: translateY(0) rotate(3deg);
  }
  45% {
    transform: translateY(-2px) rotate(0deg);
  }
}

@keyframes flashPulse {
  0%, 100% {
    transform: scale(0.8);
    opacity: 0.6;
  }
  50% {
    transform: scale(1.4);
    opacity: 1;
    box-shadow: 0 0 8px #efa95a;
  }
}

.baby-badge-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 20px;
  background: #fee2e2;
  color: #9f1239;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.baby-pill-icon {
  color: var(--admin-berry, #b84061);
}

/* 萌趣三色跳动小球 */
.bouncing-bubbles {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-bottom: 12px;
}

.bubble {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  animation: bounceBubble 1.2s infinite ease-in-out;
}

.bubble-pink {
  background: var(--admin-berry, #b84061);
  animation-delay: -0.32s;
}

.bubble-yellow {
  background: var(--admin-sun, #efa95a);
  animation-delay: -0.16s;
}

.bubble-teal {
  background: var(--admin-teal, #39767a);
}

@keyframes bounceBubble {
  0%, 80%, 100% {
    transform: scale(0.6) translateY(0);
    opacity: 0.4;
  }
  40% {
    transform: scale(1.2) translateY(-6px);
    opacity: 1;
  }
}

/* 文案排印 */
.baby-loading-title {
  margin: 0 0 6px;
  font-family: var(--admin-serif, "Songti SC", serif);
  font-size: 1.15rem;
  font-weight: 700;
  color: #2b2529;
}

.dot-typing span {
  display: inline-block;
  animation: dotBlink 1.4s infinite;
  animation-fill-mode: both;
}

.dot-typing span:nth-child(2) {
  animation-delay: 0.2s;
}

.dot-typing span:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes dotBlink {
  0% {
    opacity: 0.2;
  }
  20% {
    opacity: 1;
  }
  100% {
    opacity: 0.2;
  }
}

.baby-loading-subtitle {
  margin: 0;
  font-size: 0.85rem;
  color: #8c8288;
  line-height: 1.5;
}

/* 治愈系相册骨架卡片 */
.baby-skeleton-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  width: 100%;
  gap: 16px;
}

.skeleton-card {
  display: flex;
  flex-direction: column;
  padding: 6px;
  border: 1px solid #e7dedf;
  border-radius: 8px;
  background: #ffffff;
  box-shadow: 0 4px 12px rgb(74 55 61 / 4%);
}

.skeleton-photo {
  position: relative;
  display: grid;
  place-items: center;
  aspect-ratio: 1;
  border-radius: 4px;
  background: #f4edea;
  overflow: hidden;
}

.skeleton-photo::after {
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent 0%, rgb(255 255 255 / 65%) 50%, transparent 100%);
  transform: translateX(-100%);
  animation: skeletonShimmer 1.8s infinite;
  content: "";
}

.skeleton-placeholder-icon {
  color: #d1c4c8;
}

.skeleton-copy {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 6px 8px;
}

.skeleton-line {
  height: 10px;
  border-radius: 4px;
  background: #eee5e7;
}

.skeleton-title {
  width: 75%;
}

.skeleton-date {
  width: 45%;
}

@keyframes skeletonShimmer {
  100% {
    transform: translateX(100%);
  }
}

@media (max-width: 720px) {
  .baby-skeleton-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
  }

  .baby-loader-card {
    padding: 22px 18px 18px;
  }

  .baby-loading-title {
    font-size: 1.05rem;
  }

  .baby-loading-subtitle {
    font-size: 0.8rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .bubble-sparkle,
  .camera-lens,
  .flash-shimmer,
  .bubble,
  .dot-typing span,
  .skeleton-photo::after {
    animation: none;
  }
}
</style>
