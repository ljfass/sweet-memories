# Search Indexing Privacy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the baby album publicly reachable by its address while asking search engines not to crawl or index it, and keep SEO visible in Lighthouse as an advisory result instead of a hard failure.

**Architecture:** Add source-level and built-output search directives at the Vite entry point and `public` directory. Extend the existing shared Lighthouse threshold records with an assertion level so configuration, assertions, summaries, tests, and documentation all derive the same required-versus-advisory policy. Do not change deployment, monitoring, Nginx, server access, repository visibility, Secrets, or Environment settings.

**Tech Stack:** Vue 3, Vite 8, Vitest 4, Happy DOM, Lighthouse CI 0.15, CommonJS configuration, Markdown documentation, pnpm 8.6.1.

---

## Working Rules

- Work only in `.worktrees/search-indexing-privacy` on branch `feat/search-indexing-privacy`.
- Follow `superpowers:test-driven-development`: add or change a test, observe the intended failure, make the smallest production change, then rerun the focused test.
- Use `apply_patch` for every manual edit.
- Do not change `.github/workflows/deploy.yml`, `.github/workflows/monitor.yml`, `.github/workflows/lighthouse.yml`, deployment scripts, monitoring scripts, Nginx, server files, GitHub Secrets, or GitHub Environment settings.
- Do not describe `robots.txt` or `noindex` as authentication, authorization, or a security boundary.
- Keep Best Practices at `error` with target `0.90`; the HTTP deployment is expected to remain red until HTTPS is configured separately.
- Make the commits listed below. Do not create or push a release Tag during implementation.

## Baseline Evidence

Before implementation, this worktree was created from `bb51fd1` and the untouched baseline passed:

```text
Test Files  21 passed (21)
Tests       90 passed (90)
```

Reconfirm the worktree before editing:

```bash
git status --short --branch
git rev-parse --show-toplevel
```

Expected branch: `feat/search-indexing-privacy`. Expected status: clean.

### Task 1: Add and build the privacy-first search directives

**Files:**

- Create: `scripts/seo-policy.test.ts`
- Modify: `index.html`
- Create: `public/robots.txt`

- [ ] **Step 1: Add the failing source and build-output contract**

Create `scripts/seo-policy.test.ts` with this complete content:

```ts
// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'
import { build } from 'vite'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const sourceIndexPath = fileURLToPath(new URL('../index.html', import.meta.url))
const sourceRobotsPath = fileURLToPath(new URL('../public/robots.txt', import.meta.url))
const expectedDescription = '记录宝宝成长瞬间的家庭纪念相册。'
const expectedRobotsMeta = 'noindex, nofollow, noarchive, nosnippet, noimageindex'
const expectedRobotsFile = 'User-agent: *\nDisallow: /\n'
const temporaryDirectories: string[] = []

function parseHtml(html: string) {
  const window = new Window({ url: 'http://example.test/' })
  window.document.write(html)
  window.document.close()
  return window.document
}

function expectSearchMetadata(html: string) {
  const document = parseHtml(html)
  const descriptions = document.querySelectorAll('meta[name="description"]')
  const robots = document.querySelectorAll('meta[name="robots"]')

  expect(descriptions).toHaveLength(1)
  expect(descriptions[0]?.getAttribute('content')).toBe(expectedDescription)
  expect(robots).toHaveLength(1)
  expect(robots[0]?.getAttribute('content')).toBe(expectedRobotsMeta)
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

describe('search indexing privacy policy', () => {
  it('declares the exact privacy-first metadata in the source HTML', async () => {
    expectSearchMetadata(await readFile(sourceIndexPath, 'utf8'))
  })

  it('publishes the exact deny-all robots policy', async () => {
    await expect(readFile(sourceRobotsPath, 'utf8')).resolves.toBe(expectedRobotsFile)
  })

  it('preserves the search policy in a real Vite build', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'sweet-memories-seo-build-'))
    temporaryDirectories.push(outputDirectory)

    await build({
      root: projectRoot,
      logLevel: 'silent',
      build: {
        outDir: outputDirectory,
        emptyOutDir: true,
      },
    })

    const [builtHtml, builtRobots] = await Promise.all([
      readFile(join(outputDirectory, 'index.html'), 'utf8'),
      readFile(join(outputDirectory, 'robots.txt'), 'utf8'),
    ])

    expectSearchMetadata(builtHtml)
    expect(builtRobots).toBe(expectedRobotsFile)
  })
})
```

- [ ] **Step 2: Run the focused test and record RED**

```bash
pnpm exec vitest run scripts/seo-policy.test.ts
```

Expected: failure because `index.html` has no description/robots metadata and `public/robots.txt` does not exist. Do not proceed unless the failure is caused by those missing production artifacts.

