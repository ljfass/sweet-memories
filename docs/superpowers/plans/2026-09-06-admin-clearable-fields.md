# Admin Clearable Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an accessible per-field clear control to every visible editable field in the administrator login, reauthentication dialog, and photo editor.

**Architecture:** A stateless `ClearFieldButton` owns the Lucide icon, accessible button contract, disabled guard, and visual interaction states. Each existing form continues to own its values and explicitly clears one field before restoring focus; shared admin CSS only provides stable positioning and input padding.

**Tech Stack:** Vue 3 Composition API, TypeScript, Lucide Vue, Vue Test Utils, Vitest, existing administrator CSS.

---

## File Map

- Create `src/admin/ClearFieldButton.vue`: reusable stateless icon button with disabled protection and positioning modifiers.
- Create `src/admin/ClearFieldButton.test.ts`: component contract and disabled behavior.
- Modify `src/admin/AdminLogin.vue`: clear username and password while retaining the password visibility control.
- Modify `src/admin/AdminLogin.test.ts`: login clear behavior, focus restoration, submission lock, and password toggle regression.
- Modify `src/admin/ReauthDialog.vue`: clear username and password inside the existing focus trap.
- Modify `src/admin/ReauthDialog.test.ts`: reauthentication clear behavior and submitting state.
- Modify `src/admin/PhotoEditor.vue`: clear title, date, and description through `update-draft`.
- Modify `src/admin/PhotoEditor.test.ts`: draft payload, focus, visibility, and saving-state coverage.
- Modify `src/styles/admin.css`: shared clearable field positioning, input padding, date-picker spacing, and textarea spacing.

### Task 1: Add the stateless clear control

**Files:**
- Create: `src/admin/ClearFieldButton.vue`
- Create: `src/admin/ClearFieldButton.test.ts`

- [ ] **Step 1: Write the failing component tests**

Create `src/admin/ClearFieldButton.test.ts`:

```ts
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ClearFieldButton from './ClearFieldButton.vue'

describe('ClearFieldButton', () => {
  it('exposes one named non-submit icon action', async () => {
    const wrapper = mount(ClearFieldButton, { props: { label: '清空用户名' } })
    const button = wrapper.get('button')

    expect(button.attributes()).toMatchObject({
      type: 'button',
      title: '清空用户名',
      'aria-label': '清空用户名',
    })
    expect(button.find('svg').attributes('aria-hidden')).toBe('true')

    await button.trigger('click')
    expect(wrapper.emitted('clear')).toHaveLength(1)
  })

  it('does not emit while disabled', async () => {
    const wrapper = mount(ClearFieldButton, {
      props: { label: '清空密码', disabled: true },
    })

    expect(wrapper.get('button').attributes()).toHaveProperty('disabled')
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('clear')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
pnpm exec vitest run src/admin/ClearFieldButton.test.ts
```

Expected: FAIL because `src/admin/ClearFieldButton.vue` does not exist.

- [ ] **Step 3: Implement the minimal clear control**

Create `src/admin/ClearFieldButton.vue`:

```vue
<script setup lang="ts">
import { X } from '@lucide/vue'

const props = withDefaults(defineProps<{
  label: string
  disabled?: boolean
}>(), {
  disabled: false,
})

const emit = defineEmits<{
  clear: []
}>()

function clear(): void {
  if (!props.disabled) emit('clear')
}
</script>

<template>
  <button
    class="admin-clear-field-button"
    type="button"
    :disabled="disabled"
    :title="label"
    :aria-label="label"
    @click="clear"
  >
    <X
      :size="16"
      aria-hidden="true"
    />
  </button>
</template>

<style scoped>
.admin-clear-field-button {
  position: absolute;
  z-index: 1;
  top: 50%;
  right: 4px;
  display: grid;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  color: var(--admin-muted, #70676c);
  background: transparent;
  cursor: pointer;
  place-items: center;
  transform: translateY(-50%);
  transition: color 160ms ease, background-color 160ms ease;
}

.admin-clear-field-button.is-before-trailing-action {
  right: 44px;
}

.admin-clear-field-button.is-before-native-action {
  right: 40px;
}

.admin-clear-field-button.is-textarea {
  top: 4px;
  transform: none;
}

.admin-clear-field-button:hover:not(:disabled) {
  color: var(--admin-text, #2d292c);
  background: rgb(45 41 44 / 7%);
}

.admin-clear-field-button:focus-visible {
  outline: 3px solid var(--admin-teal, #39767a);
  outline-offset: 1px;
}

.admin-clear-field-button:disabled {
  cursor: default;
  opacity: 0.45;
}

@media (prefers-reduced-motion: reduce) {
  .admin-clear-field-button {
    transition: none;
  }
}
</style>
```

