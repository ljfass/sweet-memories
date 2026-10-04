# Admin Upload And Refresh Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add immediately visible C1-style success notifications for completed upload batches and accepted user-triggered refreshes while preserving the full upload queue.

**Architecture:** Keep correctness events inside the existing upload and photo-library state machines, then aggregate them in `AdminApp`. A small notification composable owns deduplication, the two-message limit, pause/resume timing, and cleanup; a presentation-only Vue component renders the fixed desktop/mobile notification layer with the existing admin design tokens.

**Tech Stack:** Vue 3 Composition API, TypeScript, Vitest, Vue Test Utils, Lucide Vue, existing `src/styles/admin.css` design system.

---

## File Map

- Create `src/admin/useAdminSuccessNotifications.ts`: bounded notification state, timers, pause/resume, deduplication, and scope cleanup.
- Create `src/admin/useAdminSuccessNotifications.test.ts`: fake-timer coverage for timing, deduplication, two-message replacement, and cleanup.
- Create `src/admin/AdminSuccessNotifications.vue`: accessible `role="status"` notification renderer with close, hover, and focus behavior.
- Create `src/admin/AdminSuccessNotifications.test.ts`: DOM semantics, emitted interactions, suspended-modal behavior, and stable rendering tests.
- Modify `src/admin/types.ts`: add upload-batch completion DTO and make `refresh()` report whether the response was accepted.
- Modify `src/admin/useUploadQueue.ts`: track one completion boundary per file selection without removing successful queue records.
- Modify `src/admin/useUploadQueue.test.ts`: verify batch aggregation, retries, cancellation, and retained records.
- Modify `src/admin/usePhotoLibrary.ts`: return `true` only for an accepted refresh and `false` for failures or stale responses.
- Modify `src/admin/usePhotoLibrary.test.ts`: verify refresh result semantics alongside existing concurrency protections.
- Modify `src/admin/PhotoLibrary.vue`: await the shared refresh action and emit the latest accepted photo count.
- Modify `src/admin/PhotoLibrary.test.ts`: verify initial loads/internal updates do not emit and both refresh controls emit only after success.
- Modify `src/admin/AdminApp.vue`: aggregate upload and refresh events and mount the fixed notification layer outside inert workspace content.
- Modify `src/admin/AdminApp.test.ts`: cover end-to-end notification copy, simultaneous notices, retained queue records, and CSS contracts.
- Modify `src/styles/admin.css`: implement C1 desktop/mobile positioning, safe area, wrapping, motion, and suspended interaction styles.

### Task 1: Expose Reliable Upload-Batch Completion

**Files:**
- Modify: `src/admin/types.ts:78-122`
- Modify: `src/admin/useUploadQueue.ts:17-25,41-243`
- Test: `src/admin/useUploadQueue.test.ts`

- [ ] **Step 1: Write failing upload-batch tests**

Add an `onBatchCompleted` spy to the `createQueue` helper and tests covering two separate selections, a failed-then-retried selection, and removal cancellation:

```ts
it('reports each fully successful selection once and preserves its queue records', async () => {
  const controlled = controlledApi()
  const completed = vi.fn()
  const queue = createQueue(controlled.api, { onBatchCompleted: completed })

  queue.add([file('one.jpg'), file('two.jpg')])
  await flushPromises()
  controlled.calls[0]!.result.resolve(photo('one'))
  controlled.calls[1]!.result.resolve(photo('two'))
  await flushPromises()

  expect(completed).toHaveBeenCalledOnce()
  expect(completed).toHaveBeenCalledWith({ batchId: 1, count: 2 })
  expect(queue.items.value.map((item) => item.status)).toEqual(['succeeded', 'succeeded'])

  queue.add([file('three.jpg')])
  await flushPromises()
  controlled.calls[2]!.result.resolve(photo('three'))
  await flushPromises()
  expect(completed).toHaveBeenLastCalledWith({ batchId: 2, count: 1 })
})

it('waits for a failed item to succeed on retry before completing its batch', async () => {
  const controlled = controlledApi()
  const completed = vi.fn()
  const queue = createQueue(controlled.api, { onBatchCompleted: completed })
  queue.add([file('retry.jpg')])
  await flushPromises()
  controlled.calls[0]!.result.reject(new AdminApiError('unavailable', 'private'))
  await flushPromises()
  expect(completed).not.toHaveBeenCalled()

  queue.retry(queue.items.value[0]!.id)
  await flushPromises()
  controlled.calls[1]!.result.resolve(photo('retry'))
  await flushPromises()
  expect(completed).toHaveBeenCalledWith({ batchId: 1, count: 1 })
})

it('does not report a removed incomplete selection as successful', async () => {
  const controlled = controlledApi()
  const completed = vi.fn()
  const queue = createQueue(controlled.api, { onBatchCompleted: completed })
  queue.add([file('removed.jpg')])
  await flushPromises()
  queue.remove(queue.items.value[0]!.id)
  controlled.calls[0]!.result.resolve(photo('removed'))
  await flushPromises()
  expect(completed).not.toHaveBeenCalled()
})
```

