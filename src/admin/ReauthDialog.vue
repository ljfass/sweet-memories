<script setup lang="ts">
import { nextTick, onUpdated, ref, watch } from 'vue'
import { safeLoginErrorMessage, safeLogoutErrorMessage } from './api'
import ClearFieldButton from './ClearFieldButton.vue'

const props = defineProps<{
  open: boolean
  username: string
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}>()

const emit = defineEmits<{
  reauthenticated: []
}>()

const dialog = ref<HTMLElement | null>(null)
const usernameInput = ref<HTMLInputElement | null>(null)
const passwordInput = ref<HTMLInputElement | null>(null)
const username = ref(props.username)
const password = ref('')
const message = ref('')
const isSubmitting = ref(false)
let focusReturnTarget: HTMLElement | null = null
let focusAfterUpdate: HTMLInputElement | null = null

watch(
  () => props.open,
  async (isOpen, wasOpen) => {
    if (isOpen) {
      if (!wasOpen) {
        focusReturnTarget = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null
      }
      username.value = props.username
      password.value = ''
      message.value = ''
      await nextTick()
      usernameInput.value?.focus()
      return
    }
    if (!wasOpen) {
      return
    }
    const returnTarget = focusReturnTarget
    focusReturnTarget = null
    await nextTick()
    if (returnTarget?.isConnected) {
      returnTarget.focus()
    }
  },
  { immediate: true },
)

onUpdated(() => {
  if (!focusAfterUpdate?.isConnected) return
  focusAfterUpdate.focus()
  focusAfterUpdate = null
})

function focusableElements(): HTMLElement[] {
  if (!dialog.value) {
    return []
  }
  return Array.from(dialog.value.querySelectorAll<HTMLElement>(
    'input:not(:disabled), button:not(:disabled)',
  ))
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    message.value = '请重新登录或退出登录'
    return
  }
  if (event.key !== 'Tab') {
    return
  }
  const focusable = focusableElements()
  const first = focusable[0]
  const last = focusable.at(-1)
  if (!first || !last) {
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

function clearUsername(): void {
  focusAfterUpdate = usernameInput.value
  username.value = ''
}

function clearPassword(): void {
  focusAfterUpdate = passwordInput.value
  password.value = ''
}

async function submit(): Promise<void> {
  if (isSubmitting.value) {
    return
  }
  isSubmitting.value = true
  message.value = ''
  try {
    await props.login(username.value, password.value)
    password.value = ''
    emit('reauthenticated')
  } catch (error) {
    message.value = safeLoginErrorMessage(error)
  } finally {
    isSubmitting.value = false
  }
}

async function handleLogout(): Promise<void> {
  if (isSubmitting.value) {
    return
  }
  isSubmitting.value = true
  message.value = ''
  try {
    await props.logout()
  } catch {
    message.value = safeLogoutErrorMessage()
  } finally {
    isSubmitting.value = false
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
      class="admin-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reauth-title"
      @keydown="handleKeydown"
    >
      <header class="admin-dialog-header">
        <h2 id="reauth-title">
          登录已过期
        </h2>
        <p>重新登录后可以继续当前操作。</p>
      </header>

      <form @submit.prevent="submit">
        <div class="admin-field">
          <label for="reauth-username">用户名</label>
          <div class="admin-clearable-field">
            <input
              id="reauth-username"
              ref="usernameInput"
              v-model="username"
              name="username"
              type="text"
              autocomplete="username"
              maxlength="32"
              required
              :disabled="isSubmitting"
            >
            <ClearFieldButton
              v-if="username !== ''"
              label="清空用户名"
              :disabled="isSubmitting"
              @clear="clearUsername"
            />
          </div>
        </div>

        <div class="admin-field">
          <label for="reauth-password">密码</label>
          <div class="admin-clearable-field">
            <input
              id="reauth-password"
              ref="passwordInput"
              v-model="password"
              name="password"
              type="password"
              autocomplete="current-password"
              required
              :disabled="isSubmitting"
            >
            <ClearFieldButton
              v-if="password !== ''"
              label="清空密码"
              :disabled="isSubmitting"
              @clear="clearPassword"
            />
          </div>
        </div>

        <p
          class="admin-form-message"
          aria-live="polite"
        >
          {{ message }}
        </p>

        <div class="admin-dialog-actions">
          <button
            data-testid="reauth-logout"
            class="admin-secondary-button"
            type="button"
            :disabled="isSubmitting"
            @click="handleLogout"
          >
            退出登录
          </button>
          <button
            class="admin-primary-button"
            type="submit"
            :disabled="isSubmitting"
          >
            {{ isSubmitting ? '正在登录' : '重新登录' }}
          </button>
        </div>
      </form>
    </section>
  </div>
</template>
