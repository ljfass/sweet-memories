<script setup lang="ts">
import { X } from '@lucide/vue'

const props = withDefaults(defineProps<{
  label: string
  disabled?: boolean
}>(), {
  disabled: false,
})

const emit = defineEmits<{
  clear: []
}>()

function clear(): void {
  if (!props.disabled) emit('clear')
}
</script>

<template>
  <button
    class="admin-clear-field-button"
    type="button"
    :disabled="disabled"
    :title="label"
    :aria-label="label"
    @click="clear"
  >
    <X
      :size="16"
      aria-hidden="true"
    />
  </button>
</template>

<style scoped>
.admin-clear-field-button {
  position: absolute;
  z-index: 1;
  top: 50%;
  right: 4px;
  display: grid;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  color: var(--admin-muted, #70676c);
  background: transparent;
  cursor: pointer;
  place-items: center;
  transform: translateY(-50%);
  transition: color 160ms ease, background-color 160ms ease;
}

.admin-clear-field-button.is-before-trailing-action {
  right: 44px;
}

.admin-clear-field-button.is-before-native-action {
  right: 40px;
}

.admin-clear-field-button.is-textarea {
  top: 4px;
  transform: none;
}

.admin-clear-field-button:hover:not(:disabled) {
  color: var(--admin-text, #2d292c);
  background: rgb(45 41 44 / 7%);
}

.admin-clear-field-button:focus-visible {
  outline: 3px solid var(--admin-teal, #39767a);
  outline-offset: 1px;
}

.admin-clear-field-button:disabled {
  cursor: default;
  opacity: 0.45;
}

@media (prefers-reduced-motion: reduce) {
  .admin-clear-field-button {
    transition: none;
  }
}
</style>