Extend the helper override type and pass the callback:

```ts
readonly onBatchCompleted?: (completion: UploadBatchCompletion) => void
// ...
onBatchCompleted: overrides.onBatchCompleted,
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
pnpm exec vitest run src/admin/useUploadQueue.test.ts
```

Expected: FAIL because `UploadBatchCompletion` and `onBatchCompleted` do not exist and no batch event is emitted.

- [ ] **Step 3: Add the typed completion contract**

In `src/admin/types.ts` add:

```ts
export interface UploadBatchCompletion {
  readonly batchId: number
  readonly count: number
}
```

In `UploadQueueOptions` add:

```ts
readonly onBatchCompleted?: (completion: UploadBatchCompletion) => void
```

Import the new type in `useUploadQueue.ts`.

- [ ] **Step 4: Implement minimal batch tracking**

Keep queue items unchanged and track selection membership privately:

```ts
interface UploadBatch {
  readonly id: number
  readonly itemIds: ReadonlySet<string>
  readonly count: number
}

let nextBatchId = 0
const batchByItemId = new Map<string, number>()
const batches = new Map<number, UploadBatch>()

function forgetBatch(batchId: number): void {
  const batch = batches.get(batchId)
  if (batch === undefined) return
  for (const itemId of batch.itemIds) batchByItemId.delete(itemId)
  batches.delete(batchId)
}

function maybeCompleteBatch(itemId: string): void {
  const batchId = batchByItemId.get(itemId)
  if (batchId === undefined) return
  const batch = batches.get(batchId)
  if (batch === undefined) return
  const selectedItems = items.value.filter((item) => batch.itemIds.has(item.id))
  if (
    selectedItems.length !== batch.count
    || selectedItems.some((item) => item.status !== 'succeeded')
  ) return
  options.onBatchCompleted?.({ batchId, count: batch.count })
  forgetBatch(batchId)
}
```

In `add`, create one batch only for a non-empty selection, record all generated item IDs, then schedule:

```ts
function add(files: readonly File[]): void {
  if (files.length === 0) return
  const batchId = ++nextBatchId
  const nextItems = files.map(createUploadItem)
  const itemIds = new Set(nextItems.map((item) => item.id))
  batches.set(batchId, { id: batchId, itemIds, count: nextItems.length })
  for (const itemId of itemIds) batchByItemId.set(itemId, batchId)
  items.value = [...items.value, ...nextItems]
  if (nextItems.some((item) => item.errorCode === 'file-too-large')) {
    forgetBatch(batchId)
  }
  schedule()
}
```

