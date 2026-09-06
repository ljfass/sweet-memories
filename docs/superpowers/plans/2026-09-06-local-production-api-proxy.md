# Local Production API Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pnpm dev` serve the local Vue frontend on loopback while proxying `/api` and `/media` to the fixed production origin, including safe administrator session-cookie translation and a persistent production-data warning.

**Architecture:** A focused Vite proxy helper owns the fixed upstream and all header/cookie translation. `vite.config.ts` only binds the loopback server and installs the helper. `AdminApp.vue` exposes the otherwise invisible risk boundary in development mode, with styling and component tests kept alongside the existing admin UI.

**Tech Stack:** Vue 3, TypeScript, Vite 7 proxy API, Vitest, Node HTTP types, CSS

---

### Task 1: Lock the development-server contract

**Files:**
- Create: `scripts/dev/production-api-proxy.test.ts`
- Modify: `vite.config.ts`
- Test: `scripts/dev/production-api-proxy.test.ts`

- [ ] **Step 1: Write the failing server-configuration tests**

Create `scripts/dev/production-api-proxy.test.ts` with a Node test environment. Import `vite.config.ts`, resolve the exported user config, and assert that the server binds only `127.0.0.1`, uses port `5173` with `strictPort: true`, and defines exactly `/api` and `/media` proxy entries. Assert for each entry that `target` is `https://huangjianfen.cn`, `changeOrigin` is true, `secure` is true, and `configure` is a function.

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import config from '../../vite.config'

describe('local production API development server', () => {
  it('binds only to loopback on the stable development port', () => {
    expect(config.server).toMatchObject({
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
    })
  })

  it('proxies only API and media paths to the fixed production origin', () => {
    expect(Object.keys(config.server?.proxy ?? {}).sort()).toEqual(['/api', '/media'])
    for (const route of ['/api', '/media']) {
      expect(config.server?.proxy?.[route]).toMatchObject({
        target: 'https://huangjianfen.cn',
        changeOrigin: true,
        secure: true,
      })
      expect(config.server?.proxy?.[route]).toHaveProperty('configure')
    }
  })
})
```

- [ ] **Step 2: Run the test to verify RED**

Run: `pnpm exec vitest run scripts/dev/production-api-proxy.test.ts`

Expected: FAIL because `vite.config.ts` does not define `server` or either proxy entry.

- [ ] **Step 3: Create the proxy configuration boundary**

Create `scripts/dev/production-api-proxy.ts`. Export these constants and factory:

```ts
import type { ProxyOptions } from 'vite'

export const PRODUCTION_ORIGIN = 'https://huangjianfen.cn'
export const PRODUCTION_SESSION_COOKIE = '__Host-sweet_memories_session'
export const LOCAL_SESSION_COOKIE = 'sweet_memories_dev_session'

function createProxyOptions(): ProxyOptions {
  return {
    target: PRODUCTION_ORIGIN,
    changeOrigin: true,
    secure: true,
    configure(proxy) {
      // Task 2 installs the request and response translators here.
    },
  }
}

export function createProductionApiProxy(): Record<string, ProxyOptions> {
  return {
    '/api': createProxyOptions(),
    '/media': createProxyOptions(),
  }
}
```

Modify `vite.config.ts` so the default `pnpm dev` command uses the helper:

```ts
import { createProductionApiProxy } from './scripts/dev/production-api-proxy'

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
    // Preserve the existing test configuration unchanged.
  },
})
```

- [ ] **Step 4: Run the test to verify GREEN**

Run: `pnpm exec vitest run scripts/dev/production-api-proxy.test.ts`

Expected: 2 tests PASS.

### Task 2: Translate production session cookies without forwarding local cookies

**Files:**
- Modify: `scripts/dev/production-api-proxy.test.ts`
- Modify: `scripts/dev/production-api-proxy.ts`
- Test: `scripts/dev/production-api-proxy.test.ts`

- [ ] **Step 1: Write failing request-translation tests**

Add tests for exported `rewriteProxyRequest`. Use a small fake request-header writer and an incoming request containing `cookie`. Verify that it always writes the production `Origin`, maps only a canonical 43-character base64url local session token to the production `__Host-` cookie name, and drops analytics or unrelated local cookies. Verify that missing or malformed local session tokens remove the outbound Cookie header.

```ts
const token = 'a'.repeat(43)
const writes = new Map<string, string>()
const proxyRequest = {
  setHeader: (name: string, value: string) => writes.set(name.toLowerCase(), value),
  removeHeader: (name: string) => writes.delete(name.toLowerCase()),
}

