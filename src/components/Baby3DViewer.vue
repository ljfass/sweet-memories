<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import depthUrl from '../assets/3d/baby-1st-birthday-depth.jpg'
import imageUrl from '../assets/3d/baby-1st-birthday.jpg'

const canvasRef = ref<HTMLCanvasElement | null>(null)
const containerRef = ref<HTMLElement | null>(null)
const isLoading = ref(true)
const loadError = ref(false)

let gl: WebGLRenderingContext | null = null
let animationFrameId: number | null = null
let program: WebGLProgram | null = null

// 视差位置插值
let currentX = 0
let currentY = 0
let targetX = 0
let targetY = 0
let isPointerActive = false
let hasUserInteraction = false
let idleStartTime = 0

// 最大偏移量（适中幅度，既立体又不撕裂）
const MAX_OFFSET = 0.035

const vsSource = `
  attribute vec2 a_position;
  varying vec2 v_uv;
  void main() {
    v_uv = (a_position + 1.0) * 0.5;
    v_uv.y = 1.0 - v_uv.y;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`

const fsSource = `
  precision mediump float;
  uniform sampler2D u_image;
  uniform sampler2D u_depth;
  uniform vec2 u_offset;
  varying vec2 v_uv;

  void main() {
    float depth = texture2D(u_depth, v_uv).r;
    // 以深度0.35为焦点（宝宝主体），前景向前浮出，后景后退
    vec2 offset = u_offset * (depth - 0.35);
    vec2 uv = clamp(v_uv + offset, vec2(0.002), vec2(0.998));
    gl_FragColor = texture2D(u_image, uv);
  }
`

function createShader(glContext: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = glContext.createShader(type)
  if (!shader) return null
  glContext.shaderSource(shader, source)
  glContext.compileShader(shader)
  if (!glContext.getShaderParameter(shader, glContext.COMPILE_STATUS)) {
    console.error('Shader compile error:', glContext.getShaderInfoLog(shader))
    glContext.deleteShader(shader)
    return null
  }
  return shader
}

function initWebGL(): boolean {
  const canvas = canvasRef.value
  if (!canvas) return false

  gl = canvas.getContext('webgl', { preserveDrawingBuffer: false, antialias: true })
  if (!gl) {
    console.warn('WebGL not supported')
    return false
  }

  const vs = createShader(gl, gl.VERTEX_SHADER, vsSource)
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource)
  if (!vs || !fs) return false

  program = gl.createProgram()
  if (!program) return false

  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Program link error:', gl.getProgramInfoLog(program))
    return false
  }

  gl.useProgram(program)

  // 绑定全屏矩形
  const positionBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
  const positions = new Float32Array([
    -1, -1,
    1, -1,
    -1, 1,
    -1, 1,
    1, -1,
    1, 1,
  ])
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)

  const aPositionLocation = gl.getAttribLocation(program, 'a_position')
  gl.enableVertexAttribArray(aPositionLocation)
  gl.vertexAttribPointer(aPositionLocation, 2, gl.FLOAT, false, 0, 0)

  return true
}

function loadTexture(glContext: WebGLRenderingContext, url: string, textureUnit: number): Promise<WebGLTexture> {
  return new Promise((resolve, reject) => {
    const texture = glContext.createTexture()
    if (!texture) {
      reject(new Error('Failed to create texture'))
      return
    }

    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => {
      glContext.activeTexture(glContext.TEXTURE0 + textureUnit)
      glContext.bindTexture(glContext.TEXTURE_2D, texture)
      glContext.pixelStorei(glContext.UNPACK_FLIP_Y_WEBGL, false)
      glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_WRAP_S, glContext.CLAMP_TO_EDGE)
      glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_WRAP_T, glContext.CLAMP_TO_EDGE)
      glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_MIN_FILTER, glContext.LINEAR)
      glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_MAG_FILTER, glContext.LINEAR)
      glContext.texImage2D(glContext.TEXTURE_2D, 0, glContext.RGBA, glContext.RGBA, glContext.UNSIGNED_BYTE, image)
      resolve(texture)
    }
    image.onerror = (e) => reject(e)
    image.src = url
  })
}

function updatePointerOffset(e: PointerEvent) {
  if (!containerRef.value) return
  const rect = containerRef.value.getBoundingClientRect()
  const x = ((e.clientX - rect.left) / rect.width) * 2 - 1
  const y = ((e.clientY - rect.top) / rect.height) * 2 - 1

  targetX = -x * MAX_OFFSET
  targetY = y * MAX_OFFSET
}

function handlePointerDown(e: PointerEvent) {
  isPointerActive = true
  hasUserInteraction = true
  updatePointerOffset(e)
}

function handlePointerMove(e: PointerEvent) {
  if (e.pointerType === 'touch' && !isPointerActive) return
  hasUserInteraction = true
  updatePointerOffset(e)
}