- [ ] **Step 3: Add the exact HTML metadata**

In `index.html`, insert the following immediately after the viewport meta element:

```html
    <meta name="description" content="记录宝宝成长瞬间的家庭纪念相册。" />
    <meta
      name="robots"
      content="noindex, nofollow, noarchive, nosnippet, noimageindex"
    />
```

Do not add names, dates, locations, contact information, or other personal details to the description.

- [ ] **Step 4: Add the exact robots file**

Create `public/robots.txt` with a final newline:

```text
User-agent: *
Disallow: /
```

- [ ] **Step 5: Run GREEN and focused static checks**

```bash
pnpm exec vitest run scripts/seo-policy.test.ts
pnpm exec eslint scripts/seo-policy.test.ts
git diff --check
```

Expected: 3 tests pass; ESLint and diff check exit `0`.

- [ ] **Step 6: Commit Task 1**

```bash
git add index.html public/robots.txt scripts/seo-policy.test.ts
git diff --cached --check
git commit -m "feat: add private search indexing directives"
```

### Task 2: Make SEO advisory from the shared Lighthouse policy

**Files:**

- Modify: `scripts/lighthouse/thresholds.cjs`
- Modify: `lighthouserc.cjs`
- Modify: `scripts/lighthouse/config.test.ts`
- Modify: `scripts/lighthouse/summarize-reports.mjs`
- Modify: `scripts/lighthouse/summarize-reports.test.ts`

- [ ] **Step 1: Change the configuration expectation before production code**

In `scripts/lighthouse/config.test.ts`, replace the expected assertion object in `asserts median category thresholds without an upload target` with:

```ts
    expect(ci.assert.assertions).toEqual({
      'categories:performance': ['error', { aggregationMethod: 'median', minScore: 0.7 }],
      'categories:accessibility': ['error', { aggregationMethod: 'median', minScore: 0.9 }],
      'categories:best-practices': ['error', { aggregationMethod: 'median', minScore: 0.9 }],
      'categories:seo': ['warn', { aggregationMethod: 'median', minScore: 0.9 }],
    })
```

Change that test name to:

```ts
  it('asserts required categories as errors and private SEO as a median warning', () => {
```

- [ ] **Step 2: Add summary warning/failure tests and update the heading contract**

In the first expected summary in `scripts/lighthouse/summarize-reports.test.ts`, replace:

```ts
      '| 分类 | 最低分 | 三次中位数 | 结果 |',
```

with:

```ts
      '| 分类 | 目标分 | 三次中位数 | 结果 |',
```

Add these tests inside the existing `describe` block, after the exact-threshold performance test:

```ts
  it('renders a below-target SEO median as an advisory result', () => {
    const summary = summarizeReports([
      report({ seo: 0.8 }),
      report({ seo: 0.83 }),
      report({ seo: 0.86 }),
    ])

    expect(summary).toContain('| SEO | 90 | 83 | 提示 |')
    expect(summary).not.toContain('未通过')
  })

  it('keeps a below-target required category as a failure result', () => {
    const summary = summarizeReports([
      report({ 'best-practices': 0.77 }),
      report({ 'best-practices': 0.79 }),
      report({ 'best-practices': 0.81 }),
    ])

    expect(summary).toContain('| 最佳实践 | 90 | 79 | 未通过 |')
  })
```

- [ ] **Step 3: Run the focused tests and record RED**

```bash
pnpm exec vitest run scripts/lighthouse/config.test.ts scripts/lighthouse/summarize-reports.test.ts
```

Expected failures:

- SEO is still emitted as `error` instead of `warn`;
- the summary still uses `最低分`;
- below-target SEO still renders as `未通过`.

- [ ] **Step 4: Replace the shared threshold records**

Replace the exported array in `scripts/lighthouse/thresholds.cjs` with:

```js
module.exports = Object.freeze([
  Object.freeze({ id: 'performance', label: '性能', minScore: 0.7, assertionLevel: 'error' }),
  Object.freeze({ id: 'accessibility', label: '可访问性', minScore: 0.9, assertionLevel: 'error' }),
  Object.freeze({ id: 'best-practices', label: '最佳实践', minScore: 0.9, assertionLevel: 'error' }),
  Object.freeze({ id: 'seo', label: 'SEO', minScore: 0.9, assertionLevel: 'warn' }),
])
```

Keep the existing `'use strict'` line.

- [ ] **Step 5: Generate LHCI assertion severity from the shared records**

In `lighthouserc.cjs`, replace the assertion mapping with:

```js
        thresholds.map(({ id, minScore, assertionLevel }) => [
          `categories:${id}`,
          [assertionLevel, { aggregationMethod: 'median', minScore }],
        ]),
```

Do not special-case `seo` in this file; the threshold source must remain authoritative.

