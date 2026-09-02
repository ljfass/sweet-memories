import { createApp } from 'vue'
import App from './App.vue'
import AdminApp from './admin/AdminApp.vue'
import './styles/reset.css'
import './styles/theme.css'
import './styles/global.css'

export type RootName = 'admin' | 'public'

function normalizedPathname(pathname: string): string {
  if (!pathname.startsWith('/')) {
    return pathname
  }
  try {
    return new URL(`https://pathname.invalid${pathname}`).pathname
  } catch {
    return pathname
  }
}

export function selectRoot(pathname: string): RootName {
  const normalized = normalizedPathname(pathname)
  return normalized === '/admin' || normalized === '/admin/' ? 'admin' : 'public'
}

export async function mountSelectedRoot(pathname = window.location.pathname): Promise<void> {
  const root = selectRoot(pathname)
  if (root === 'admin') {
    await import('./styles/admin.css')
  }
  createApp(root === 'admin' ? AdminApp : App).mount('#app')
}

if (document.querySelector('#app')) {
  void mountSelectedRoot()
}