rewriteProxyRequest(proxyRequest, {
  headers: {
    cookie: `analytics=private; sweet_memories_dev_session=${token}; preference=dark`,
  },
})

expect(writes.get('origin')).toBe('https://huangjianfen.cn')
expect(writes.get('cookie')).toBe(`__Host-sweet_memories_session=${token}`)
```

- [ ] **Step 2: Write failing response-translation tests**

Add tests for exported `rewriteProxyResponse`. Verify that a production session cookie is renamed to `sweet_memories_dev_session`, its `Secure` attribute is removed case-insensitively, and HttpOnly, SameSite, Path, Max-Age, and Expires attributes remain unchanged. Cover the empty-value logout cookie and ensure unrelated upstream cookies are not exposed locally.

```ts
const response = {
  headers: {
    'set-cookie': [
      '__Host-sweet_memories_session=token; Path=/; HttpOnly; Secure; SameSite=Strict',
      'unrelated=private; Path=/; Secure',
    ],
  },
}

rewriteProxyResponse(response)

expect(response.headers['set-cookie']).toEqual([
  'sweet_memories_dev_session=token; Path=/; HttpOnly; SameSite=Strict',
])
```

- [ ] **Step 3: Run the tests to verify RED**

Run: `pnpm exec vitest run scripts/dev/production-api-proxy.test.ts`

Expected: FAIL because `rewriteProxyRequest` and `rewriteProxyResponse` do not exist.

- [ ] **Step 4: Implement minimal header and cookie translation**

In `scripts/dev/production-api-proxy.ts`, add narrow structural interfaces so tests do not need real sockets. Parse Cookie headers by splitting on semicolons and matching the local cookie name exactly. Accept only `/^[A-Za-z0-9_-]{43}$/`; otherwise call `removeHeader('cookie')`. Rewrite only `Set-Cookie` strings beginning with the exact production cookie name, replace the leading name once, remove exact `Secure` attributes, preserve all other attributes, and delete `set-cookie` when no production session cookie remains.

```ts
interface WritableProxyRequest {
  setHeader(name: string, value: string): void
  removeHeader(name: string): void
}

interface IncomingProxyRequest {
  readonly headers: { readonly cookie?: string }
}

interface MutableProxyResponse {
  readonly headers: { 'set-cookie'?: string[] }
}

