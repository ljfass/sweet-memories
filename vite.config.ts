import vue from '@vitejs/plugin-vue'
import { configDefaults, defineConfig } from 'vitest/config'

import { createProductionApiProxy } from './scripts/dev/production-api-proxy.ts'

export default defineConfig({
  base: './',
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: createProductionApiProxy(),
  },
  test: {
    environment: 'happy-dom',
    exclude: [...configDefaults.exclude, '**/.worktrees/**'],
    setupFiles: ['./tests/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
})
