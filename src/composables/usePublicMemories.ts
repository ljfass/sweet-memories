import { computed, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import albumSource from '../config/album-source.json'
import { memories as staticMemories } from '../data/memories'
import { fetchPublicPhotos } from '../services/photoApi'
import type { Memory } from '../types/album'

export type AlbumSourceMode = 'static' | 'api'
export type PublicMemoriesStatus = 'loading' | 'ready' | 'error'

export interface AlbumSourceConfig {
  readonly mode: AlbumSourceMode
}

export interface PublicMemoriesState {
  readonly memories: Readonly<Ref<readonly Memory[]>>
  readonly status: Readonly<Ref<PublicMemoriesStatus>>
  retry(): Promise<void>
}

export interface UsePublicMemoriesOptions {
  readonly config?: unknown
  readonly load?: (signal: AbortSignal) => Promise<readonly Memory[]>
}

export function parseAlbumSourceConfig(value: unknown): AlbumSourceConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('相册数据源配置无效')
  }
  const keys = Object.keys(value)
  const mode = Reflect.get(value, 'mode')
  if (keys.length !== 1 || keys[0] !== 'mode' || (mode !== 'static' && mode !== 'api')) {
    throw new Error('相册数据源配置无效')
  }
  return { mode }
}

export function usePublicMemories(
  options: UsePublicMemoriesOptions = {},
): PublicMemoriesState {
  const config = parseAlbumSourceConfig(options.config ?? albumSource)
  const memoryList = ref<readonly Memory[]>(config.mode === 'static' ? staticMemories : [])
  const statusState = ref<PublicMemoriesStatus>(config.mode === 'static' ? 'ready' : 'loading')
  const memories = computed(() => memoryList.value)
  const status = computed(() => statusState.value)
  const load = options.load ?? ((signal: AbortSignal) => fetchPublicPhotos({ signal }))
  let mounted = false
  let requestSequence = 0
  let activeRequest: Promise<void> | null = null
  let activeController: AbortController | null = null

  function requestMemories(): Promise<void> {
    if (config.mode === 'static' || !mounted) {
      return Promise.resolve()
    }
    if (activeRequest !== null) {
      return activeRequest
    }

    const sequence = ++requestSequence
    const controller = new AbortController()
    activeController = controller
    statusState.value = 'loading'

    const request = load(controller.signal)
      .then((loadedMemories) => {
        if (!mounted || controller.signal.aborted || sequence !== requestSequence) {
          return
        }
        memoryList.value = Object.freeze([...loadedMemories])
        statusState.value = 'ready'
      })
      .catch(() => {
        if (!mounted || controller.signal.aborted || sequence !== requestSequence) {
          return
        }
        statusState.value = 'error'
      })
      .finally(() => {
        if (sequence === requestSequence) {
          activeRequest = null
          activeController = null
        }
      })

    activeRequest = request
    return request
  }

  onMounted(() => {
    mounted = true
    if (config.mode === 'api') {
      void requestMemories()
    }
  })

  onBeforeUnmount(() => {
    mounted = false
    requestSequence += 1
    activeController?.abort()
    activeController = null
    activeRequest = null
  })

  return {
    memories,
    status,
    retry: requestMemories,
  }
}