Preserve the existing `createUploadItem` and queue-limit behavior when applying this structure. After a successful `replaceItem`, call `maybeCompleteBatch(item.id)`. In `remove`, resolve the item's batch ID and call `forgetBatch` before removing the item. Retrying keeps the original membership and request ID.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
pnpm exec vitest run src/admin/useUploadQueue.test.ts src/admin/UploadQueue.test.ts
```

Expected: both files pass; existing maximum-two concurrency, progress, retry, authentication pause, cleanup, and queue rendering tests remain green.

- [ ] **Step 6: Commit the batch event**

```bash
git add src/admin/types.ts src/admin/useUploadQueue.ts src/admin/useUploadQueue.test.ts
git commit -m "feat: report completed upload batches"
```

### Task 2: Make User Refresh Success Observable

**Files:**
- Modify: `src/admin/types.ts:124-145`
- Modify: `src/admin/usePhotoLibrary.ts:74-172`
- Modify: `src/admin/PhotoLibrary.vue:15-18,116-119,257-270`
- Test: `src/admin/usePhotoLibrary.test.ts`
- Test: `src/admin/PhotoLibrary.test.ts`

- [ ] **Step 1: Write failing refresh-result tests**

In `usePhotoLibrary.test.ts`, assert accepted refreshes resolve `true`, failures resolve `false`, and stale loads cannot report success:

```ts
await expect(library.refresh()).resolves.toBe(true)

vi.mocked(api.listPhotos).mockRejectedValueOnce(new AdminApiError('unavailable', 'private'))
await expect(library.refresh()).resolves.toBe(false)

const oldLoad = library.load()
const acceptedRefresh = library.refresh()
newer.resolve([photo({ version: 3 })])
await expect(acceptedRefresh).resolves.toBe(true)
older.resolve([photo({ version: 1 })])
await oldLoad
```

In `PhotoLibrary.test.ts`, make the test helper return `true` from `refresh`, and add:

```ts
it('emits the accepted photo count only for a successful user refresh', async () => {
  const state = library({
    photos: ref([photo, secondPhoto]),
    refresh: vi.fn(async () => true),
  })
  const wrapper = mount(PhotoLibrary, { props: { library: state } })
  await wrapper.get('[data-refresh]').trigger('click')
  await flushPromises()
  expect(wrapper.emitted('refresh-success')).toEqual([[2]])
})

it('does not emit refresh success for a failed refresh', async () => {
  const state = library({ refresh: vi.fn(async () => false) })
  const wrapper = mount(PhotoLibrary, { props: { library: state } })
  await wrapper.get('[data-refresh]').trigger('click')
  await flushPromises()
  expect(wrapper.emitted('refresh-success')).toBeUndefined()
})
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
pnpm exec vitest run src/admin/usePhotoLibrary.test.ts src/admin/PhotoLibrary.test.ts
```

Expected: FAIL because `refresh()` currently resolves `void` and `PhotoLibrary` emits no result.

- [ ] **Step 3: Separate internal loading from public refresh results**

In `types.ts` change only the refresh signature:

```ts
refresh(): Promise<boolean>
```

In `usePhotoLibrary.ts`, retain `load(): Promise<void>` for initial loading and introduce an accepted-result helper:

```ts
let refreshPromise: Promise<boolean> | null = null

async function loadPhotos(preserveContent: boolean): Promise<boolean> {
  const generation = ++loadGeneration
  const uploadsAtRequestStart = uploadRevision
  messages.delete('library')
  if (!preserveContent) status.value = 'loading'
  try {
    const nextPhotos = await api.listPhotos()
    if (generation !== loadGeneration) return false
    synchronize(nextPhotos, undefined, uploadsAtRequestStart)
    status.value = 'ready'
    return true
  } catch (error) {
    if (generation !== loadGeneration) return false
    if (!preserveContent) status.value = 'error'
    setError('library', safeActionMessage(error, 'load'))
    return false
  }
}

async function load(): Promise<void> {
  await loadPhotos(false)
}

function refresh(): Promise<boolean> {
  if (refreshPromise !== null) return refreshPromise
  if (status.value !== 'ready') return loadPhotos(false)
  isRefreshing.value = true
  refreshPromise = loadPhotos(true).finally(() => {
    isRefreshing.value = false
    refreshPromise = null
  })
  return refreshPromise
}
```

- [ ] **Step 4: Emit only accepted user actions**

Extend `PhotoLibrary` emits:

```ts
'refresh-success': [count: number]
```

Replace the shared handler with:

```ts
async function refreshPhotos(): Promise<void> {
  if (props.library.isRefreshing.value) return
  const accepted = await props.library.refresh()
  if (accepted) emit('refresh-success', props.library.photos.value.length)
}
```

Both the original and floating refresh buttons continue to call this same function. Initial `library.load()` and upload synchronization never pass through it.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
pnpm exec vitest run src/admin/usePhotoLibrary.test.ts src/admin/PhotoLibrary.test.ts
```