- [ ] **Step 4: Run the component test to verify GREEN**

Run:

```bash
pnpm exec vitest run src/admin/ClearFieldButton.test.ts
```

Expected: 2 tests PASS.

- [ ] **Step 5: Commit the reusable control**

```bash
git add src/admin/ClearFieldButton.vue src/admin/ClearFieldButton.test.ts
git commit -m "feat: add reusable field clear control"
```

### Task 2: Add clear controls to the administrator login

**Files:**
- Modify: `src/admin/AdminLogin.vue:1-30,184-244,637-712`
- Modify: `src/admin/AdminLogin.test.ts:1-63`

- [ ] **Step 1: Write the failing login interaction tests**

Add tests to `src/admin/AdminLogin.test.ts` that mount on `document.body`, fill both fields, clear them independently, and verify focus and password visibility:

```ts
it('clears username and password independently and restores field focus', async () => {
  const wrapper = mount(AdminLogin, {
    attachTo: document.body,
    props: { login: vi.fn() },
  })
  const username = wrapper.get('input[name="username"]')
  const password = wrapper.get('input[name="password"]')
  await username.setValue('alice')
  await password.setValue('correct-password')

  await wrapper.get('button[aria-label="清空用户名"]').trigger('click')
  await flushPromises()
  expect((username.element as HTMLInputElement).value).toBe('')
  expect((password.element as HTMLInputElement).value).toBe('correct-password')
  expect(document.activeElement).toBe(username.element)

  await wrapper.get('button[aria-label="显示密码"]').trigger('click')
  expect(password.attributes('type')).toBe('text')
  await wrapper.get('button[aria-label="清空密码"]').trigger('click')
  await flushPromises()
  expect((password.element as HTMLInputElement).value).toBe('')
  expect(password.attributes('type')).toBe('text')
  expect(document.activeElement).toBe(password.element)
  wrapper.unmount()
})

it('hides clear controls for empty fields and locks them during submission', async () => {
  let resolveLogin: (() => void) | undefined
  const login = vi.fn(() => new Promise<void>((resolve) => { resolveLogin = resolve }))
  const wrapper = mount(AdminLogin, { props: { login } })

  expect(wrapper.find('button[aria-label="清空用户名"]').exists()).toBe(false)
  expect(wrapper.find('button[aria-label="清空密码"]').exists()).toBe(false)
  await wrapper.get('input[name="username"]').setValue('alice')
  await wrapper.get('input[name="password"]').setValue('correct-password')
  await wrapper.get('form').trigger('submit')

  expect(wrapper.get('button[aria-label="清空用户名"]').attributes()).toHaveProperty('disabled')
  expect(wrapper.get('button[aria-label="清空密码"]').attributes()).toHaveProperty('disabled')
  resolveLogin?.()
  await flushPromises()
})
```

- [ ] **Step 2: Run the login test to verify RED**

Run:

```bash
pnpm exec vitest run src/admin/AdminLogin.test.ts
```

Expected: FAIL because no buttons named `清空用户名` or `清空密码` exist.

- [ ] **Step 3: Wire local clearing and focus restoration**

In `src/admin/AdminLogin.vue`:

```ts
import { nextTick, onMounted, ref } from 'vue'
import ClearFieldButton from './ClearFieldButton.vue'

const passwordInput = ref<HTMLInputElement | null>(null)

async function clearUsername(): Promise<void> {
  username.value = ''
  await nextTick()
  usernameInput.value?.focus()
}

async function clearPassword(): Promise<void> {
  password.value = ''
  await nextTick()
  passwordInput.value?.focus()
}
```

