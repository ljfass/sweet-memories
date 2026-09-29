# Mobile Album Floating Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在移动端相册原操作区滚出视口后显示 A3 右上悬浮操作胶囊，并让刷新在原地完成、保持照片内容和滚动上下文。

**Architecture:** `usePhotoLibrary` 增加独立的刷新状态，让已有照片刷新时保持 `ready` 和照片网格不卸载；`PhotoLibrary` 用 `IntersectionObserver` 监听原操作区，复用同一组上传/刷新处理函数控制原按钮与悬浮胶囊。CSS 只在移动断点启用固定胶囊，使用 safe-area 和无障碍属性避免重复控件。

**Tech Stack:** Vue 3 `<script setup>`, TypeScript, Vitest + Vue Test Utils, CSS media queries, `IntersectionObserver`。

---

### Task 1: 为原地刷新建立状态契约

**Files:**
- Modify: `src/admin/types.ts:124-144`
- Modify: `src/admin/usePhotoLibrary.ts:143-161,326-334`
- Test: `src/admin/usePhotoLibrary.test.ts`

- [ ] **Step 1: 写刷新期间保留内容的失败测试**

在 `describe('usePhotoLibrary')` 中加入以下测试，使用已有 `deferred` 和 `fakeApi` 辅助函数：

```ts
it('keeps the current snapshot and exposes a separate refresh state while refreshing', async () => {
  const pending = deferred<readonly AdminPhoto[]>()
  const api = fakeApi()
  vi.mocked(api.listPhotos).mockImplementationOnce(() => pending.promise)
  const library = usePhotoLibrary(api, ref('csrf-token'))
  await library.load()

  const refreshing = library.refresh()

  expect(library.isRefreshing.value).toBe(true)
  expect(library.status.value).toBe('ready')
  expect(library.photos.value).toHaveLength(1)

  pending.resolve([photo({ title: '刷新后的照片', version: 2 })])
  await refreshing

  expect(library.isRefreshing.value).toBe(false)
  expect(library.status.value).toBe('ready')
  expect(library.photos.value[0]).toMatchObject({ title: '刷新后的照片', version: 2 })
})
```

- [ ] **Step 2: 写重复刷新和失败保留上下文的失败测试**

加入两个独立测试：

```ts
it('does not start a second refresh while the first refresh is pending', async () => {
  const pending = deferred<readonly AdminPhoto[]>()
  const api = fakeApi()
  vi.mocked(api.listPhotos).mockImplementationOnce(() => pending.promise)
  const library = usePhotoLibrary(api, ref('csrf-token'))
  await library.load()

  const first = library.refresh()
  const second = library.refresh()

  expect(api.listPhotos).toHaveBeenCalledTimes(1)
  expect(library.isRefreshing.value).toBe(true)
  pending.resolve([photo()])
  await Promise.all([first, second])
  expect(library.isRefreshing.value).toBe(false)
})

it('keeps the existing photos and ready status when an in-place refresh fails', async () => {
  const api = fakeApi()
  const library = usePhotoLibrary(api, ref('csrf-token'))
  await library.load()
  vi.mocked(api.listPhotos).mockRejectedValueOnce(new AdminApiError('unavailable', 'private'))

  await library.refresh()

  expect(library.status.value).toBe('ready')
  expect(library.photos.value).toHaveLength(1)
  expect(library.messageFor('library')).toBe('暂时无法加载照片，请稍后重试')
  expect(library.isRefreshing.value).toBe(false)
})
```

- [ ] **Step 3: 运行 RED 测试**

运行：

```bash
source ~/.nvm/nvm.sh && nvm use 24.20.0 >/dev/null
pnpm exec vitest run src/admin/usePhotoLibrary.test.ts
```

预期：新增测试因 `isRefreshing` 未定义或刷新仍把状态切换为 `loading` 而失败；已有刷新竞态测试必须继续通过。

- [ ] **Step 4: 扩展 `PhotoLibraryState` 的刷新契约**

在 `src/admin/types.ts` 的 `PhotoLibraryState` 中加入：

```ts
readonly isRefreshing: Readonly<Ref<boolean>>
```

`types.ts` 已使用 Vue 的 `Ref`，沿用现有类型导入方式，不新增状态枚举。

- [ ] **Step 5: 实现可保留内容的刷新**

