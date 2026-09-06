<script setup lang="ts">
import { ref, onMounted } from 'vue'
import {
  AlertCircle,
  LoaderCircle,
  Eye,
  EyeOff,
  User,
  Lock,
  Sparkles,
  Camera,
  Heart,
  ArrowLeft,
} from '@lucide/vue'
import gsap from 'gsap'
import { safeLoginErrorMessage } from './api'

const props = defineProps<{
  login: (username: string, password: string) => Promise<void>
}>()

const username = ref('')
const password = ref('')
const showPassword = ref(false)
const isSubmitting = ref(false)
const errorMessage = ref('')

const usernameInput = ref<HTMLInputElement | null>(null)
const loginCard = ref<HTMLElement | null>(null)
const loginForm = ref<HTMLElement | null>(null)

onMounted(() => {
  usernameInput.value?.focus()

  if (loginCard.value) {
    gsap.from(loginCard.value, {
      y: 28,
      opacity: 0,
      scale: 0.98,
      duration: 0.7,
      ease: 'power3.out',
    })
  }
})

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
    if (loginForm.value) {
      gsap.fromTo(
        loginForm.value,
        { x: -8 },
        {
          x: 8,
          duration: 0.08,
          yoyo: true,
          repeat: 3,
          clearProps: 'x',
        },
      )
    }
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
    <!-- 动态暖光与星芒点阵背景 -->
    <div
      class="ambient-glow glow-berry"
      aria-hidden="true"
    />
    <div
      class="ambient-glow glow-amber"
      aria-hidden="true"
    />
    <div
      class="ambient-glow glow-teal"
      aria-hidden="true"
    />
    <div
      class="dot-grid-canvas"
      aria-hidden="true"
    />

    <!-- 典雅双栏画廊展板容器 -->
    <div
      ref="loginCard"
      class="admin-split-card"
    >
      <!-- 左侧：品牌与情感叙事区 (Personal & Heartfelt Story) -->
      <section
        class="brand-showcase-pane"
        aria-hidden="true"
      >
        <div class="showcase-content">
          <div class="brand-badge-header">
            <span class="brand-mark-stamp">忆</span>
            <div class="brand-badge-text">
              <span class="brand-en">FOR MY BOY</span>
              <span class="brand-zh">儿子的成长日常</span>
            </div>
          </div>

          <div class="brand-quote-block">
            <h2 class="brand-hero-title">
              陪你慢慢长大。
            </h2>
            <p class="brand-hero-desc">
              把你的童年写成光，把日常存成宝藏。
            </p>
          </div>

          <!-- 艺术感拟物拍立得卡片 -->
          <div class="showcase-polaroid">
            <div class="polaroid-tape" />
            <div class="polaroid-frame">
              <div class="polaroid-inner">
                <Camera
                  class="polaroid-icon"
                  :size="28"
                />
                <span class="polaroid-title">My Little Adventurer</span>
                <span class="polaroid-date">日常碎片 · 珍贵定格</span>
              </div>
            </div>
            <div class="polaroid-caption">
              <span class="caption-text">今天也超级开心</span>
              <Heart
                class="caption-heart"
                :size="15"
              />
            </div>
          </div>

          <div class="showcase-footer">
            <Heart
              class="footer-heart"
              :size="15"
            />
            <span>爸爸的私人镜头 · 爱与成长</span>
          </div>
        </div>
      </section>

      <!-- 右侧：高精度交互登录面板 (Sign-In Console) -->
      <section class="login-console-pane">
        <form
          ref="loginForm"
          class="admin-login-panel"
          @submit.prevent="submit"
        >
          <header class="admin-login-header">
            <div class="header-pretitle">
              <Sparkles
                class="pretitle-sparkle"
                :size="14"
              />
              <p class="admin-eyebrow">
                甜蜜回忆 · 管理后台
              </p>
            </div>
            <h1 id="admin-login-title">
              相册管理
            </h1>
            <p class="header-subtitle">
              登录以记录儿子新的成长瞬间
            </p>
          </header>

          <!-- 用户名输入区 -->
          <div class="admin-field">
            <label for="admin-login-username">用户名</label>
            <div class="input-shell">
              <User
                class="field-icon"
                :size="18"
                aria-hidden="true"
              />
              <input
                id="admin-login-username"
                ref="usernameInput"
                v-model="username"
                name="username"
                type="text"
                autocomplete="username"
                maxlength="32"
                required
                placeholder="请输入管理员用户名"
                :disabled="isSubmitting"
              >
            </div>
          </div>

          <!-- 密码输入区 -->
          <div class="admin-field">
            <label for="admin-login-password">密码</label>
            <div class="input-shell">
              <Lock
                class="field-icon"
                :size="18"
                aria-hidden="true"
              />
              <input
                id="admin-login-password"
                v-model="password"
                name="password"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="current-password"
                required
                placeholder="请输入访问密码"
                :disabled="isSubmitting"
              >
              <button
                type="button"
                class="password-toggle"
                :title="showPassword ? '隐藏密码' : '显示密码'"
                :aria-label="showPassword ? '隐藏密码' : '显示密码'"
                @click="showPassword = !showPassword"
              >
                <EyeOff
                  v-if="showPassword"
                  :size="18"
                />
                <Eye
                  v-else
                  :size="18"
                />
              </button>
            </div>
          </div>

          <!-- 错误信息反馈（预留高度防抖动） -->
          <div class="message-container">
            <div
              v-show="errorMessage"
              class="error-banner"
            >
              <AlertCircle
                class="error-icon"
                :size="16"
                aria-hidden="true"
              />
              <p
                class="admin-form-message is-error"
                aria-live="polite"
              >
                {{ errorMessage }}
              </p>
            </div>
          </div>

          <!-- 提交按钮 -->
          <button
            class="admin-primary-button submit-btn"
            type="submit"
            :disabled="isSubmitting"
          >
            <span class="btn-inner">
              <LoaderCircle
                v-if="isSubmitting"
                class="spinner"
                :size="18"
              />
              <span>{{ isSubmitting ? '正在进入...' : '进入相册后台' }}</span>
            </span>
          </button>

          <!-- 辅助返回通道 -->
          <footer class="form-footer-nav">
            <a
              href="/"
              class="back-gallery-link"
            >
              <ArrowLeft :size="14" />
              <span>返回公开相册首页</span>
            </a>
            <span class="shortcut-tip">按 Enter 键快速提交</span>
          </footer>
        </form>
      </section>
    </div>
  </main>