Expected: both files pass, including stale-response, dirty-draft, upload-refresh, deletion-refresh, and scroll-preservation regressions.

- [ ] **Step 6: Commit refresh observability**

```bash
git add src/admin/types.ts src/admin/usePhotoLibrary.ts src/admin/usePhotoLibrary.test.ts src/admin/PhotoLibrary.vue src/admin/PhotoLibrary.test.ts
git commit -m "feat: report accepted photo refreshes"
```

### Task 3: Build The Bounded Success Notification Layer

**Files:**
- Create: `src/admin/useAdminSuccessNotifications.ts`
- Create: `src/admin/useAdminSuccessNotifications.test.ts`
- Create: `src/admin/AdminSuccessNotifications.vue`
- Create: `src/admin/AdminSuccessNotifications.test.ts`
- Modify: `src/styles/admin.css:1-21,856-875,936-1083`

- [ ] **Step 1: Write failing composable tests**

Use fake timers to specify the lifecycle:

```ts
it('deduplicates active keys and keeps at most the two newest notices', () => {
  const notices = useAdminSuccessNotifications()
  notices.show('upload-1', '2 张照片上传完成')
  notices.show('upload-1', '2 张照片上传完成')
  notices.show('refresh-1', '刷新成功 · 共 20 张')
  notices.show('refresh-2', '刷新成功 · 共 21 张')
  expect(notices.items.value.map((item) => item.key)).toEqual(['refresh-1', 'refresh-2'])
})

it('dismisses after 3.5 seconds and preserves remaining time across pause and resume', () => {
  vi.useFakeTimers()
  const notices = useAdminSuccessNotifications()
  notices.show('upload-1', '上传完成')
  vi.advanceTimersByTime(2000)
  notices.pause(notices.items.value[0]!.id)
  vi.advanceTimersByTime(5000)
  expect(notices.items.value).toHaveLength(1)
  notices.resume(notices.items.value[0]!.id)
  vi.advanceTimersByTime(1499)
  expect(notices.items.value).toHaveLength(1)
  vi.advanceTimersByTime(1)
  expect(notices.items.value).toHaveLength(0)
})
```

Add an `effectScope` test proving `scope.stop()` clears timers and prevents late mutation.

- [ ] **Step 2: Run the composable test and verify RED**

Run:

```bash
pnpm exec vitest run src/admin/useAdminSuccessNotifications.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the notification state**

Create the typed state with injected defaults kept internal:

```ts
import { getCurrentScope, onScopeDispose, readonly, ref } from 'vue'

const DEFAULT_DURATION_MS = 3500
const MAX_VISIBLE_NOTICES = 2

export interface AdminSuccessNotification {
  readonly id: number
  readonly key: string
  readonly message: string
}

