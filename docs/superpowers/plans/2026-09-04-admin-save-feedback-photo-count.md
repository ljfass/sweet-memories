# Admin Save Feedback And Photo Count Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a typed inline success message after an accepted photo save and a live total beside the photo-library heading.

**Architecture:** Keep one authoritative photo collection in `usePhotoLibrary`; derive the visible count from `photos.length` instead of adding counter state. Replace the internal string-only message map with typed entries while preserving the existing `messageFor()` text API, and expose a small tone accessor for `PhotoEditor` presentation.

**Tech Stack:** Vue 3 Composition API, TypeScript, Vitest, Vue Test Utils, existing admin CSS.

---

### Task 1: Add Typed Per-Photo Save Feedback

**Files:**
- Modify: `src/admin/types.ts`
- Modify: `src/admin/usePhotoLibrary.ts`
- Test: `src/admin/usePhotoLibrary.test.ts`

- [ ] **Step 1: Write the failing success-lifecycle test**

Add a test that saves an accepted response, verifies the typed success message, clears it on edit, saves again, and clears it when selecting another photo:

```ts
it('reports an accepted save as success and clears it on edit or photo switch', async () => {
  const second = photo({ id: 'photo-2', title: '第二张照片' })
  const api = fakeApi([photo(), second])
  const library = usePhotoLibrary(api, ref('csrf-token'))
  await library.load()
  library.select('photo-1')
  library.updateDraft('photo-1', { title: '已保存标题' })

  await library.save('photo-1')

  expect(library.messageFor('photo-1')).toBe('保存成功')
  expect(library.messageToneFor('photo-1')).toBe('success')

  library.updateDraft('photo-1', { description: '继续修改' })
  expect(library.messageFor('photo-1')).toBe('')
  expect(library.messageToneFor('photo-1')).toBeNull()

  await library.save('photo-1')
  library.select('photo-2')
  expect(library.messageFor('photo-1')).toBe('')
  expect(library.messageToneFor('photo-1')).toBeNull()
})
```

- [ ] **Step 2: Write the failing false-success regression test**

Cover an API failure and an accepted-version race. Neither path may expose a success tone:

```ts
it('never reports success for failed or stale save responses', async () => {
  const api = fakeApi()
  const library = usePhotoLibrary(api, ref('csrf-token'))
  await library.load()
  library.updateDraft('photo-1', { title: '待保存标题' })
  vi.mocked(api.updatePhoto).mockRejectedValueOnce(new AdminApiError('unavailable', 'private'))

  await library.save('photo-1')

  expect(library.messageToneFor('photo-1')).toBe('error')
  expect(library.messageFor('photo-1')).toBe('暂时无法保存照片，请稍后重试')
})
```

Extend the existing pending-save/newer-refresh test with:

```ts
expect(library.messageToneFor('photo-1')).not.toBe('success')
```

- [ ] **Step 3: Run the focused test to verify RED**

Run:

```bash
pnpm exec vitest run src/admin/usePhotoLibrary.test.ts
```

Expected: FAIL because `messageToneFor` does not exist and accepted saves do not set `保存成功`.

- [ ] **Step 4: Add the typed public contract**

Add to `src/admin/types.ts`:

```ts
export type PhotoMessageTone = 'success' | 'error'

export interface PhotoLibraryState {
  // existing members remain unchanged
  messageFor(id: string): string
  messageToneFor(id: string): PhotoMessageTone | null
}
```

- [ ] **Step 5: Store typed messages and set success only after an accepted save**

In `src/admin/usePhotoLibrary.ts`, use one internal type and helper:

```ts
import type { PhotoMessageTone } from './types'

interface PhotoMessage {
  readonly text: string
  readonly tone: PhotoMessageTone
}

const messages = reactive(new Map<string, PhotoMessage>())

function setError(id: string, text: string): void {
  messages.set(id, { text, tone: 'error' })
}
```

Replace each existing error `messages.set(id, text)` call with `setError(id, text)`. After `replacePhoto(updated)` succeeds and the draft/base version are synchronized, set:

```ts
messages.set(id, { text: '保存成功', tone: 'success' })
```

Clear only a transient success when leaving a selected photo:

```ts
function select(id: string | null): void {
  const previousId = selectedId.value
  selectedId.value = id
  if (previousId !== null && previousId !== id && messages.get(previousId)?.tone === 'success') {
    messages.delete(previousId)
  }
  // retain the existing draft initialization
}
```

Keep `updateDraft()` deleting the current message, and return both accessors:

```ts
messageFor: (id) => messages.get(id)?.text ?? '',
messageToneFor: (id) => messages.get(id)?.tone ?? null,
```

- [ ] **Step 6: Run the focused test to verify GREEN**

Run:

```bash
pnpm exec vitest run src/admin/usePhotoLibrary.test.ts
```

