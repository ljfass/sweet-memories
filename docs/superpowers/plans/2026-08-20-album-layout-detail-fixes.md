# Album Layout Detail Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct three visual fidelity gaps: stack the header information blocks, restore `REC 🔴`, and align the sleep control's size and surface opacity with the original page.

**Architecture:** Keep the existing Vue component tree and interactions unchanged. Add a focused raw-CSS regression test, then make the smallest declarations in the existing global stylesheet so desktop and mobile behavior remain centralized.

**Tech Stack:** Vue 3, TypeScript, CSS, Vite raw imports, Vitest, pnpm

---

## File Map

- Create: `scripts/global-styles.test.ts` - locks the user-visible CSS values that must match the reference without adding Node types to the browser application.
- Modify: `src/styles/global.css` - applies the stacked header layout, recording indicator, and sleep-control dimensions/surfaces.

### Task 1: Add The Visual Fidelity Regression Test

**Files:**
- Create: `scripts/global-styles.test.ts`
- Test: `scripts/global-styles.test.ts`

- [ ] **Step 1: Write the failing CSS contract test**

```ts
// @vitest-environment node

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const globalCss = readFileSync(
  new URL('../src/styles/global.css', import.meta.url),
  'utf8',
)

describe('album visual fidelity styles', () => {
  it('stacks and centers the subtitle and age counter', () => {
    expect(globalCss).toMatch(
      /\.subtitle,\s*\.age-counter\s*{[^}]*display:\s*block;[^}]*width:\s*fit-content;[^}]*margin-inline:\s*auto;/s,
    )
  })

  it('uses the original recording indicator', () => {
    expect(globalCss).toContain('content: "REC 🔴";')
  })

  it('matches the original sleep control footprint and surfaces', () => {
    expect(globalCss).toMatch(
      /\.sleep-toggle\s*{[^}]*width:\s*55px;[^}]*height:\s*55px;[^}]*background:\s*rgb\(255 255 255 \/ 60%\);/s,
    )
    expect(globalCss).toMatch(
      /\.sleep-toggle svg\s*{[^}]*width:\s*35px;[^}]*height:\s*35px;/s,
    )
    expect(globalCss).toMatch(
      /\.is-sleeping \.sleep-toggle\s*{[^}]*background:\s*rgb\(30 41 59 \/ 80%\);/s,
    )
    expect(globalCss).toMatch(
      /@media \(max-width: 768px\)[\s\S]*?\.sleep-toggle\s*{[^}]*width:\s*45px;[^}]*height:\s*45px;[^}]*}[\s\S]*?\.sleep-toggle svg\s*{[^}]*width:\s*28px;[^}]*height:\s*28px;/s,
    )
  })
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm test -- scripts/global-styles.test.ts
```

Expected: three tests fail because the current stylesheet uses inline header blocks, `REC ●`, and different sleep-control values.

### Task 2: Apply The Minimal CSS Corrections

**Files:**
- Modify: `src/styles/global.css`
- Test: `scripts/global-styles.test.ts`

- [ ] **Step 1: Stack the header information blocks**

Update the shared selector to:

```css
.subtitle,
.age-counter {
  display: block;
  width: fit-content;
  max-width: 100%;
  margin-inline: auto;
  box-shadow: 0 4px 15px rgb(71 50 57 / 7%);
}
```

Keep `.age-counter { margin-top: 20px; }`; its longhand top margin does not replace the automatic inline margins.

- [ ] **Step 2: Restore the recording indicator**

Change the video pseudo-element declaration to:

```css
content: "REC 🔴";
```

- [ ] **Step 3: Match the desktop sleep control**

Update and extend the desktop rules:

```css
.sleep-toggle {
  top: 25px;
  right: 30px;
  width: 55px;
  height: 55px;
  background: rgb(255 255 255 / 60%);
}

.sleep-toggle svg {
  width: 35px;
  height: 35px;
}

.is-sleeping .sleep-toggle {
  background: rgb(30 41 59 / 80%);
}
```

- [ ] **Step 4: Match the mobile sleep control**

Inside `@media (max-width: 768px)`, use:

```css
.sleep-toggle {
  top: 15px;
  right: 15px;
  width: 45px;
  height: 45px;
}

.sleep-toggle svg {
  width: 28px;
  height: 28px;
}
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
pnpm test -- scripts/global-styles.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 6: Run complete verification**

Run each command and require exit code 0:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --exit-code -- codebase
```

Expected: lint and type checking pass, all tests pass, the production build succeeds, and `codebase/` remains unchanged.

- [ ] **Step 7: Commit**

```bash
git add scripts/global-styles.test.ts src/styles/global.css docs/superpowers/plans/2026-08-20-album-layout-detail-fixes.md
git commit -m "fix: align album details with reference"
```