在 `usePhotoLibrary.ts`：

1. 添加 `const isRefreshing = ref(false)`。
2. 把当前 `load()` 的请求主体抽成 `load(preserveContent = false)`；初次加载仍在请求开始时设置 `status.value = 'loading'`。
3. `refresh()` 在已有快照时设置 `isRefreshing`，清除 `library` 错误消息，调用 `load(true)`，并在 `finally` 中恢复 `isRefreshing=false`。
4. `load(true)` 不修改 `status`，成功后保持 `ready`；失败时保留现有照片和 `ready`，只写入 `library` 净化错误消息。
5. 刷新尚未结束时再次调用 `refresh()`，返回当前 refresh Promise 或直接返回，不新建第二个 `listPhotos()` 请求。
6. 将 `isRefreshing` 放入返回对象。

刷新请求仍递增和校验现有 `loadGeneration`，不得移除已有旧响应保护。初始 `load()` 的错误分支仍设置 `status='error'`，保持错误页和首次加载行为不变。

- [ ] **Step 6: 运行 GREEN 测试**

运行：

```bash
source ~/.nvm/nvm.sh && nvm use 24.20.0 >/dev/null
pnpm exec vitest run src/admin/usePhotoLibrary.test.ts
```

预期：该文件所有测试通过，且刷新失败时仍保持 `ready` 和照片快照。

- [ ] **Step 7: 提交状态契约**

```bash
git add src/admin/types.ts src/admin/usePhotoLibrary.ts src/admin/usePhotoLibrary.test.ts
git commit -m "feat: preserve album content during refresh"
```

### Task 2: 为 A3 胶囊建立组件行为

**Files:**
- Modify: `src/admin/PhotoLibrary.vue:1-125,194-270`
- Test: `src/admin/PhotoLibrary.test.ts`

- [ ] **Step 1: 写 IntersectionObserver 和操作复用的失败测试**

在 `PhotoLibrary.test.ts` 中新增可控的观察器夹具：

```ts
function installIntersectionObserver(): {
  readonly observe: ReturnType<typeof vi.fn>
  readonly disconnect: ReturnType<typeof vi.fn>
  readonly setIntersecting: (isIntersecting: boolean) => void
} {
  let callback: IntersectionObserverCallback | undefined
  const observe = vi.fn()
  const disconnect = vi.fn()
  vi.stubGlobal('IntersectionObserver', vi.fn((nextCallback: IntersectionObserverCallback) => {
    callback = nextCallback
    return { observe, disconnect, unobserve: vi.fn() }
  }))
  return {
    observe,
    disconnect,
    setIntersecting: (isIntersecting) => callback?.([
      { isIntersecting } as IntersectionObserverEntry,
    ], {} as IntersectionObserver),
  }
}
```

加入测试：

```ts
it('shows the mobile floating actions only after the original actions leave the viewport', async () => {
  useViewport(true)
  const observer = installIntersectionObserver()
  const state = library()
  const wrapper = mount(PhotoLibrary, { props: { library: state } })

  expect(wrapper.find('[data-mobile-floating-actions]').exists()).toBe(false)
  observer.setIntersecting(false)
  await nextTick()

  const floating = wrapper.get('[data-mobile-floating-actions]')
  expect(floating.attributes('aria-hidden')).toBeUndefined()
  expect(floating.get('[data-floating-upload]').text()).toContain('上传')
  expect(floating.get('[data-floating-refresh]').attributes('aria-label')).toBe('刷新照片')

  observer.setIntersecting(true)
  await nextTick()
  expect(wrapper.find('[data-mobile-floating-actions]').exists()).toBe(false)
  expect(observer.observe).toHaveBeenCalled()
  expect(observer.disconnect).not.toHaveBeenCalled()
  wrapper.unmount()
  expect(observer.disconnect).toHaveBeenCalled()
})
```

再加入同一动作复用测试：点击浮动上传应触发文件 input 的 `click`，点击浮动刷新应调用 `library.refresh` 一次；刷新时两个浮动入口均 disabled 或 `aria-busy=true`，且重复刷新不再调用 `library.refresh`。

- [ ] **Step 2: 运行组件 RED**

运行：

```bash
source ~/.nvm/nvm.sh && nvm use 24.20.0 >/dev/null
pnpm exec vitest run src/admin/PhotoLibrary.test.ts
```

