<script setup lang="ts">
import { onMounted } from 'vue'
import AdminLogin from './AdminLogin.vue'
import ReauthDialog from './ReauthDialog.vue'
import type { AdminSessionState } from './types'
import { useAdminSession } from './useAdminSession'

const props = defineProps<{
  session?: AdminSessionState
}>()

const session = props.session ?? useAdminSession()

onMounted(() => session.initialize())
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
      <header class="admin-toolbar">
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
            @click="session.logout"
          >
            退出登录
          </button>
        </div>
      </header>

      <section
        class="admin-library"
        data-testid="photo-library"
        aria-labelledby="photo-library-title"
      >
        <h2 id="photo-library-title">
          照片库
        </h2>
        <slot name="workspace">
          <p class="admin-empty-copy">
            照片库正在准备
          </p>
        </slot>
      </section>

      <ReauthDialog
        :open="session.status.value === 'reauth-required'"
        :username="session.username.value ?? ''"
        :login="session.login"
        :logout="session.logout"
      />
    </div>
  </div>
</template>
