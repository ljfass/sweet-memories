import { onMounted, onUnmounted, readonly, ref, type Ref } from 'vue'

export type AudioStatus = 'idle' | 'loading' | 'playing' | 'error'

const PLAYBACK_ERROR_MESSAGE = '音乐暂时无法播放'

export function useAudioPlayer(audioElement: Ref<HTMLAudioElement | null>) {
  const status = ref<AudioStatus>('idle')
  const errorMessage = ref('')

  const handlePlay = () => {
    status.value = 'playing'
    errorMessage.value = ''
  }

  const handlePause = () => {
    status.value = 'idle'
  }

  const handleError = () => {
    status.value = 'error'
    errorMessage.value = PLAYBACK_ERROR_MESSAGE
  }

  const togglePlayback = async () => {
    const audio = audioElement.value
    if (!audio) {
      handleError()
      return
    }

    if (status.value === 'playing') {
      audio.pause()
      return
    }

    status.value = 'loading'
    errorMessage.value = ''

    try {
      await audio.play()
      handlePlay()
    } catch {
      handleError()
    }
  }

  onMounted(() => {
    const audio = audioElement.value
    if (!audio) return

    audio.addEventListener('play', handlePlay)
    audio.addEventListener('pause', handlePause)
    audio.addEventListener('ended', handlePause)
    audio.addEventListener('error', handleError)
  })

  onUnmounted(() => {
    const audio = audioElement.value
    if (!audio) return

    audio.removeEventListener('play', handlePlay)
    audio.removeEventListener('pause', handlePause)
    audio.removeEventListener('ended', handlePause)
    audio.removeEventListener('error', handleError)
  })

  return {
    status: readonly(status),
    errorMessage: readonly(errorMessage),
    togglePlayback,
  }
}