- [ ] **Step 6: Render advisory and required results differently**

In `scripts/lighthouse/summarize-reports.mjs`, replace the result calculation with:

```js
    const result = median >= threshold.minScore
      ? '通过'
      : threshold.assertionLevel === 'warn'
        ? '提示'
        : '未通过'
```

Replace the Markdown table heading with:

```js
    '| 分类 | 目标分 | 三次中位数 | 结果 |',
```

- [ ] **Step 7: Run GREEN and focused static checks**

```bash
pnpm exec vitest run scripts/lighthouse/config.test.ts scripts/lighthouse/summarize-reports.test.ts
node --check lighthouserc.cjs
node --check scripts/lighthouse/thresholds.cjs
node --check scripts/lighthouse/summarize-reports.mjs
pnpm exec eslint scripts/lighthouse/config.test.ts scripts/lighthouse/summarize-reports.test.ts
git diff --check
```

Expected: both focused test files pass; syntax, ESLint, and diff checks exit `0`.

- [ ] **Step 8: Commit Task 2**

```bash
git add lighthouserc.cjs scripts/lighthouse/thresholds.cjs \
  scripts/lighthouse/config.test.ts \
  scripts/lighthouse/summarize-reports.mjs \
  scripts/lighthouse/summarize-reports.test.ts
git diff --cached --check
git commit -m "feat: make private SEO score advisory"
```

### Task 3: Document the privacy boundary and advisory result

**Files:**

- Modify: `scripts/lighthouse/docs.test.ts`
- Modify: `docs/lighthouse.md`

- [ ] **Step 1: Strengthen the documentation contract first**

In `scripts/lighthouse/docs.test.ts`, replace the existing threshold loop with:

```ts
    for (const threshold of thresholds) {
      const resultType = threshold.assertionLevel === 'warn' ? '提示' : '强制'
      expect(guide).toContain(
        `| ${threshold.label} | ${Math.round(threshold.minScore * 100)} | ${resultType} |`,
      )
    }
```

Add these required strings to the `requiredText` array in the first test:

```ts
      'SEO 低于 90 分只显示提示',
      '不会单独让工作流变红',
      '不是密码保护或访问控制',
      '知道地址的任何人仍然可以访问',
      '`User-agent: *`',
      '`Disallow: /`',
      '`noindex`',
      '最佳实践仍是强制项',
```

- [ ] **Step 2: Run the documentation test and record RED**

```bash
pnpm exec vitest run scripts/lighthouse/docs.test.ts
```

Expected: failure because the guide still labels all categories as minimum scores and says any category below target makes the run red.

- [ ] **Step 3: Replace the score-policy section in the guide**

Replace the `## 分数要求` section of `docs/lighthouse.md`, through the paragraph before `## 查看分数和报告`, with this complete section:

```md
## 分数要求

| 分类 | 目标分 | 低于目标时 |
| --- | ---: | --- |
| 性能 | 70 | 强制 |
| 可访问性 | 90 | 强制 |
| 最佳实践 | 90 | 强制 |
| SEO | 90 | 提示 |

性能、可访问性和最佳实践是强制项：其中任意一项低于目标，运行显示为红色。SEO 仍然检查并显示 90 分目标，但因为本站选择不被搜索引擎收录，SEO 低于 90 分只显示提示，不会单独让工作流变红。采集、生成报告或上传报告发生错误时，运行仍会显示为红色。

本站通过 `public/robots.txt` 发布 `User-agent: *` 和 `Disallow: /`，并在页面中发布 `noindex` 等 robots meta 指令，请求搜索引擎不要抓取、收录、缓存或展示页面和图片。这些指令不是密码保护或访问控制；知道地址的任何人仍然可以访问公开页面。

当前站点仍使用 HTTP，最佳实践仍是强制项，因此 HTTPS 和 HTTP 到 HTTPS 跳转完成前，Lighthouse 运行可能继续显示为红色。不要为了隐藏该问题而降低最佳实践目标。
```

- [ ] **Step 4: Align the failure guidance with required versus advisory categories**

In the `检查质量阈值` bullet, replace the existing sentence beginning with `查看未通过的分类` with:

```md
查看 Summary 中的“未通过”强制项和“提示”项；SEO 提示不会单独导致失败，性能、可访问性或最佳实践未通过会导致失败。图片、视频或 JavaScript 可能降低移动端性能，页面结构可能影响可访问性，当前 HTTP 地址会降低最佳实践分数。
```

- [ ] **Step 5: Run GREEN and documentation checks**

```bash
pnpm exec vitest run scripts/lighthouse/docs.test.ts
pnpm exec eslint scripts/lighthouse/docs.test.ts
git diff --check
```

Expected: documentation test, ESLint, and diff check exit `0`.

- [ ] **Step 6: Commit Task 3**