预期：测试因没有 `IntersectionObserver` 接线和浮动操作节点而失败；已有上传、删除、编辑、移动模态测试继续通过。

- [ ] **Step 3: 添加操作区哨兵和复用处理函数**

在 `PhotoLibrary.vue`：

1. 为原 `.admin-library-actions` 增加 `ref="actionBar"`。
2. 添加 `actionsFloating = ref(false)` 和 `refreshing = computed(() => props.library.isRefreshing.value)`。
3. 在 `onMounted` 创建 `IntersectionObserver`，观察 `actionBar.value`；回调只根据 `entry.isIntersecting` 设置 `actionsFloating`。在 `onBeforeUnmount` 调用 `disconnect()`。
4. 把原刷新 `@click="library.refresh"` 改为 `@click="refreshPhotos"`；`refreshPhotos` 检查 `isRefreshing` 后调用 `props.library.refresh()`。
5. 把上传逻辑保留为 `openPhotoPicker`，浮动按钮调用同一个函数。

- [ ] **Step 4: 添加浮动胶囊模板和无障碍状态**

在原操作区之后加入条件节点：

```vue
<div
  v-if="isMobile && actionsFloating"
  class="admin-mobile-floating-actions"
  data-mobile-floating-actions
  :aria-hidden="isMobileEditorOpen || isDeleteDialogOpen ? 'true' : undefined"
  :inert="isMobileEditorOpen || isDeleteDialogOpen"
>
  <button
    class="admin-primary-button"
    type="button"
    data-floating-upload
    :disabled="library.uploadsDisabled.value || refreshing"
    @click="openPhotoPicker"
  >
    <Upload :size="18" aria-hidden="true" />
    上传
  </button>
  <button
    class="admin-icon-button"
    type="button"
    data-floating-refresh
    aria-label="刷新照片"
    title="刷新照片"
    :aria-busy="refreshing ? 'true' : undefined"
    :disabled="refreshing"
    @click="refreshPhotos"
  >
    <RefreshCw :size="18" aria-hidden="true" />
  </button>
</div>
```

若删除/编辑模态打开，浮动胶囊必须保持 `inert` 和 `aria-hidden`，不与现有模态焦点管理冲突。隐藏状态使用 `v-if`，确保不进入 tab 顺序。

- [ ] **Step 5: 在刷新期间保留照片网格**

将 `PhotoLibrary.vue` 的完整萌趣加载骨架条件改为只在 `library.status.value === 'loading'` 且没有已有照片时显示；有已有照片且 `library.isRefreshing.value` 为真时继续渲染 `.admin-library-layout`。在操作区下方增加：

```vue
<p
  v-if="library.messageFor('library') !== '' && library.status.value === 'ready'"
  class="admin-library-refresh-message"
  role="alert"
>
  {{ library.messageFor('library') }}
</p>
```

初次加载和无照片场景继续使用现有加载/空态分支，不改变公开文案。

- [ ] **Step 6: 运行组件 GREEN 测试**

运行：

```bash
source ~/.nvm/nvm.sh && nvm use 24.20.0 >/dev/null
pnpm exec vitest run src/admin/PhotoLibrary.test.ts src/admin/usePhotoLibrary.test.ts
```

预期：浮动显示/隐藏、共享点击处理、刷新期间网格保留和旧竞态测试全部通过。

- [ ] **Step 7: 提交组件行为**

```bash
git add src/admin/PhotoLibrary.vue src/admin/PhotoLibrary.test.ts
git commit -m "feat: add mobile floating album actions"
```

### Task 3: 完成移动端 A3 视觉和 CSS 合同

**Files:**
- Modify: `src/styles/admin.css:928-1040`
- Test: `src/admin/AdminApp.test.ts`

- [ ] **Step 1: 写 CSS 合同的失败测试**

在 `keeps the approved desktop and mobile layout constraints` 测试中加入：