export function rewriteProxyRequest(
  proxyRequest: WritableProxyRequest,
  request: IncomingProxyRequest,
): void {
  proxyRequest.setHeader('origin', PRODUCTION_ORIGIN)
  const token = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${LOCAL_SESSION_COOKIE}=`))
    ?.slice(LOCAL_SESSION_COOKIE.length + 1)

  if (token !== undefined && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    proxyRequest.setHeader('cookie', `${PRODUCTION_SESSION_COOKIE}=${token}`)
  } else {
    proxyRequest.removeHeader('cookie')
  }
}

export function rewriteProxyResponse(response: MutableProxyResponse): void {
  const cookies = response.headers['set-cookie']
    ?.filter((cookie) => cookie.startsWith(`${PRODUCTION_SESSION_COOKIE}=`))
    .map((cookie) => cookie
      .replace(PRODUCTION_SESSION_COOKIE, LOCAL_SESSION_COOKIE)
      .replace(/;\s*Secure(?=;|$)/gi, ''))

  if (cookies === undefined || cookies.length === 0) {
    delete response.headers['set-cookie']
  } else {
    response.headers['set-cookie'] = cookies
  }
}
```

Wire both translators into every proxy via `configure(proxy)`:

```ts
configure(proxy) {
  proxy.on('proxyReq', rewriteProxyRequest)
  proxy.on('proxyRes', rewriteProxyResponse)
}
```

- [ ] **Step 5: Run the tests to verify GREEN**

Run: `pnpm exec vitest run scripts/dev/production-api-proxy.test.ts`

Expected: all proxy tests PASS with no cookie values printed to output.

### Task 3: Warn administrators that local actions mutate production

**Files:**
- Modify: `src/admin/AdminApp.test.ts`
- Modify: `src/admin/AdminApp.vue`
- Modify: `src/styles/admin.css`
- Test: `src/admin/AdminApp.test.ts`

- [ ] **Step 1: Write the failing development-warning test**

Add an `AdminApp` integration test mounting an authenticated session. Verify the warning exists, has `role="status"`, uses a stable data attribute, and states exactly that local development is operating on production data.

```ts
it('keeps a production-data warning visible in local development', async () => {
  const wrapper = mount(AdminApp, {
    props: { session: session(), photoApi: photoApi([]), uploadApi: idleUploadApi() },
  })
  await flushPromises()

  const warning = wrapper.get('[data-production-proxy-warning]')
  expect(warning.attributes('role')).toBe('status')
  expect(warning.text()).toContain('本地开发模式：正在直接操作线上生产数据')
})
```

- [ ] **Step 2: Run the test to verify RED**

Run: `pnpm exec vitest run src/admin/AdminApp.test.ts -t 'production-data warning'`

Expected: FAIL because `[data-production-proxy-warning]` does not exist.

- [ ] **Step 3: Add the development-only warning**

In `src/admin/AdminApp.vue`, define `const isLocalProductionProxy = import.meta.env.DEV`. Render this non-dismissible status band directly inside `.admin-workspace`, before `.admin-workspace-content`, so reauthentication or photo dialogs cannot hide it.

```vue
<p
  v-if="isLocalProductionProxy"
  class="admin-production-proxy-banner"
  role="status"
  data-production-proxy-warning
>
  <strong>生产数据模式</strong>
  <span>本地开发模式：正在直接操作线上生产数据</span>
</p>
```

In `src/styles/admin.css`, add a compact full-width warning band with a warm warning surface, dark readable text, one-pixel block borders, wrapping content, and no viewport-fixed positioning.

```css
.admin-production-proxy-banner {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin: 0;
  padding: 10px 16px;
  border-block: 1px solid #e2aa62;
  background: #fff4e5;
  color: #713f12;
  line-height: 1.5;
}

.admin-production-proxy-banner strong {
  font-weight: 700;
}
```

- [ ] **Step 4: Run the focused admin test to verify GREEN**

Run: `pnpm exec vitest run src/admin/AdminApp.test.ts -t 'production-data warning'`

Expected: 1 test PASS.

### Task 4: Verify the complete local workflow

**Files:**
- Verify: `scripts/dev/production-api-proxy.ts`
- Verify: `scripts/dev/production-api-proxy.test.ts`
- Verify: `vite.config.ts`
- Verify: `src/admin/AdminApp.vue`
- Verify: `src/admin/AdminApp.test.ts`
- Verify: `src/styles/admin.css`

- [ ] **Step 1: Run focused regression tests**

Run: `pnpm exec vitest run scripts/dev/production-api-proxy.test.ts src/admin/AdminApp.test.ts`

Expected: both files PASS with no stderr warnings.

- [ ] **Step 2: Run repository verification**

Run these commands sequentially:

```bash
pnpm typecheck
pnpm lint
pnpm build:frontend
pnpm exec vitest run --exclude 'apps/api/dist/**'
git diff --check
```

Expected: every command exits 0. Do not run a production login, upload, edit, or delete during automated verification.

- [ ] **Step 3: Start the local frontend**

Run: `pnpm dev`

Expected: Vite listens at `http://127.0.0.1:5173/` and keeps running for the user.

- [ ] **Step 4: Verify read-only live proxy routes**

Run:

```bash
curl --fail --silent --show-error http://127.0.0.1:5173/api/health
curl --fail --silent --show-error http://127.0.0.1:5173/api/photos
curl --fail --silent --show-error --output /dev/null http://127.0.0.1:5173/admin
```

Expected: health returns `{"status":"ok"}`, photos returns the public JSON collection, and `/admin` returns HTTP 200. Read the first canonical media URL from the structured photo response and request the corresponding local `/media/...` URL; expect HTTP 200 and an image Content-Type.

- [ ] **Step 5: Review scope and preserve user work**

Run: `git status --short --branch`

Expected: the proxy/admin changes are visible, the existing user modification in `src/admin/PhotoLibrary.vue` remains present but untouched, and `.superpowers/` remains untracked and unstaged.

- [ ] **Step 6: Commit only the implementation scope**

Stage only:

```bash
git add \
  docs/superpowers/specs/2026-09-06-local-production-api-proxy-design.md \
  docs/superpowers/plans/2026-09-06-local-production-api-proxy.md \
  scripts/dev/production-api-proxy.ts \
  scripts/dev/production-api-proxy.test.ts \
  vite.config.ts \
  src/admin/AdminApp.vue \
  src/admin/AdminApp.test.ts \
  src/styles/admin.css
git commit -m "feat: proxy local development to the production API"
```

Expected: the commit excludes `src/admin/PhotoLibrary.vue` and `.superpowers/`.
