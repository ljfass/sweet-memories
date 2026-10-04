<script setup lang="ts">
import { CheckCircle2, X } from '@lucide/vue'
import { watch } from 'vue'
import type { AdminSuccessNotification } from './useAdminSuccessNotifications'

const props = defineProps<{
  items: readonly AdminSuccessNotification[]
  suspended: boolean
}>()

const emit = defineEmits<{
  pause: [id: number]
  resume: [id: number]
  dismiss: [id: number]
}>()

const hoveredIds = new Set<number>()
const focusedIds = new Set<number>()
const interactionPausedIds = new Set<number>()

function isInteracting(id: number): boolean {
  return hoveredIds.has(id) || focusedIds.has(id)
}

function beginInteraction(id: number, activeIds: Set<number>): void {
  if (props.suspended) return

  const wasInteracting = isInteracting(id)
  activeIds.add(id)
  if (!wasInteracting && !interactionPausedIds.has(id)) {
    interactionPausedIds.add(id)
    emit('pause', id)
  }
}

function endInteraction(id: number, activeIds: Set<number>): void {
  activeIds.delete(id)
  if (props.suspended || isInteracting(id) || !interactionPausedIds.delete(id)) return

  emit('resume', id)
}

function handleFocusOut(id: number, event: FocusEvent): void {
  const article = event.currentTarget as HTMLElement
  const nextTarget = event.relatedTarget
  if (nextTarget instanceof Node && article.contains(nextTarget)) return

  endInteraction(id, focusedIds)
}

function dismiss(id: number): void {
  if (!props.suspended) emit('dismiss', id)
}

watch(() => props.suspended, (suspended) => {
  if (suspended) {
    hoveredIds.clear()
    focusedIds.clear()
    return
  }

  interactionPausedIds.forEach((id) => emit('resume', id))
  interactionPausedIds.clear()
})

watch(() => props.items.map((item) => item.id), (activeIds) => {
  const activeIdSet = new Set(activeIds)
  for (const id of hoveredIds) if (!activeIdSet.has(id)) hoveredIds.delete(id)
  for (const id of focusedIds) if (!activeIdSet.has(id)) focusedIds.delete(id)
  for (const id of interactionPausedIds) {
    if (!activeIdSet.has(id)) interactionPausedIds.delete(id)
  }
})
</script>

<template>
  <div
    class="admin-success-notifications"
    role="status"
    aria-live="polite"
    aria-atomic="false"
    data-success-notifications
    :data-suspended="suspended ? 'true' : undefined"
  >
    <TransitionGroup name="admin-success-notification">
      <article
        v-for="item in items"
        :key="item.id"
        class="admin-success-notification"
        data-success-notification
        :tabindex="suspended ? -1 : 0"
        @mouseenter="beginInteraction(item.id, hoveredIds)"
        @mouseleave="endInteraction(item.id, hoveredIds)"
        @focusin="beginInteraction(item.id, focusedIds)"
        @focusout="handleFocusOut(item.id, $event)"
      >
        <CheckCircle2
          class="admin-success-notification-icon"
          :size="18"
          aria-hidden="true"
        />
        <p class="admin-success-notification-message">
          {{ item.message }}
        </p>
        <button
          class="admin-success-notification-dismiss"
          type="button"
          title="关闭提示"
          aria-label="关闭提示"
          data-dismiss-success
          :disabled="suspended"
          @click="dismiss(item.id)"
        >
          <X
            :size="16"
            aria-hidden="true"
          />
        </button>
      </article>
    </TransitionGroup>
  </div>
</template>