```ts
expect(adminCss).toMatch(
  /@media\s*\(max-width:\s*720px\)[\s\S]*\.admin-mobile-floating-actions\s*\{[^}]*position:\s*fixed[^}]*top:\s*calc\(12px \+ env\(safe-area-inset-top, 0px\)\)[^}]*right:\s*12px[^}]*z-index:\s*45/,
)
expect(adminCss).toMatch(
  /@media\s*\(max-width:\s*720px\)[\s\S]*\.admin-mobile-floating-actions\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 44px/,
)
expect(adminCss).toMatch(/\.admin-mobile-floating-actions[^}]*background:\s*rgb\(255 253 253 \/ 98%\)/s)
expect(adminCss).not.toMatch(
  /@media\s*\(min-width:\s*721px\)[\s\S]*\.admin-mobile-floating-actions\s*\{[^}]*position:\s*fixed/,
)
```

添加刷新错误样式合同：错误消息可换行、使用现有错误色、不会固定定位。

- [ ] **Step 2: 运行 CSS RED**

运行：

```bash
source ~/.nvm/nvm.sh && nvm use 24.20.0 >/dev/null
pnpm exec vitest run src/admin/AdminApp.test.ts
```

预期：新增合同因浮动胶囊样式不存在而失败。

- [ ] **Step 3: 实现移动端样式**

在移动媒体查询中加入：

```css
.admin-mobile-floating-actions {
  position: fixed;
  z-index: 45;
  top: calc(12px + env(safe-area-inset-top, 0px));
  right: 12px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 44px;
  width: min(196px, calc(100vw - 24px));
  padding: 5px;
  border: 1px solid #d5dad5;
  border-radius: 999px;
  background: rgb(255 253 253 / 98%);
  box-shadow: 0 8px 24px rgb(45 41 44 / 18%);
  gap: 5px;
}

.admin-mobile-floating-actions .admin-primary-button,
.admin-mobile-floating-actions .admin-icon-button {
  min-width: 0;
  height: 40px;
  min-height: 40px;
  border-radius: 999px;
}

.admin-library-refresh-message {
  margin: -8px 0 16px;
  color: #a32943;
  font-size: 0.9rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
```

隐藏胶囊使用 `v-if`，无需额外 `display:none` 规则；桌面端不生成该节点，因此不改变桌面布局。

- [ ] **Step 4: 运行 GREEN CSS 和移动端组件测试**

运行：

```bash
source ~/.nvm/nvm.sh && nvm use 24.20.0 >/dev/null
pnpm exec vitest run src/admin/AdminApp.test.ts src/admin/PhotoLibrary.test.ts src/admin/usePhotoLibrary.test.ts
```

预期：所有管理端布局、相册组件和刷新状态测试通过。

- [ ] **Step 5: 提交样式合同**

```bash
git add src/styles/admin.css src/admin/AdminApp.test.ts
git commit -m "feat: style mobile floating album actions"
```

### Task 4: 全量验证和交付检查

**Files:**
- Verify: `src/admin/PhotoLibrary.vue`, `src/admin/usePhotoLibrary.ts`, `src/admin/types.ts`, `src/styles/admin.css`
- Verify tests: `src/admin/*.test.ts`

- [ ] **Step 1: 运行前端和 API 类型检查**

```bash
source ~/.nvm/nvm.sh && nvm use 24.20.0 >/dev/null
pnpm typecheck
```

预期：退出码 0。

- [ ] **Step 2: 运行全仓 lint**

```bash
pnpm lint
```

预期：退出码 0，`--max-warnings=0` 无警告。

- [ ] **Step 3: 运行完整测试**

```bash
pnpm test
```

若受限环境禁止监控测试绑定 `127.0.0.1`，用允许本机监听的执行环境重跑同一命令；不得把绑定失败误判为产品回归。

- [ ] **Step 4: 构建前端并移出忽略产物**

```bash
pnpm build:frontend
```

确认构建退出码为 0；把本轮生成的 `dist/` 可恢复移动到唯一的 `/tmp` 目录，确认仓库中不存在 `dist/`。

- [ ] **Step 5: 做差异和状态检查**

```bash
git diff --check
git status --short --branch
```

确认只包含本计划文件和已提交的设计/计划文档，不包含 `dist/`、临时截图或 `.superpowers` 以外生成物。

- [ ] **Step 6: 提交验证结果**

```bash
git log -5 --oneline --decorate
```

报告管理端测试、全量测试、typecheck、lint、build 的实际结果；未在真实 iPhone 14 Chrome 上验证时，明确说明仅完成 CSS/DOM 合同验证，不声称截图验证。