export function useAdminSuccessNotifications() {
  const items = ref<AdminSuccessNotification[]>([])
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  const deadlines = new Map<number, number>()
  const remaining = new Map<number, number>()
  let nextId = 0

  function clearTimer(id: number): void {
    const timer = timers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(id)
    deadlines.delete(id)
  }

  function dismiss(id: number): void {
    clearTimer(id)
    remaining.delete(id)
    items.value = items.value.filter((item) => item.id !== id)
  }

  function arm(id: number, duration: number): void {
    remaining.set(id, duration)
    deadlines.set(id, Date.now() + duration)
    timers.set(id, setTimeout(() => dismiss(id), duration))
  }

  function show(key: string, message: string): void {
    if (items.value.some((item) => item.key === key)) return
    if (items.value.length >= MAX_VISIBLE_NOTICES) dismiss(items.value[0]!.id)
    const item = { id: ++nextId, key, message }
    items.value = [...items.value, item]
    arm(item.id, DEFAULT_DURATION_MS)
  }

  function pause(id: number): void {
    const deadline = deadlines.get(id)
    if (deadline === undefined) return
    const duration = Math.max(0, deadline - Date.now())
    clearTimer(id)
    remaining.set(id, duration)
  }

  function resume(id: number): void {
    if (!items.value.some((item) => item.id === id) || timers.has(id)) return
    arm(id, remaining.get(id) ?? DEFAULT_DURATION_MS)
  }

  if (getCurrentScope()) onScopeDispose(() => {
    for (const id of timers.keys()) clearTimer(id)
  })

  return { items: readonly(items), show, dismiss, pause, resume }
}
```

- [ ] **Step 4: Write failing component tests**

Specify semantic rendering and interaction emits:

```ts
it('renders polite success statuses without stealing focus', async () => {
  const wrapper = mount(AdminSuccessNotifications, {
    attachTo: document.body,
    props: { items: [{ id: 1, key: 'upload-1', message: '2 张照片上传完成' }], suspended: false },
  })
  expect(wrapper.get('[role="status"]').attributes('aria-live')).toBe('polite')
  expect(wrapper.text()).toContain('2 张照片上传完成')
  expect(document.activeElement).toBe(document.body)
  await wrapper.get('[data-success-notification]').trigger('mouseenter')
  await wrapper.get('[data-dismiss-success]').trigger('click')
  expect(wrapper.emitted('pause')).toEqual([[1]])
  expect(wrapper.emitted('dismiss')).toEqual([[1]])
  wrapper.unmount()
})

it('removes background interaction while reauthentication is open', () => {
  const wrapper = mount(AdminSuccessNotifications, {
    props: { items: [{ id: 1, key: 'upload-1', message: '上传完成' }], suspended: true },
  })
  expect(wrapper.get('[data-success-notification]').attributes('tabindex')).toBe('-1')
  expect(wrapper.get('[data-dismiss-success]').attributes('disabled')).toBeDefined()
})
```

- [ ] **Step 5: Create the presentation component**

Create `AdminSuccessNotifications.vue` using `CheckCircle2` and `X` from `@lucide/vue`. Use this complete script contract so focus movement inside one notice does not restart its timer:

```vue
<script setup lang="ts">
import { CheckCircle2, X } from '@lucide/vue'
import type { AdminSuccessNotification } from './useAdminSuccessNotifications'

const props = defineProps<{
  readonly items: readonly AdminSuccessNotification[]
  readonly suspended: boolean
}>()

const emit = defineEmits<{
  pause: [id: number]
  resume: [id: number]
  dismiss: [id: number]
}>()

function resumeAfterFocusLeaves(id: number, event: FocusEvent): void {
  if (props.suspended) return
  const currentTarget = event.currentTarget
  if (!(currentTarget instanceof HTMLElement)) return
  const nextTarget = event.relatedTarget
  if (nextTarget instanceof Node && currentTarget.contains(nextTarget)) return
  emit('resume', id)
}

function pauseIfActive(id: number): void {
  if (!props.suspended) emit('pause', id)
}

function resumeIfActive(id: number): void {
  if (!props.suspended) emit('resume', id)
}
</script>
```

Render a fixed host with `role="status"`, `aria-live="polite"`, and `aria-atomic="false"`; render each item in a `TransitionGroup`; use icon-only close buttons with `title` and `aria-label="关闭提示"`. Emit `pause`, `resume`, and `dismiss` by ID.

The central template shape is:

```vue
<div
  class="admin-success-notifications"
  role="status"
  aria-live="polite"
  aria-atomic="false"
  data-success-notifications
  :data-suspended="suspended ? 'true' : undefined"
>
  <TransitionGroup name="admin-success-notification">
    <article
      v-for="item in items"
      :key="item.id"
      class="admin-success-notification"
      data-success-notification
      :tabindex="suspended ? -1 : 0"
      @mouseenter="pauseIfActive(item.id)"
      @mouseleave="resumeIfActive(item.id)"
      @focusin="pauseIfActive(item.id)"
      @focusout="resumeAfterFocusLeaves(item.id, $event)"
    >
      <CheckCircle2 :size="20" aria-hidden="true" />
      <span>{{ item.message }}</span>
      <button
        type="button"
        class="admin-icon-button"
        data-dismiss-success
        title="关闭提示"
        aria-label="关闭提示"
        :disabled="suspended"
        @click="$emit('dismiss', item.id)"
      ><X :size="17" aria-hidden="true" /></button>
    </article>
  </TransitionGroup>
