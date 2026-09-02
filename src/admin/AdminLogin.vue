<script setup lang="ts">
import { ref } from 'vue'
import { safeLoginErrorMessage } from './api'

const props = defineProps<{
  login: (username: string, password: string) => Promise<void>
}>()

const username = ref('')
const password = ref('')
const isSubmitting = ref(false)
const errorMessage = ref('')

async function submit(): Promise<void> {
  if (isSubmitting.value) {
    return
  }
  isSubmitting.value = true
  errorMessage.value = ''
  try {
    await props.login(username.value, password.value)
    password.value = ''
  } catch (error) {
    errorMessage.value = safeLoginErrorMessage(error)
  } finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <main
    class="admin-login"
    aria-labelledby="admin-login-title"
  >
    <form
      class="admin-login-panel"
      @submit.prevent="submit"
    >
      <header class="admin-login-header">
        <p class="admin-eyebrow">
          甜蜜回忆
        </p>
        <h1 id="admin-login-title">
          相册管理
        </h1>
      </header>

      <div class="admin-field">
        <label for="admin-login-username">用户名</label>
        <input
          id="admin-login-username"
          v-model="username"
          name="username"
          type="text"
          autocomplete="username"
          maxlength="32"
          required
          :disabled="isSubmitting"
        >
      </div>

      <div class="admin-field">
        <label for="admin-login-password">密码</label>
        <input
          id="admin-login-password"
          v-model="password"
          name="password"
          type="password"
          autocomplete="current-password"
          required
          :disabled="isSubmitting"
        >
      </div>

      <p
        class="admin-form-message"
        aria-live="polite"
      >
        {{ errorMessage }}
      </p>

      <button
        class="admin-primary-button"
        type="submit"
        :disabled="isSubmitting"
      >
        {{ isSubmitting ? '正在登录' : '登录' }}
      </button>
    </form>
  </main>
</template>
