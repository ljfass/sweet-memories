<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import Baby3DViewer from "./Baby3DViewer.vue";

defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();

const viewerRef = ref<InstanceType<typeof Baby3DViewer> | null>(null);
const gyroStatus = ref<
  "supported" | "granted" | "denied" | "insecure" | "unavailable"
>("unavailable");

function closeModal() {
  emit("close");
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    closeModal();
  }
}

// 检查设备陀螺仪能力及安全性
function checkGyroCapability() {
  if (typeof window === "undefined") return;

  // iOS / Chrome 安全策略：非安全上下文 (如 http://192.168.x.x) 禁止传感器
  if (
    !window.isSecureContext &&
    location.hostname !== "localhost" &&
    location.hostname !== "127.0.0.1"
  ) {
    gyroStatus.value = "insecure";
    return;
  }

  const DeviceOrientation = window.DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<"granted" | "denied">;
  };

  if (typeof DeviceOrientation?.requestPermission === "function") {
    gyroStatus.value = "supported";
  } else if ("DeviceOrientationEvent" in window) {
    gyroStatus.value = "granted";
  } else {
    gyroStatus.value = "unavailable";
  }
}

// 点击手动激活陀螺仪
async function enableGyro() {
  const DeviceOrientation = window.DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<"granted" | "denied">;
  };

  if (typeof DeviceOrientation?.requestPermission === "function") {
    try {
      const permission = await DeviceOrientation.requestPermission();
      if (permission === "granted") {
        gyroStatus.value = "granted";
        viewerRef.value?.setupOrientationListener();
      } else {
        gyroStatus.value = "denied";
      }
    } catch {
      gyroStatus.value = "denied";
    }
  }
}

const statusText = computed(() => {
  switch (gyroStatus.value) {
    case "insecure":
      return "滑动屏幕探索 3D (HTTPS部署后支持摇晃)";
    case "supported":
      return "点击开启手机倾斜感应 📱";
    case "granted":
      return "倾斜手机或滑动屏幕感受 3D 景深";
    default:
      return "滑动屏幕或移动鼠标感受 3D 景深";
  }
});

onMounted(() => {
  window.addEventListener("keydown", handleKeydown);
  checkGyroCapability();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleKeydown);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="fade-bounce">
      <div
        v-if="isOpen"
        class="baby-3d-backdrop"
        role="dialog"
        aria-modal="true"
        aria-label="宝宝一周岁 3D 空间记忆相片"
        @click.self="closeModal"
      >
        <div class="baby-3d-card">
          <button
            type="button"
            class="modal-close-btn"
            aria-label="关闭 3D 记忆相片"
            @click="closeModal"
          >
            ✕
          </button>

          <div class="polaroid-inner">
            <div class="viewer-wrapper">
              <Baby3DViewer ref="viewerRef" />
            </div>

            <div class="polaroid-caption">
              <h2 class="baby-title">我 1 岁啦！🎂</h2>
              <p class="baby-subtitle">
                来到这个美丽世界的珍贵心动定格 · 3D 空间印记
              </p>
              <button
                type="button"
                class="tip-badge"
                :class="{ 'is-clickable': gyroStatus === 'supported' }"
                @click="enableGyro"
              >
                <span class="tip-icon">✨</span>
                <span class="tip-text">{{ statusText }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.baby-3d-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(28, 20, 24, 0.78);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}

.baby-3d-card {
  position: relative;
  width: 100%;
  max-width: 440px;
  background: #fffdfa;
  border-radius: 14px;
  padding: 16px 16px 22px;
  box-shadow:
    0 20px 40px rgba(0, 0, 0, 0.35),
    0 2px 10px rgba(255, 143, 171, 0.2);
  transform: rotate(-1.5deg);
  transition: transform 0.3s ease;
}

@media (min-width: 768px) {
  .baby-3d-card:hover {
    transform: rotate(0deg) scale(1.01);
  }
}

.modal-close-btn {
  position: absolute;
  top: -14px;
  right: -14px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 2px solid #fff;
  background: #ff758f;
  color: #fff;
  font-size: 16px;
  font-weight: bold;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.2);
  z-index: 10;
  transition:
    transform 0.2s ease,
    background-color 0.2s ease;
}

.modal-close-btn:hover {
  transform: scale(1.1);
  background: #ff4d6d;
}

.viewer-wrapper {
  width: 100%;
  aspect-ratio: 3 / 4;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: inset 0 0 12px rgba(0, 0, 0, 0.15);
}

.polaroid-caption {
  margin-top: 14px;
  text-align: center;
}

.baby-title {
  margin: 0;
  font-size: 1.45rem;
  font-weight: 800;
  color: #593540;
  letter-spacing: 0.5px;
}

.baby-subtitle {
  margin: 6px 0 12px;
  font-size: 0.9rem;
  color: #8c7079;
}

.tip-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  background: rgba(255, 143, 171, 0.15);
  border: 1px solid rgba(255, 143, 171, 0.3);
  border-radius: 999px;
  color: #c94a6d;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: default;
}

.tip-badge.is-clickable {
  cursor: pointer;
  background: rgba(255, 143, 171, 0.25);
  border-color: #ff758f;
  transition:
    background-color 0.2s ease,
    transform 0.2s ease;
}

.tip-badge.is-clickable:hover {
  transform: scale(1.03);
  background: rgba(255, 143, 171, 0.35);
}

.tip-icon {
  font-size: 0.9rem;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.2);
  }
}

/* 动效 */
.fade-bounce-enter-active,
.fade-bounce-leave-active {
  transition: opacity 0.35s cubic-bezier(0.16, 1, 0.3, 1);
}

.fade-bounce-enter-active .baby-3d-card {
  transition:
    transform 0.45s cubic-bezier(0.34, 1.56, 0.64, 1),
    opacity 0.35s ease;
}

.fade-bounce-leave-active .baby-3d-card {
  transition:
    transform 0.25s cubic-bezier(0.16, 1, 0.3, 1),
    opacity 0.25s ease;
}

.fade-bounce-enter-from {
  opacity: 0;
}

.fade-bounce-enter-from .baby-3d-card {
  opacity: 0;
  transform: translateY(30px) scale(0.85) rotate(-5deg);
}

.fade-bounce-leave-to {
  opacity: 0;
}

.fade-bounce-leave-to .baby-3d-card {
  opacity: 0;
  transform: translateY(20px) scale(0.9);
}

@media (max-width: 480px) {
  .baby-3d-card {
    max-width: 92vw;
    padding: 12px 12px 18px;
    transform: none;
  }

  .baby-title {
    font-size: 1.25rem;
  }

  .baby-subtitle {
    font-size: 0.82rem;
  }
}
</style>