function handlePointerEnd() {
  isPointerActive = false
  // 触控松开后允许恢复微呼吸动画或陀螺仪
  hasUserInteraction = false
}

function handleDeviceOrientation(e: DeviceOrientationEvent) {
  if (isPointerActive) return
  if (e.gamma === null || e.beta === null) return
  hasUserInteraction = true

  // gamma: 左右倾斜 -90 ~ 90
  // beta: 前后倾斜 -180 ~ 180 (通常手持手机时在 40 ~ 60 度左右)
  const normGamma = Math.min(Math.max(e.gamma / 30, -1), 1)
  const normBeta = Math.min(Math.max((e.beta - 45) / 30, -1), 1)

  targetX = -normGamma * MAX_OFFSET
  targetY = normBeta * MAX_OFFSET
}

function render(now: number) {
  if (!gl || !program || !canvasRef.value) return

  // 平滑插值 (Lerp)
  if (!hasUserInteraction) {
    if (!idleStartTime) idleStartTime = now
    const elapsed = (now - idleStartTime) * 0.0015
    // 空闲时极其微弱的轻柔漂浮感
    const idleX = Math.sin(elapsed) * (MAX_OFFSET * 0.25)
    const idleY = Math.cos(elapsed * 0.8) * (MAX_OFFSET * 0.15)
    targetX = idleX
    targetY = idleY
  }

  currentX += (targetX - currentX) * 0.08
  currentY += (targetY - currentY) * 0.08

  const uOffsetLocation = gl.getUniformLocation(program, 'u_offset')
  gl.uniform2f(uOffsetLocation, currentX, currentY)

  gl.viewport(0, 0, canvasRef.value.width, canvasRef.value.height)
  gl.drawArrays(gl.TRIANGLES, 0, 6)

  animationFrameId = requestAnimationFrame(render)
}

function resizeCanvas() {
  const canvas = canvasRef.value
  const container = containerRef.value
  if (!canvas || !container) return

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const width = container.clientWidth
  const height = container.clientHeight

  if (width && height) {
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
  }
}

function setupOrientationListener() {
  if (typeof window !== 'undefined' && 'DeviceOrientationEvent' in window) {
    window.removeEventListener('deviceorientation', handleDeviceOrientation)
    window.addEventListener('deviceorientation', handleDeviceOrientation, { passive: true })
  }
}

defineExpose({
  setupOrientationListener,
})

onMounted(async () => {
  if (!initWebGL()) {
    loadError.value = true
    isLoading.value = false
    return
  }

  resizeCanvas()
  window.addEventListener('resize', resizeCanvas)

  try {
    if (!gl || !program) return
    await Promise.all([
      loadTexture(gl, imageUrl, 0),
      loadTexture(gl, depthUrl, 1),
    ])

    const uImageLoc = gl.getUniformLocation(program, 'u_image')
    const uDepthLoc = gl.getUniformLocation(program, 'u_depth')
    gl.uniform1i(uImageLoc, 0)
    gl.uniform1i(uDepthLoc, 1)

    isLoading.value = false
    animationFrameId = requestAnimationFrame(render)

    setupOrientationListener()
  } catch (err) {
    console.error('Failed to load 3D textures:', err)
    loadError.value = true
    isLoading.value = false
  }
})

onBeforeUnmount(() => {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId)
  }
  window.removeEventListener('resize', resizeCanvas)
  window.removeEventListener('deviceorientation', handleDeviceOrientation)
  if (gl && program) {
    gl.deleteProgram(program)
  }
})
</script>

<template>
  <div
    ref="containerRef"
    class="baby-3d-container"
    @pointerdown="handlePointerDown"
    @pointermove="handlePointerMove"
    @pointerup="handlePointerEnd"
    @pointercancel="handlePointerEnd"
    @pointerleave="handlePointerEnd"
  >
    <div
      v-if="isLoading"
      class="baby-3d-loading"
    >
      <span class="loading-spinner" />
      <p>3D 记忆显影中...</p>
    </div>

    <div
      v-if="loadError"
      class="baby-3d-error"
    >
      <p>无法开启 3D 效果</p>
    </div>

    <canvas
      ref="canvasRef"
      class="baby-3d-canvas"
      :class="{ 'is-ready': !isLoading && !loadError }"
    />
  </div>
</template>

<style scoped>
.baby-3d-container {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-radius: 6px;
  background-color: #2b2527;
  touch-action: none;
  cursor: grab;
}

.baby-3d-container:active {
  cursor: grabbing;
}

.baby-3d-canvas {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  opacity: 0;
  transition: opacity 0.5s ease;
}

.baby-3d-canvas.is-ready {
  opacity: 1;
}

.baby-3d-loading,
.baby-3d-error {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 0.95rem;
  background: rgba(30, 20, 25, 0.7);
  z-index: 2;
  gap: 12px;
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid rgba(255, 255, 255, 0.2);
  border-top-color: #ff8fab;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
