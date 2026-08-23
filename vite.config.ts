import vue from '@vitejs/plugin-vue'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  base: './',
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    exclude: [...configDefaults.exclude, '**/.worktrees/**'],
    setupFiles: ['./tests/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
})