</div>
```

- [ ] **Step 6: Add C1 CSS and contract assertions**

Add desktop rules using `position: fixed`, `z-index: 60`, `top/right: 24px`, stable width, green border/icon, wrapping text, and a short translate/opacity transition. Under `max-width: 720px`, center the host below top controls:

```css
.admin-success-notifications {
  position: fixed;
  z-index: 60;
  top: 24px;
  right: 24px;
  display: grid;
  width: min(360px, calc(100vw - 32px));
  gap: 8px;
  pointer-events: none;
}

.admin-success-notification {
  display: grid;
  align-items: center;
  grid-template-columns: 20px minmax(0, 1fr) 32px;
  padding: 10px 8px 10px 12px;
  border: 1px solid #b8d8c8;
  border-radius: 7px;
  color: var(--admin-success);
  background: var(--admin-paper);
  box-shadow: 0 10px 26px rgb(31 74 54 / 17%);
  gap: 8px;
  overflow-wrap: anywhere;
  pointer-events: auto;
}

@media (max-width: 720px) {
  .admin-success-notifications {
    top: calc(64px + env(safe-area-inset-top, 0px));
    right: 12px;
    left: 12px;
    width: auto;
  }
}
```

Extend the reduced-motion block so enter/leave classes have no transition or transform. Add CSS source assertions to `AdminSuccessNotifications.test.ts` for desktop fixed positioning, mobile safe-area placement, wrapping, and reduced motion.

- [ ] **Step 7: Run notification tests and verify GREEN**

Run:

```bash
pnpm exec vitest run src/admin/useAdminSuccessNotifications.test.ts src/admin/AdminSuccessNotifications.test.ts
```

Expected: both new files pass with no timer leaks or Vue warnings.

- [ ] **Step 8: Commit the notification layer**

```bash
git add src/admin/useAdminSuccessNotifications.ts src/admin/useAdminSuccessNotifications.test.ts src/admin/AdminSuccessNotifications.vue src/admin/AdminSuccessNotifications.test.ts src/styles/admin.css
git commit -m "feat: add bounded admin success notifications"
```

### Task 4: Wire Upload And Refresh Feedback End To End

**Files:**
- Modify: `src/admin/AdminApp.vue:1-38,154-190`
- Modify: `src/admin/AdminApp.test.ts`
- Modify: `src/admin/PhotoLibrary.test.ts`: update its `PhotoLibraryState.refresh` helper to resolve an explicit boolean.

- [ ] **Step 1: Write failing integration tests**

Add tests to `AdminApp.test.ts` proving real state-machine events reach the notification layer:

```ts
it('shows one batch upload notice while retaining successful queue rows', async () => {
  vi.spyOn(URL, 'createObjectURL').mockImplementation((file) => `blob:${(file as File).name}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  const uploads: AdminUploadApiClient = {
    uploadPhoto: vi.fn()
      .mockResolvedValueOnce(photo({ id: 'upload-1', status: 'published' }))
      .mockResolvedValueOnce(photo({ id: 'upload-2', status: 'published' })),
  }
  const wrapper = mount(AdminApp, {
    attachTo: document.body,
    props: { session: session(), photoApi: photoApi([]), uploadApi: uploads },
  })
  await flushPromises()
  const input = wrapper.get('input[type="file"]')
  Object.defineProperty(input.element, 'files', {
    configurable: true,
    value: [new File(['one'], 'one.jpg'), new File(['two'], 'two.jpg')],
  })
  await input.trigger('change')
  await flushPromises()

  expect(wrapper.get('[data-success-notifications]').text()).toContain('2 张照片上传完成')
  expect(wrapper.findAll('[data-upload-item]')).toHaveLength(2)
  expect(wrapper.text()).toContain('上传队列已完成')
  wrapper.unmount()
})

it('shows refresh success only after the explicit accepted refresh', async () => {
  const first = photo({ id: 'photo-1', status: 'published' })
  const second = photo({ id: 'photo-2', status: 'published' })
  const photos = photoApi([first])
  vi.mocked(photos.listPhotos)
    .mockResolvedValueOnce([first])
    .mockResolvedValueOnce([first, second])
  const wrapper = mount(AdminApp, {
    props: { session: session(), photoApi: photos, uploadApi: idleUploadApi() },
  })
  await flushPromises()
  expect(wrapper.find('[data-success-notification]').exists()).toBe(false)
  await wrapper.get('[data-refresh]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[data-success-notifications]').text()).toContain('刷新成功 · 共 2 张')
  wrapper.unmount()
})

it('keeps upload and refresh success visible when they complete together', async () => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:upload')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  const uploaded = photo({ id: 'upload-1', status: 'published' })
  const photos = photoApi([])
  vi.mocked(photos.listPhotos)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([uploaded])
  const uploads: AdminUploadApiClient = {
    uploadPhoto: vi.fn(async () => uploaded),
  }
  const wrapper = mount(AdminApp, {
    props: { session: session(), photoApi: photos, uploadApi: uploads },
  })
  await flushPromises()
  const input = wrapper.get('input[type="file"]')
  Object.defineProperty(input.element, 'files', {
    configurable: true,
    value: [new File(['one'], 'one.jpg')],
  })
  await input.trigger('change')
  await flushPromises()
  await wrapper.get('[data-refresh]').trigger('click')
  await flushPromises()

  expect(wrapper.findAll('[data-success-notification]')).toHaveLength(2)
  expect(wrapper.get('[data-success-notifications]').text()).toContain('1 张照片上传完成')
  expect(wrapper.get('[data-success-notifications]').text()).toContain('刷新成功 · 共 1 张')
  wrapper.unmount()
})

it('does not show refresh success when the explicit refresh fails', async () => {
  const photos = photoApi([])
  vi.mocked(photos.listPhotos)
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new AdminApiError('unavailable', 'private'))
  const wrapper = mount(AdminApp, {
    props: { session: session(), photoApi: photos, uploadApi: idleUploadApi() },
  })
  await flushPromises()
  await wrapper.get('[data-refresh]').trigger('click')
  await flushPromises()

  expect(wrapper.find('[data-success-notification]').exists()).toBe(false)
  expect(wrapper.text()).toContain('暂时无法加载照片，请稍后重试')
  wrapper.unmount()
})

it('keeps the polite region present but disables notice controls during reauthentication', async () => {
  const adminSession = session()
  const photos = photoApi([])
  vi.mocked(photos.listPhotos).mockResolvedValue([])
  const wrapper = mount(AdminApp, {
    props: { session: adminSession, photoApi: photos, uploadApi: idleUploadApi() },
  })
  await flushPromises()
  await wrapper.get('[data-refresh]').trigger('click')
  await flushPromises()

  adminSession.status.value = 'reauth-required'
  adminSession.csrfToken.value = null
  await flushPromises()

  const liveRegion = wrapper.get('[data-success-notifications]')
  expect(liveRegion.attributes('aria-live')).toBe('polite')
  expect(liveRegion.attributes('data-suspended')).toBe('true')
  expect(wrapper.get('[data-success-notification]').attributes('tabindex')).toBe('-1')
  expect(wrapper.get('[data-dismiss-success]').attributes('disabled')).toBeDefined()
  wrapper.unmount()
})
```

- [ ] **Step 2: Run integration tests and verify RED**

Run:

```bash
pnpm exec vitest run src/admin/AdminApp.test.ts src/admin/PhotoLibrary.test.ts
```

Expected: FAIL because `AdminApp` does not mount or populate the success-notification layer.

- [ ] **Step 3: Wire the notification state in `AdminApp.vue`**

Import the new component/composable and instantiate once:

```ts
import AdminSuccessNotifications from './AdminSuccessNotifications.vue'
import { useAdminSuccessNotifications } from './useAdminSuccessNotifications'

const successNotifications = useAdminSuccessNotifications()
let refreshNoticeId = 0

function showUploadCompleted(completion: UploadBatchCompletion): void {
  successNotifications.show(
    `upload-${completion.batchId}`,
    `${completion.count} 张照片上传完成`,
  )
}

function showRefreshCompleted(count: number): void {
  successNotifications.show(`refresh-${++refreshNoticeId}`, `刷新成功 · 共 ${count} 张`)
}
```

Pass `onBatchCompleted: showUploadCompleted` into `useUploadQueue`. Listen to the library event:

```vue
<PhotoLibrary
  :library="photoLibrary"
  :upload-queue="uploadQueue"
  :suspended="session.status.value === 'reauth-required'"
  @refresh-success="showRefreshCompleted"
  @modal-change="isPhotoModalOpen = $event"
/>
```

Mount notifications after `.admin-workspace-content` and before `ReauthDialog` so workspace inertness does not suppress the live message:

```vue
<AdminSuccessNotifications
  :items="successNotifications.items.value"
  :suspended="session.status.value === 'reauth-required' || isPhotoModalOpen"
  @pause="successNotifications.pause"
  @resume="successNotifications.resume"
  @dismiss="successNotifications.dismiss"
/>
```

- [ ] **Step 4: Run focused admin tests and verify GREEN**

Run:

```bash
pnpm exec vitest run \
  src/admin/useUploadQueue.test.ts \
  src/admin/usePhotoLibrary.test.ts \
  src/admin/useAdminSuccessNotifications.test.ts \
  src/admin/AdminSuccessNotifications.test.ts \
  src/admin/UploadQueue.test.ts \
  src/admin/PhotoLibrary.test.ts \
  src/admin/AdminApp.test.ts
```

Expected: all focused suites pass with no stderr warnings, open timers, unhandled promises, or network access.

- [ ] **Step 5: Commit the end-to-end wiring**

```bash
git add src/admin/AdminApp.vue src/admin/AdminApp.test.ts src/admin/PhotoLibrary.test.ts
git commit -m "feat: show upload and refresh success feedback"
```

### Task 5: Run The Deployment Gate And Review The Diff

**Files:**
- Verify all files changed in Tasks 1-4.

- [ ] **Step 1: Run frontend static checks**

```bash
pnpm typecheck
pnpm lint
```

Expected: both commands exit 0. Node 22 may print the known API Node 24 engine warning locally; it is not a test failure.

- [ ] **Step 2: Run the complete test gate**

```bash
pnpm test
pnpm test:api
pnpm test:deploy
pnpm test:monitor
```

Expected: all commands exit 0. Run tests that bind `127.0.0.1` with the required local-listen permission rather than weakening their contracts.

- [ ] **Step 3: Run production builds**

```bash
pnpm build:frontend
pnpm build:api
```

Expected: both builds exit 0. Keep generated ignored `dist` directories out of Git status and do not add them to the commit.

- [ ] **Step 4: Review scope and whitespace**

```bash
git status --short
git diff --check
git diff --stat main...HEAD
git log --oneline main..HEAD
```

Expected: only the planned admin source/tests/styles and this plan differ from `main`; no generated artifacts, visual brainstorming files, or unrelated user changes are staged.

- [ ] **Step 5: Perform manual responsive verification**

Run the existing local frontend workflow and verify at desktop and iPhone 14 Chrome dimensions:

1. A completed multi-file upload shows one top success notice and leaves all successful queue rows visible.
2. A user refresh shows the merged photo count without changing scroll position.
3. Upload and refresh completing together show two readable notices.
4. Hover/focus pauses dismissal; close removes only that notice.
5. Reauthentication and the mobile editor do not lose focus or expose background notification controls.
6. Reduced-motion mode removes positional animation.

- [ ] **Step 6: Record any scoped verification corrections**

Review `git status --short`. When a scoped correction was made during verification, stage only the planned files and commit:

```bash
git add src/admin src/styles/admin.css
git commit -m "fix: polish admin success feedback"
```

If no corrections were needed, do not create an empty commit.