Place a clear control after the username input and add the password input ref plus the offset clear control before the existing visibility button:

```vue
<ClearFieldButton
  v-if="username !== ''"
  label="清空用户名"
  :disabled="isSubmitting"
  @clear="clearUsername"
/>

<ClearFieldButton
  v-if="password !== ''"
  class="is-before-trailing-action"
  label="清空密码"
  :disabled="isSubmitting"
  @clear="clearPassword"
/>
```

Give the username input `:class="{ 'has-clear-action': username !== '' }"` and the password input `ref="passwordInput"` plus `:class="{ 'has-two-actions': password !== '' }"`. Extend the existing scoped login styles:

```css
.input-shell input.has-clear-action {
  padding-right: 52px;
}

.input-shell input.has-two-actions {
  padding-right: 88px;
}
```

- [ ] **Step 4: Run login and clear-control tests to verify GREEN**

Run:

```bash
pnpm exec vitest run src/admin/ClearFieldButton.test.ts src/admin/AdminLogin.test.ts
```

Expected: 2 files PASS; existing duplicate-submit and error-sanitization tests remain green.

- [ ] **Step 5: Commit the login integration**

```bash
git add src/admin/AdminLogin.vue src/admin/AdminLogin.test.ts
git commit -m "feat: clear administrator login fields"
```

### Task 3: Add clear controls to reauthentication

**Files:**
- Modify: `src/admin/ReauthDialog.vue:1-22,139-166`
- Modify: `src/admin/ReauthDialog.test.ts:16-195`
- Modify: `src/styles/admin.css:94-150`

- [ ] **Step 1: Write failing reauthentication tests**

Add to `src/admin/ReauthDialog.test.ts`:

```ts
it('clears reauthentication fields independently and keeps focus in the dialog', async () => {
  const wrapper = mount(ReauthDialog, {
    attachTo: document.body,
    props: { open: true, username: 'alice', login: vi.fn(), logout: vi.fn() },
  })
  await nextTick()
  const username = wrapper.get('input[name="username"]')
  const password = wrapper.get('input[name="password"]')
  await password.setValue('new-password')

  await wrapper.get('button[aria-label="清空用户名"]').trigger('click')
  await flushPromises()
  expect((username.element as HTMLInputElement).value).toBe('')
  expect((password.element as HTMLInputElement).value).toBe('new-password')
  expect(document.activeElement).toBe(username.element)

  await wrapper.get('button[aria-label="清空密码"]').trigger('click')
  await flushPromises()
  expect((password.element as HTMLInputElement).value).toBe('')
  expect(document.activeElement).toBe(password.element)
  wrapper.unmount()
})

it('disables reauthentication clear controls while submitting', async () => {
  const login = vi.fn(() => new Promise<void>(() => undefined))
  const wrapper = mount(ReauthDialog, {
    props: { open: true, username: 'alice', login, logout: vi.fn() },
  })
  await wrapper.get('input[name="password"]').setValue('new-password')
  await wrapper.get('form').trigger('submit')

  expect(wrapper.get('button[aria-label="清空用户名"]').attributes()).toHaveProperty('disabled')
  expect(wrapper.get('button[aria-label="清空密码"]').attributes()).toHaveProperty('disabled')
})
```

- [ ] **Step 2: Run the reauthentication test to verify RED**

Run:

```bash
pnpm exec vitest run src/admin/ReauthDialog.test.ts
```

Expected: FAIL because the reauthentication fields have no clear controls.

- [ ] **Step 3: Implement reauthentication clearing**

In `src/admin/ReauthDialog.vue`, import `ClearFieldButton`, add `passwordInput`, and add explicit functions:

```ts
import ClearFieldButton from './ClearFieldButton.vue'

const passwordInput = ref<HTMLInputElement | null>(null)

async function clearUsername(): Promise<void> {
  username.value = ''
  await nextTick()
  usernameInput.value?.focus()
}

async function clearPassword(): Promise<void> {
  password.value = ''
  await nextTick()
  passwordInput.value?.focus()
}
```

Wrap each existing input in `.admin-clearable-field`, set `ref="passwordInput"` on the password field, and render the matching button only for a nonempty value:

```vue
<div class="admin-clearable-field">
  <input
    id="reauth-username"
    ref="usernameInput"
    v-model="username"
    name="username"
    type="text"
    autocomplete="username"
    maxlength="32"
    required
    :disabled="isSubmitting"
  >
  <ClearFieldButton
    v-if="username !== ''"
    label="清空用户名"
    :disabled="isSubmitting"
    @clear="clearUsername"
  />
</div>
```

Repeat the wrapper for password with `label="清空密码"` and `@clear="clearPassword"`. Add shared layout rules to `src/styles/admin.css`:

```css
.admin-clearable-field {
  position: relative;
}

.admin-clearable-field > input,
.admin-clearable-field > textarea {
  padding-right: 52px;
}

.admin-clearable-field > input[type="date"] {
  padding-right: 84px;
}
```

- [ ] **Step 4: Run reauthentication and focus-trap regression tests**

Run:

```bash
pnpm exec vitest run src/admin/ClearFieldButton.test.ts src/admin/ReauthDialog.test.ts
```

Expected: both files PASS; Escape, Tab trap, logout failure, workspace preservation, and focus-return tests remain green.

- [ ] **Step 5: Commit the reauthentication integration**

```bash
git add src/admin/ReauthDialog.vue src/admin/ReauthDialog.test.ts src/styles/admin.css
git commit -m "feat: clear reauthentication fields"
```

### Task 4: Add clear controls to the photo editor

**Files:**
- Modify: `src/admin/PhotoEditor.vue:1-115`
- Modify: `src/admin/PhotoEditor.test.ts:1-96`

- [ ] **Step 1: Write failing photo draft tests**

Add to `src/admin/PhotoEditor.test.ts` and import `nextTick` from Vue:

```ts
it('clears each photo draft field and restores its focus', async () => {
  const populatedDraft: PhotoDraft = {
    title: '满月',
    capturedDate: '2026-06-01',
    description: '第一次拍证件照',
  }
  const wrapper = mount(PhotoEditor, {
    attachTo: document.body,
    props: {
      photo, draft: populatedDraft, conflict: false, saving: false,
      message: '', messageTone: null,
    },
  })

  const cases = [
    ['标题', 'title'],
    ['拍摄日期', 'capturedDate'],
    ['图片描述', 'description'],
  ] as const

  for (const [label, field] of cases) {
    const control = field === 'description'
      ? wrapper.get(`textarea[name="${field}"]`)
      : wrapper.get(`input[name="${field}"]`)
    await wrapper.get(`button[aria-label="清空${label}"]`).trigger('click')
    await nextTick()
    expect(wrapper.emitted('update-draft')?.at(-1)?.[0]).toMatchObject({ [field]: '' })
    expect(document.activeElement).toBe(control.element)
  }
  wrapper.unmount()
})

it('hides empty draft clear controls and disables visible controls while saving', async () => {
  const wrapper = mount(PhotoEditor, {
    props: {
      photo, draft: { title: '', capturedDate: '', description: '' },
      conflict: false, saving: false, message: '', messageTone: null,
    },
  })
  expect(wrapper.find('.admin-clear-field-button').exists()).toBe(false)

  await wrapper.setProps({
    draft: { title: '满月', capturedDate: '2026-06-01', description: '成长记录' },
    saving: true,
  })
  for (const button of wrapper.findAll('.admin-clear-field-button')) {
    expect(button.attributes()).toHaveProperty('disabled')
  }
})
```

- [ ] **Step 2: Run the photo editor test to verify RED**

Run:

```bash
pnpm exec vitest run src/admin/PhotoEditor.test.ts
```

Expected: FAIL because no photo draft clear controls exist.

- [ ] **Step 3: Implement draft clearing through the existing event**

In `src/admin/PhotoEditor.vue`, import `nextTick`, `ref`, and `ClearFieldButton`; add three field refs and one helper:

```ts
import { nextTick, ref } from 'vue'
import ClearFieldButton from './ClearFieldButton.vue'

const titleInput = ref<HTMLInputElement | null>(null)
const dateInput = ref<HTMLInputElement | null>(null)
const descriptionInput = ref<HTMLTextAreaElement | null>(null)

async function clearDraftField(
  field: keyof PhotoDraft,
  target: HTMLInputElement | HTMLTextAreaElement | null,
): Promise<void> {
  emit('update-draft', { ...props.draft, [field]: '' })
  await nextTick()
  if (target?.isConnected) target.focus()
}
```

Wrap title, date, and description controls in `.admin-clearable-field`. Add refs and buttons. The date button must leave room for the browser calendar action; the textarea button uses top alignment:

```vue
<ClearFieldButton
  v-if="draft.title !== ''"
  label="清空标题"
  :disabled="saving"
  @clear="clearDraftField('title', titleInput)"
/>

<ClearFieldButton
  v-if="draft.capturedDate !== ''"
  class="is-before-native-action"
  label="清空拍摄日期"
  :disabled="saving"
  @clear="clearDraftField('capturedDate', dateInput)"
/>

<ClearFieldButton
  v-if="draft.description !== ''"
  class="is-textarea"
  label="清空图片描述"
  :disabled="saving"
  @clear="clearDraftField('description', descriptionInput)"
/>
```

Use `ref="titleInput"`, `ref="dateInput"`, and `ref="descriptionInput"` on their matching controls. Preserve the current `input` event handler so typing and clearing use the same `update-draft` contract.

- [ ] **Step 4: Run photo-editor and draft-state tests to verify GREEN**

Run:

```bash
pnpm exec vitest run src/admin/PhotoEditor.test.ts src/admin/usePhotoLibrary.test.ts
```

Expected: both files PASS; clearing emits ordinary drafts and existing dirty/conflict/save behavior remains green.

- [ ] **Step 5: Commit the photo editor integration**

```bash
git add src/admin/PhotoEditor.vue src/admin/PhotoEditor.test.ts
git commit -m "feat: clear photo editor fields"
```

### Task 5: Run complete verification

**Files:**
- Verify all files changed in Tasks 1-4.

- [ ] **Step 1: Run the focused clear-field suite**

```bash
pnpm exec vitest run src/admin/ClearFieldButton.test.ts src/admin/AdminLogin.test.ts src/admin/ReauthDialog.test.ts src/admin/PhotoEditor.test.ts src/admin/usePhotoLibrary.test.ts
```

Expected: all focused tests PASS with no unhandled errors or console warnings.

- [ ] **Step 2: Run the complete administrator regression suite**

```bash
pnpm exec vitest run src/admin src/main.test.ts
```

Expected: all administrator and entrypoint tests PASS.

- [ ] **Step 3: Run the source-only repository test suite**

```bash
pnpm exec vitest run --exclude 'apps/api/dist/**'
```

Expected: all source tests PASS; no generated API tests are collected.

- [ ] **Step 4: Run static validation**

```bash
pnpm typecheck
pnpm lint
git diff --check
```

Expected: each command exits 0. A local Node version warning is informational only if the declared Node 24 production contract remains unchanged.

- [ ] **Step 5: Build the frontend**

```bash
pnpm build:frontend
```

Expected: Vite production build exits 0 and generates the frontend bundle without layout or template compilation errors.

- [ ] **Step 6: Preserve generated output outside the worktree and inspect status**

```bash
clear_fields_artifacts="$(mktemp -d /tmp/sweet-memories-clear-fields.XXXXXX)"
if [ -d dist ]; then mv dist "$clear_fields_artifacts/frontend-dist"; fi
git status --short --branch
```

Expected: only deliberate source changes or commits are present; `.superpowers/` remains untouched and untracked if it existed before implementation.

- [ ] **Step 7: Create a final fixup commit only if verification required changes**

```bash
git add src/admin/ClearFieldButton.vue src/admin/ClearFieldButton.test.ts src/admin/AdminLogin.vue src/admin/AdminLogin.test.ts src/admin/ReauthDialog.vue src/admin/ReauthDialog.test.ts src/admin/PhotoEditor.vue src/admin/PhotoEditor.test.ts src/styles/admin.css
git commit -m "fix: finish accessible field clearing"
```

Expected: skip this commit when Tasks 1-4 already pass unchanged; otherwise commit only verified corrections.
