# Mobile Editor Sticky Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the mobile photo editor's back, title, and delete controls visible after the editor content scrolls.

**Architecture:** Preserve the existing `PhotoEditor.vue` structure and make its header sticky only inside the mobile full-screen editor scroll container. Encode the layout contract in the existing CSS source test so the behavior remains script-free and desktop styling is unchanged.

**Tech Stack:** Vue 3, scoped component markup, plain CSS, Vitest.

---

### Task 1: Lock the mobile sticky-header contract

**Files:**
- Modify: `src/admin/AdminApp.test.ts`
- Test: `src/admin/AdminApp.test.ts`

- [ ] **Step 1: Write the failing CSS contract test**

Add this assertion to the existing `keeps the approved desktop and mobile layout constraints` test after the mobile editor assertion:

```ts
expect(adminCss).toMatch(
  /@media\s*\(max-width:\s*720px\)[\s\S]*\.admin-photo-editor-header\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*z-index:\s*2;[^}]*padding-top:\s*calc\(12px \+ env\(safe-area-inset-top, 0px\)\);[^}]*background:\s*var\(--admin-paper\);/,
)
```

This test intentionally checks the mobile media block so a desktop-only sticky rule cannot satisfy it.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm exec vitest run src/admin/AdminApp.test.ts
```

Expected: one failed assertion because the mobile `.admin-photo-editor-header` rule does not yet contain `position: sticky` and its safety/stacking declarations.

### Task 2: Implement the script-free sticky toolbar

**Files:**
- Modify: `src/styles/admin.css`
- Test: `src/admin/AdminApp.test.ts`

- [ ] **Step 1: Add the minimal mobile header rule**

Inside `@media (max-width: 720px)`, extend `.admin-photo-editor-header` to:

```css
.admin-photo-editor-header {
  position: sticky;
  z-index: 2;
  top: 0;
  grid-template-columns: 44px 1fr 44px;
  margin: -18px -16px 16px;
  padding: calc(12px + env(safe-area-inset-top, 0px)) 16px 12px;
  border-bottom: 1px solid var(--admin-border);
  background: var(--admin-paper);
  box-shadow: 0 4px 12px rgb(35 39 42 / 8%);
}
```

The negative margins make the toolbar span the editor width while its horizontal padding preserves the existing control alignment. `top: 0` is relative to the existing `.admin-photo-editor` scroll container; the safe-area inset is applied as padding rather than as a sticky offset, so no content gap appears above the toolbar.

- [ ] **Step 2: Run the focused test and verify GREEN**

Run:

```bash
pnpm exec vitest run src/admin/AdminApp.test.ts
```

Expected: all tests pass with no warnings.

- [ ] **Step 3: Run the adjacent editor regression tests**

Run:

```bash
pnpm exec vitest run src/admin/AdminApp.test.ts src/admin/PhotoEditor.test.ts src/admin/PhotoLibrary.test.ts
```

Expected: all tests pass; back/delete events, mobile modal behavior, focus handling, date containment, and save feedback remain unchanged.

### Task 3: Verify and commit

**Files:**
- Verify: `src/admin/AdminApp.test.ts`
- Verify: `src/styles/admin.css`

- [ ] **Step 1: Run static project gates**

Run:

```bash
pnpm typecheck
pnpm lint
git diff --check
```

Expected: all commands exit successfully.

- [ ] **Step 2: Run the frontend build**

Run:

```bash
pnpm build:frontend
```

Expected: Vite completes a production frontend build successfully.

- [ ] **Step 3: Inspect the mobile layout when a browser runtime is available**

At a 390x844 viewport, open `/admin`, select a photo, scroll the editor below the preview, and verify:

```text
- header remains at the top of the editor viewport
- no horizontal overflow appears
- preview and form scroll underneath without being obscured
- back and delete buttons remain operable
```

If no browser runtime is available, report that limitation and rely on the focused DOM/CSS contract plus build verification.

- [ ] **Step 4: Commit the implementation**

```bash
git add src/admin/AdminApp.test.ts src/styles/admin.css docs/superpowers/plans/2026-09-29-mobile-editor-sticky-header.md
git commit -m "fix: keep mobile photo controls visible"
```