```bash
git add docs/lighthouse.md scripts/lighthouse/docs.test.ts
git diff --cached --check
git commit -m "docs: explain private SEO advisory"
```

### Task 4: Run full regression and release-readiness checks

**Files:**

- Verify only; do not add production files unless a test exposes a defect within this plan's scope.

- [ ] **Step 1: Run all focused feature contracts**

```bash
pnpm exec vitest run scripts/seo-policy.test.ts scripts/lighthouse
```

Expected: all search-policy and Lighthouse configuration, summary, workflow, and documentation tests pass.

- [ ] **Step 2: Run repository quality checks**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:lighthouse
pnpm test:deploy
pnpm build
```

Run the local monitor integration separately because its loopback fixture may require the normal sandbox approval path:

```bash
pnpm test:monitor
```

Expected: every command exits `0`. The full Vitest count must be the baseline `90` plus the new SEO-policy and Lighthouse summary tests; record the actual final count instead of guessing it in the completion report.

- [ ] **Step 3: Verify the real build output independently**

```bash
cmp public/robots.txt dist/robots.txt
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
const window = new Window();
window.document.write(readFileSync("dist/index.html", "utf8"));
window.document.close();
const description = window.document.querySelector("meta[name=description]")?.content;
const robots = window.document.querySelector("meta[name=robots]")?.content;
if (description !== "记录宝宝成长瞬间的家庭纪念相册。") process.exit(1);
if (robots !== "noindex, nofollow, noarchive, nosnippet, noimageindex") process.exit(1);
'
```

Expected: both commands exit `0` without changing tracked files.

- [ ] **Step 4: Prove scope and repository cleanliness**

```bash
git diff --check bb51fd1..HEAD
git diff --name-only bb51fd1..HEAD
git status --short --branch
git log --oneline --decorate bb51fd1..HEAD
```

The changed-file list must be limited to:

```text
docs/lighthouse.md
docs/superpowers/plans/2026-08-24-search-indexing-privacy.md
index.html
lighthouserc.cjs
public/robots.txt
scripts/lighthouse/config.test.ts
scripts/lighthouse/docs.test.ts
scripts/lighthouse/summarize-reports.mjs
scripts/lighthouse/summarize-reports.test.ts
scripts/lighthouse/thresholds.cjs
scripts/seo-policy.test.ts
```

The implementation worktree must be clean after the plan commit and the three implementation commits.

- [ ] **Step 5: Review before integration**

Use `superpowers:requesting-code-review` for an independent specification and quality review. Resolve every confirmed Critical or Important issue with another RED/GREEN cycle and a separate commit. Rerun the full checks after review fixes.

- [ ] **Step 6: Integrate without publishing a Tag**

Use `superpowers:finishing-a-development-branch` to present integration choices. After the user chooses, integrate the reviewed commits into `main`, rerun the focused feature contracts on `main`, and push `main` only with user authorization. Do not create a Tag in the same step.

### Task 5: Guided production release and read-only verification

This is an operational handoff after reviewed code is on remote `main`; it is not part of the implementation commits.

- [ ] **Step 1: Determine the next unused Tag without guessing**

```bash
git fetch origin --tags
git tag --list 'v*' --sort=-v:refname | sed -n '1,10p'
git ls-remote --tags origin
```

Choose the next unused semantic version only after comparing local and remote tags. Confirm that the proposed Tag points to the reviewed remote `main` commit before pushing it.

- [ ] **Step 2: Publish through the existing deployment workflow**

Create and push the confirmed Tag using the same verified Tag procedure in `docs/deployment.md`. Wait for `发布生产环境` to finish successfully before verification. Do not replace server files manually.

- [ ] **Step 3: Verify deployed directives with read-only requests**

Set `PRODUCTION_URL` to the existing production URL without a trailing slash, then run:

```bash
curl --fail --silent --show-error "$PRODUCTION_URL/robots.txt"
curl --fail --silent --show-error "$PRODUCTION_URL/" |
  sed -n '/name="description"/p;/name="robots"/p'
```

Expected `robots.txt` body:

```text
User-agent: *
Disallow: /
```

The HTML response must contain the exact description and robots meta values from Task 1. These requests are read-only and do not connect over SSH.

- [ ] **Step 4: Rerun the hosted Lighthouse audit**

On remote `main`, manually run `生产站点 Lighthouse 检查`. Verify:

- SEO remains present in the Summary with target `90`;
- a below-target SEO value appears as `提示` and does not by itself fail assertions;
- Best Practices remains `未通过` while HTTP keeps it below `90`;
- the run can remain red because Best Practices is still a required category;
- the HTML/JSON Artifact still uploads.

Record the observed four medians. Do not lower the Best Practices threshold. Proceed to the separate HTTPS design only after this release is verified.