</template>

<style scoped>
/* ================= 全局容器与氛围背景 ================= */
.admin-login {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 32px 20px;
  overflow: hidden;
  background: radial-gradient(circle at 18% 20%, #fff7ed 0%, #fdf2f4 42%, #faf5f6 100%);
  font-family: var(--admin-sans, system-ui, -apple-system, sans-serif);
  color: var(--admin-text, #2d292c);
  box-sizing: border-box;
}

/* 优雅时光星芒点阵纹理 */
.dot-grid-canvas {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: radial-gradient(rgb(209 179 189 / 45%) 1.2px, transparent 1.2px);
  background-size: 24px 24px;
  opacity: 0.55;
  mask-image: radial-gradient(circle at center, black 50%, transparent 95%);
}

/* 动态柔光浮动光晕 (Ambient Glow Orbs) */
.ambient-glow {
  position: absolute;
  border-radius: 50%;
  pointer-events: none;
  filter: blur(85px);
  opacity: 0.42;
  animation: floatGlow 14s ease-in-out infinite alternate;
}

.glow-berry {
  top: -60px;
  right: 5%;
  width: 440px;
  height: 440px;
  background: radial-gradient(circle, #fbcfe8 0%, #f472b6 60%, transparent 80%);
}

.glow-amber {
  bottom: -80px;
  left: 6%;
  width: 460px;
  height: 460px;
  background: radial-gradient(circle, #fef3c7 0%, #fcd34d 50%, transparent 80%);
  animation-delay: -5s;
}

.glow-teal {
  top: 45%;
  left: 38%;
  width: 320px;
  height: 320px;
  background: radial-gradient(circle, #ccfbf1 0%, #99f6e4 60%, transparent 80%);
  opacity: 0.28;
  animation-delay: -9s;
}

@keyframes floatGlow {
  0% {
    transform: translate(0, 0) scale(1);
  }
  50% {
    transform: translate(25px, -20px) scale(1.08);
  }
  100% {
    transform: translate(-20px, 20px) scale(0.96);
  }
}

/* ================= 典雅双栏卡片容器 ================= */
.admin-split-card {
  position: relative;
  z-index: 2;
  display: grid;
  grid-template-columns: 1fr 1.12fr;
  width: min(100%, 940px);
  min-height: 580px;
  border: 1px solid rgb(255 255 255 / 90%);
  border-radius: 28px;
  background: rgb(255 255 255 / 78%);
  backdrop-filter: blur(24px) saturate(140%);
  box-shadow:
    0 24px 60px -12px rgb(184 64 97 / 10%),
    0 12px 28px -6px rgb(45 41 44 / 6%),
    inset 0 1px 1px rgb(255 255 255 / 95%);
  overflow: hidden;
}

/* ================= 左侧：品牌与故事展示 ================= */
.brand-showcase-pane {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 48px 42px;
  background: linear-gradient(150deg, #fff3f5 0%, #fef7ed 50%, #fbf3f5 100%);
  border-right: 1px solid rgb(223 214 218 / 60%);
}

.showcase-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  justify-content: space-between;
  gap: 28px;
}

.brand-badge-header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.brand-mark-stamp {
  display: grid;
  width: 44px;
  height: 44px;
  border: 1px solid #8f2f4a;
  border-radius: 10px;
  color: #ffffff;
  background: var(--admin-berry, #b84061);
  box-shadow: 4px 4px 0 #eed0d9;
  font-family: var(--admin-serif, "Songti SC", serif);
  font-size: 1.25rem;
  font-weight: 700;
  place-items: center;
  user-select: none;
}

.brand-badge-text {
  display: flex;
  flex-direction: column;
}

.brand-en {
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  color: var(--admin-berry, #b84061);
}

.brand-zh {
  font-size: 0.88rem;
  font-weight: 600;
  color: #61565c;
  letter-spacing: 0.04em;
}

.brand-quote-block {
  margin-top: 4px;
}

.brand-hero-title {
  margin: 0 0 12px;
  font-family: var(--admin-serif, "Songti SC", "Noto Serif SC", serif);
  font-size: 1.85rem;
  font-weight: 800;
  line-height: 1.35;
  color: #2b2529;
  letter-spacing: 0.02em;
}

.brand-hero-desc {
  margin: 0;
  font-size: 0.92rem;
  line-height: 1.65;
  color: #6e646a;
}

/* 拟物拍立得照片卡片 */
.showcase-polaroid {
  position: relative;
  align-self: flex-start;
  width: 210px;
  padding: 10px 10px 14px;
  border-radius: 8px;
  background: #ffffff;
  box-shadow: 0 12px 30px rgb(184 64 97 / 13%), 0 2px 6px rgb(0 0 0 / 4%);
  transform: rotate(-2.5deg);
  transition: transform 0.3s ease, box-shadow 0.3s ease;
}

.showcase-polaroid:hover {
  transform: rotate(0deg) scale(1.02);
  box-shadow: 0 16px 36px rgb(184 64 97 / 18%);
}

.polaroid-tape {
  position: absolute;
  top: -10px;
  left: 40%;
  width: 50px;
  height: 18px;
  background: rgb(239 169 90 / 45%);
  backdrop-filter: blur(2px);
  transform: rotate(3deg);
  border-radius: 2px;
}

.polaroid-frame {
  border-radius: 4px;
  overflow: hidden;
}

.polaroid-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 110px;
  gap: 6px;
  background: linear-gradient(135deg, #fce7f3 0%, #fee2e2 50%, #fed7aa 100%);
  color: #9d174d;
}

.polaroid-icon {
  color: var(--admin-berry, #b84061);
}

.polaroid-title {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.polaroid-date {
  font-size: 0.65rem;
  color: #a85268;
}

.polaroid-caption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  padding: 0 4px;
}

.caption-text {
  font-family: var(--admin-serif, "Songti SC", serif);
  font-size: 0.8rem;
  font-weight: 600;
  color: #4a4046;
}

.caption-heart {
  color: #ff6b81;
  fill: #ff6b81;
}

.showcase-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.78rem;
  color: #8c8288;
}

.footer-heart {
  color: var(--admin-berry, #b84061);
  fill: rgb(184 64 97 / 20%);
}

/* ================= 右侧：交互登录控制台 ================= */
.login-console-pane {
  display: flex;
  align-items: center;
  padding: 48px 46px;
  background: rgb(255 255 255 / 92%);
}

.admin-login-panel {
  width: 100%;
  border: none;
  padding: 0;
  background: transparent;
  box-shadow: none;
}

.admin-login-header {
  margin-bottom: 24px;
}

.header-pretitle {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.pretitle-sparkle {
  color: var(--admin-berry, #b84061);
}

.admin-eyebrow {
  margin: 0;
  font-size: 0.8rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--admin-berry, #b84061);
}

#admin-login-title {
  margin: 4px 0 6px;
  font-family: var(--admin-serif, "Songti SC", "Noto Serif SC", serif);
  font-size: 2.1rem;
  font-weight: 800;
  letter-spacing: -0.01em;
  color: #241e21;
}

.header-subtitle {
  margin: 0;
  font-size: 0.88rem;
  color: #786f75;
}

/* 表单输入项 */
.admin-field {
  display: grid;
  gap: 7px;
  margin-top: 18px;
}

.admin-field label {
  font-size: 0.88rem;
  font-weight: 700;
  color: #3b3337;
}

.input-shell {
  position: relative;
  display: flex;
  align-items: center;
}

.field-icon {
  position: absolute;
  left: 14px;
  pointer-events: none;
  color: #9d9499;
  transition: color 0.2s ease;
}

.input-shell input {
  width: 100%;
  min-height: 48px;
  padding: 12px 42px 12px 42px;
  border: 1.5px solid #dfd5d9;
  border-radius: 12px;
  background: #ffffff;
  font-family: inherit;
  font-size: 0.95rem;
  color: #2d292c;
  box-sizing: border-box;
  transition:
    border-color 0.2s ease,
    background-color 0.2s ease,
    box-shadow 0.2s ease;
}

.input-shell input::placeholder {
  color: #aba1a7;
  font-size: 0.9rem;
}

.input-shell input:hover:not(:disabled) {
  border-color: #c9bcc2;
  background: #faf8f9;
}

.input-shell:focus-within .field-icon {
  color: var(--admin-berry, #b84061);
}

.input-shell input:focus-visible {
  outline: none;
  border-color: var(--admin-berry, #b84061);
  background: #ffffff;
  box-shadow: 0 0 0 4px rgb(184 64 97 / 13%);
}

.password-toggle {
  position: absolute;
  right: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #8c8288;
  cursor: pointer;
  transition: color 0.2s ease, transform 0.2s ease;
}

.password-toggle:hover {
  color: #2d292c;
  transform: scale(1.08);
}

.password-toggle:focus-visible {
  outline: 2px solid var(--admin-teal, #39767a);
  outline-offset: 2px;
}

/* 错误提示容器（固定最小高度消除 CLS 布局偏移） */
.message-container {
  min-height: 48px;
  margin: 6px 0;
  display: flex;
  align-items: center;
}

.error-banner {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 8px;
  padding: 9px 12px;
  border: 1px solid #fecdd3;
  border-radius: 10px;
  background: #fff1f2;
}

.error-icon {
  flex: 0 0 auto;
  color: #e11d48;
}

.admin-form-message {
  margin: 0 !important;
  font-size: 0.88rem;
  font-weight: 600;
  color: #9f1239;
  line-height: 1.4;
}

/* 质感主按钮 */
.submit-btn {
  width: 100%;
  min-height: 48px;
  margin-top: 4px;
  border: none;
  border-radius: 12px;
  color: #ffffff;
  background: linear-gradient(135deg, #b84061 0%, #c9496d 100%);
  font-family: inherit;
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  box-shadow: 0 8px 24px -4px rgb(184 64 97 / 36%);
  cursor: pointer;
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease,
    opacity 0.2s ease;
}

.submit-btn:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 12px 28px -4px rgb(184 64 97 / 46%);
}

.submit-btn:active:not(:disabled) {
  transform: translateY(0);
}

.submit-btn:disabled {
  opacity: 0.72;
  cursor: wait;
}

.btn-inner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* 底部辅助链接 */
.form-footer-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 24px;
  padding-top: 14px;
  border-top: 1px solid rgb(223 214 218 / 60%);
  font-size: 0.84rem;
}

.back-gallery-link {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #695f64;
  text-decoration: none;
  font-weight: 600;
  transition: color 0.2s ease, transform 0.2s ease;
}

.back-gallery-link:hover {
  color: var(--admin-berry, #b84061);
  transform: translateX(-2px);
}

.shortcut-tip {
  color: #a89fa4;
  font-size: 0.78rem;
}

/* ================= 移动端 / 窄屏响应式 ================= */
@media (max-width: 860px) {
  .admin-split-card {
    grid-template-columns: 1fr;
    min-height: auto;
    border-radius: 22px;
  }

  .brand-showcase-pane {
    padding: 32px 28px 24px;
    border-right: none;
    border-bottom: 1px solid rgb(223 214 218 / 60%);
  }

  .showcase-content {
    gap: 18px;
  }

  .showcase-polaroid {
    display: none;
  }

  .brand-hero-title {
    font-size: 1.45rem;
    margin-bottom: 6px;
  }

  .brand-hero-desc {
    font-size: 0.86rem;
  }

  .login-console-pane {
    padding: 32px 28px 36px;
  }

  #admin-login-title {
    font-size: 1.75rem;
  }
}

@media (max-width: 480px) {
  .admin-login {
    padding: 16px 12px;
  }

  .brand-showcase-pane {
    padding: 24px 20px 20px;
  }

  .login-console-pane {
    padding: 24px 20px 28px;
  }

  .form-footer-nav {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
}
</style>
