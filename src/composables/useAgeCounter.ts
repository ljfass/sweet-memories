import { onScopeDispose, readonly, ref } from 'vue'
import { calculateAge } from '../utils/calculateAge'

export function useAgeCounter(birthDate: Date) {
  const age = ref(calculateAge(birthDate))

  const update = () => {
    age.value = calculateAge(birthDate)
  }

  const timer = window.setInterval(update, 1000)

  onScopeDispose(() => {
    window.clearInterval(timer)
  })

  return readonly(age)
}
