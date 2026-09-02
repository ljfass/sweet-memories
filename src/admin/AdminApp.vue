<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import AdminLogin from './AdminLogin.vue'
import PhotoLibrary from './PhotoLibrary.vue'
import ReauthDialog from './ReauthDialog.vue'
import { AdminApi, safeLogoutErrorMessage } from './api'
import type { AdminPhotoApiClient, AdminSessionState } from './types'
import { usePhotoLibrary } from './usePhotoLibrary'
import { useAdminSession } from './useAdminSession'

const props = defineProps<{
  session?: AdminSessionState
  photoApi?: AdminPhotoApiClient
}>()

const defaultApi = new AdminApi()
const session = props.session ?? useAdminSession(defaultApi)
const photoLibrary = usePhotoLibrary(props.photoApi ?? defaultApi, session.csrfToken)
const logoutMessage = ref('')
const isLoggingOut = ref(false)
const isPhotoModalOpen = ref(false)

async function logout(): Promise<void> {
  if (isLoggingOut.value) {
    return
  }
  isLoggingOut.value = true
  logoutMessage.value = ''
  try {
    await session.logout()
  } catch {
    logoutMessage.value = safeLogoutErrorMessage()
  } finally {
    isLoggingOut.value = false
  }
}

onMounted(() => session.initialize())

watch(
  () => session.status.value,
  (status) => {
    if (status === 'authenticated' && photoLibrary.status.value === 'idle') {
      void photoLibrary.load()
    }
  },
  { immediate: true },
)
</script>

<template>
  <div class="admin-app">
    <main
      v-if="session.status.value === 'checking'"
      class="admin-checking"
      aria-live="polite"
    >
      正在检查登录状态
    </main>

    <AdminLogin
      v-else-if="session.status.value === 'anonymous'"
      :login="session.login"
    />

    <div
      v-else
      class="admin-workspace"
    >
      <header
        class="admin-toolbar"
        :inert="isPhotoModalOpen"
        :aria-hidden="isPhotoModalOpen ? 'true' : undefined"
      >
        <div>
          <p class="admin-eyebrow">
            甜蜜回忆
          </p>
          <h1>相册管理</h1>
        </div>
        <div class="admin-toolbar-actions">
          <span class="admin-username">{{ session.username.value }}</span>
          <button
            class="admin-secondary-button"
            type="button"
            :disabled="isLoggingOut"
            @click="logout"
          >
            退出登录
          </button>
        </div>
      </header>

      <p
        class="admin-session-message"
        aria-live="polite"
        :aria-hidden="isPhotoModalOpen ? 'true' : undefined"
      >
        {{ logoutMessage }}
      </p>

      <section
        class="admin-library"
        data-testid="photo-library"
        aria-labelledby="photo-library-title"
      >
        <h2
          id="photo-library-title"
          tabindex="-1"
          :inert="isPhotoModalOpen"
          :aria-hidden="isPhotoModalOpen ? 'true' : undefined"
        >
          照片库
        </h2>
        <slot name="workspace">
          <PhotoLibrary
            :library="photoLibrary"
            @mobile-modal-change="isPhotoModalOpen = $event"
          />
        </slot>
      </section>

      <ReauthDialog
        :open="session.status.value === 'reauth-required'"
        :username="session.username.value ?? ''"
        :login="session.login"
        :logout="logout"
      />
    </div>
  </div>
</template>