Expected: all `usePhotoLibrary` tests PASS.

- [ ] **Step 7: Commit the state change**

```bash
git add src/admin/types.ts src/admin/usePhotoLibrary.ts src/admin/usePhotoLibrary.test.ts
git commit -m "feat: report successful photo saves"
```

### Task 2: Render Accessible Success And Error States

**Files:**
- Modify: `src/admin/PhotoEditor.vue`
- Modify: `src/admin/PhotoLibrary.vue`
- Modify: `src/styles/admin.css`
- Test: `src/admin/PhotoEditor.test.ts`
- Test: `src/admin/PhotoLibrary.test.ts`

- [ ] **Step 1: Write the failing editor presentation test**

Pass both tones to `PhotoEditor`, then assert the stable live region and semantic classes:

```ts
it('renders typed save feedback in the existing polite live region', async () => {
  const wrapper = mount(PhotoEditor, {
    props: {
      photo,
      draft,
      conflict: false,
      saving: false,
      message: '保存成功',
      messageTone: 'success',
    },
  })

  const message = wrapper.get('.admin-form-message')
  expect(message.attributes('aria-live')).toBe('polite')
  expect(message.classes()).toContain('is-success')
  expect(message.classes()).not.toContain('is-error')

  await wrapper.setProps({ message: '暂时无法保存照片，请稍后重试', messageTone: 'error' })
  expect(message.classes()).toContain('is-error')
  expect(message.classes()).not.toContain('is-success')
})
```

Update the first existing `PhotoEditor` mount, whose message is empty, with `messageTone: null`. Update the existing conflict mount, whose message is `照片已在其他页面修改`, with `messageTone: 'error'`.

- [ ] **Step 2: Write the failing wiring test**

In the `PhotoLibrary` fixture, add `messageToneFor`. Mount a selected photo with `messageFor` returning `保存成功` and `messageToneFor` returning `success`, then assert `.admin-form-message.is-success` exists.

```ts
const state = library({
  selectedId: ref('photo-1'),
  messageFor: vi.fn(() => '保存成功'),
  messageToneFor: vi.fn(() => 'success'),
})
const wrapper = mount(PhotoLibrary, { props: { library: state } })
expect(wrapper.get('.admin-form-message.is-success').text()).toBe('保存成功')
```

- [ ] **Step 3: Run the component tests to verify RED**

Run:

```bash
pnpm exec vitest run src/admin/PhotoEditor.test.ts src/admin/PhotoLibrary.test.ts
```

Expected: FAIL because `PhotoEditor` has no `messageTone` prop/class and `PhotoLibrary` does not pass the tone.

- [ ] **Step 4: Render the typed state**

In `src/admin/PhotoEditor.vue`, add the prop and classes:

```ts
import type { AdminPhoto, PhotoDraft, PhotoMessageTone } from './types'

const props = defineProps<{
  // existing props
  message: string
  messageTone: PhotoMessageTone | null
}>()
```

```vue
<p
  class="admin-form-message"
  :class="{
    'is-success': messageTone === 'success',
    'is-error': messageTone === 'error',
  }"
  aria-live="polite"
>
  {{ message }}
</p>
```

In `src/admin/PhotoLibrary.vue`, pass:

```vue
:message-tone="library.messageToneFor(selectedPhoto.id)"
```

- [ ] **Step 5: Add restrained success and error colors**

Update `src/styles/admin.css` so the stable message container has neutral default color and explicit tones:

```css
.admin-form-message {
  min-height: 24px;
  margin: 10px 0;
  color: #5d646a;
  font-size: 0.9rem;
  line-height: 1.5;
}

.admin-form-message.is-success {
  color: #176b45;
}

.admin-form-message.is-error {
  color: #a32943;
}
```

- [ ] **Step 6: Run the component tests to verify GREEN**

Run:

```bash
pnpm exec vitest run src/admin/PhotoEditor.test.ts src/admin/PhotoLibrary.test.ts
```

Expected: both files PASS.

- [ ] **Step 7: Commit the presentation change**

```bash
git add src/admin/PhotoEditor.vue src/admin/PhotoLibrary.vue src/styles/admin.css src/admin/PhotoEditor.test.ts src/admin/PhotoLibrary.test.ts
git commit -m "feat: show photo save feedback"
```

### Task 3: Show The Live Photo Total Beside The Heading

**Files:**
- Modify: `src/admin/AdminApp.vue`
- Modify: `src/styles/admin.css`
- Test: `src/admin/AdminApp.test.ts`

- [ ] **Step 1: Write the failing count test**

Mount an authenticated app with two photos and verify the heading content. Then change the server response to one photo and trigger the existing refresh button:

```ts
it('shows the current photo total beside the library heading after load and refresh', async () => {
  const first = photo({ id: 'photo-1', status: 'published' })
  const second = photo({ id: 'photo-2', status: 'published' })
  const photos = photoApi([first, second])
  const wrapper = mount(AdminApp, {
    props: { session: session(), photoApi: photos, uploadApi: idleUploadApi() },
  })
  await flushPromises()

  expect(wrapper.get('[data-photo-count]').text()).toBe('共 2 张')

  vi.mocked(photos.listPhotos).mockResolvedValueOnce([first])
  await wrapper.get('[data-refresh]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[data-photo-count]').text()).toBe('共 1 张')
})
```

Add a second integration test that drives the existing file input and delete dialog so the same visible total proves both transitions:

```ts
it('updates the visible total after upload and permanent deletion', async () => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-photo')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  const first = photo({ id: 'photo-1', status: 'published' })
  const uploaded = photo({
    id: 'photo-2',
    title: '新上传照片',
    status: 'published',
    version: 1,
  })
  const photos = photoApi([first])
  const uploads: AdminUploadApiClient = {
    uploadPhoto: vi.fn(async () => uploaded),
  }
  const wrapper = mount(AdminApp, {
    attachTo: document.body,
    props: { session: session(), photoApi: photos, uploadApi: uploads },
  })
  await flushPromises()
  expect(wrapper.get('[data-photo-count]').text()).toBe('共 1 张')

  const input = wrapper.get('input[type="file"]')
  Object.defineProperty(input.element, 'files', {
    configurable: true,
    value: [new File(['photo'], 'photo.jpg', { type: 'image/jpeg' })],
  })
  await input.trigger('change')
  await flushPromises()
  expect(wrapper.get('[data-photo-count]').text()).toBe('共 2 张')

  await wrapper.get('[data-photo-id="photo-2"] button').trigger('click')
  await wrapper.get('[data-open-delete]').trigger('click')
  await wrapper.get('[data-confirm-delete]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[data-photo-count]').text()).toBe('共 1 张')
  wrapper.unmount()
})
```

- [ ] **Step 2: Run the integration test to verify RED**

Run:

```bash
pnpm exec vitest run src/admin/AdminApp.test.ts
```

Expected: FAIL because `[data-photo-count]` is absent.

- [ ] **Step 3: Derive and render the count**

Update the existing heading in `src/admin/AdminApp.vue`:

```vue
<h2
  id="photo-library-title"
  tabindex="-1"
  :inert="isPhotoModalOpen"
  :aria-hidden="isPhotoModalOpen ? 'true' : undefined"
>
  <span>照片库</span>
  <span
    class="admin-photo-count"
    data-photo-count
  >
    共 {{ photoLibrary.photos.value.length }} 张
  </span>
</h2>
```

No new counter ref or computed value is needed.

- [ ] **Step 4: Add stable responsive heading styles**

Add to `src/styles/admin.css`:

```css
.admin-library h2 {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  font-size: 1.2rem;
  gap: 8px;
}

.admin-photo-count {
  color: #6a7176;
  font-size: 0.82rem;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  white-space: nowrap;
}
```

- [ ] **Step 5: Run the integration test to verify GREEN**

Run:

```bash
pnpm exec vitest run src/admin/AdminApp.test.ts
```

Expected: all `AdminApp` tests PASS.

- [ ] **Step 6: Run the complete verification gates**

Run each command separately:

```bash
pnpm exec vitest run src/admin
pnpm test
pnpm typecheck
pnpm lint
pnpm build:frontend
git diff --check
```

Expected: all tests, type checks, lint, frontend build, and diff checks PASS. If `apps/api/dist` is generated by an existing test, move that ignored directory to a unique `/tmp` directory before the final status check so source and generated tests are not collected twice.

- [ ] **Step 7: Commit the count and final verification**

```bash
git add src/admin/AdminApp.vue src/admin/AdminApp.test.ts src/styles/admin.css
git commit -m "feat: show the live photo total"
```

### Task 4: Resume Task 25 Production Acceptance

**Files:**
- No source changes expected.

- [ ] **Step 1: Review the implementation commits and clean state**

Run:

```bash
git status --short --branch
git log -4 --oneline --decorate
```

Expected: the branch contains the design, feedback, and count commits; the tracked worktree is clean.

- [ ] **Step 2: Push a new patch tag and monitor deployment**

After the user authorizes production publication, push `main` and the next unused annotated patch tag atomically, then monitor the exact GitHub Actions run through completion.

- [ ] **Step 3: Verify production behavior and continue backup acceptance**

Verify the inline success message, live photo total, 18-photo persistence, upload-enabled state, selected media SHA-256, then continue Task 25 with the post-activation backup download, sidecar verification, server-side `restore-data.sh verify`, and final production monitor checks.
