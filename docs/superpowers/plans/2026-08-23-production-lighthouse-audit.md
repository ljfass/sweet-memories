# Production Lighthouse Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a daily and manually runnable mobile Lighthouse audit for the public production URL, with median category thresholds, readable summaries, 14-day reports, and failure-only GitHub email notifications without affecting deployment.

**Architecture:** A standalone GitHub Actions workflow reads the existing `MONITOR_URL`, runs the pinned official Lighthouse CI CLI three times, summarizes the median scores, asserts the approved thresholds, and always attempts to upload local HTML/JSON reports. Pure report parsing, Lighthouse configuration, workflow orchestration, and beginner documentation stay in separate files with parser-based and fixture-based tests.

**Tech Stack:** GitHub Actions, Node.js 24, pnpm 8.6.1, `@lhci/cli` 0.15.1, Lighthouse CI configuration, Vitest, YAML parser, official `actions/upload-artifact` v7.0.1.

---

## File Map

- Create: `scripts/lighthouse/thresholds.cjs`
  - Single source of truth for category IDs, Chinese labels, and minimum scores.
- Create: `scripts/lighthouse/summarize-reports.mjs`
  - Load three LHR JSON files, validate scores, calculate medians, and print a Markdown summary.
- Create: `scripts/lighthouse/summarize-reports.test.ts`
  - Fixture-based unit and file-loading tests for the report summarizer.
- Create: `lighthouserc.cjs`
  - Configure the production URL, three mobile runs, four categories, and median assertions.
- Create: `scripts/lighthouse/config.test.ts`
  - Structurally validate Lighthouse CI configuration and fail-closed URL handling.
- Create: `.github/workflows/lighthouse.yml`
  - Schedule, run, summarize, assert, and upload Lighthouse reports independently of deployment.
- Create: `scripts/lighthouse/workflow.test.ts`
  - Parse and lock down workflow triggers, permissions, actions, timeouts, commands, and Artifact behavior.
- Create: `docs/lighthouse.md`
  - Chinese beginner guide for manual runs, scores, reports, failures, and email behavior.
- Create: `scripts/lighthouse/docs.test.ts`
  - Keep the operational guide aligned with the executable workflow.
- Modify: `package.json`
  - Add `test:lighthouse` and the exact `@lhci/cli` development dependency.
- Modify: `pnpm-lock.yaml`
  - Lock `@lhci/cli` and its transitive dependencies.
- Modify: `.gitignore`
  - Ignore local `.lighthouseci/` report output.
- Modify: `eslint.config.js`
  - Apply the existing Node.js globals to the new CommonJS and TypeScript tooling files.

The implementation must not modify:

- `.github/workflows/deploy.yml`;
- `.github/workflows/monitor.yml`;
- `scripts/deploy/*`;
- `scripts/monitor/*`;
- GitHub Secrets, the `production` Environment, Nginx, or server files.

## Starting State

- Base commit: `59d4579` (`docs: design production Lighthouse audit`).
- Worktree: `.worktrees/production-lighthouse-audit`.
- Branch: `feat/production-lighthouse-audit`.
- Offline frozen dependency installation succeeds from the existing pnpm store.
- Baseline `pnpm test` passes `17` files and `71` tests.
- Current official versions verified on 2026-08-23:
  - `@lhci/cli` `0.15.1` from npm;
  - `actions/upload-artifact` `v7.0.1` at commit `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`.

### Task 1: Build the Report Summarizer

**Files:**
- Create: `scripts/lighthouse/thresholds.cjs`
- Create: `scripts/lighthouse/summarize-reports.mjs`
- Create: `scripts/lighthouse/summarize-reports.test.ts`
- Modify: `package.json`
- Modify: `eslint.config.js`

- [ ] **Step 1: Write the failing report summarizer tests**

Create `scripts/lighthouse/summarize-reports.test.ts`:

```ts
// @vitest-environment node

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadReports,
  summarizeReports,
} from './summarize-reports.mjs'

interface Scores {
  accessibility: number
  'best-practices': number
  performance: number
  seo: number
}

const temporaryDirectories: string[] = []

function makeLhr(overrides: Partial<Scores> = {}) {
  const scores: Scores = {
    accessibility: 0.91,
    'best-practices': 0.92,
    performance: 0.72,
    seo: 0.96,
    ...overrides,
  }

  return {
    categories: Object.fromEntries(
      Object.entries(scores).map(([id, score]) => [id, { score }]),
    ),
  }
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sweet-memories-lhci-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('Lighthouse report summary', () => {
  it('prints the median score and approved threshold for every category', () => {
    const markdown = summarizeReports([
      makeLhr({
        accessibility: 0.88,
        'best-practices': 0.89,
        performance: 0.65,
        seo: 0.94,
      }),
      makeLhr({
        accessibility: 0.95,
        'best-practices': 0.93,
        performance: 0.8,
        seo: 0.98,
      }),
      makeLhr(),
    ])

    expect(markdown).toContain('## Lighthouse 移动端质量检查')
    expect(markdown).toContain('| 性能 | 70 | 72 | 通过 |')
    expect(markdown).toContain('| 可访问性 | 90 | 91 | 通过 |')
    expect(markdown).toContain('| 最佳实践 | 90 | 92 | 通过 |')
    expect(markdown).toContain('| SEO | 90 | 96 | 通过 |')
  })

  it('treats a score exactly on its threshold as passing', () => {
    const markdown = summarizeReports([
      makeLhr({ performance: 0.7 }),
      makeLhr({ performance: 0.7 }),
      makeLhr({ performance: 0.7 }),
    ])

    expect(markdown).toContain('| 性能 | 70 | 70 | 通过 |')
    expect(markdown).not.toContain('未通过')
  })

  it('requires exactly three reports', () => {
    expect(() => summarizeReports([makeLhr(), makeLhr()])).toThrow(
      '需要恰好 3 份 Lighthouse LHR 报告，实际为 2 份。',
    )
  })

  it('rejects missing or invalid category scores', () => {
    const missingPerformance = makeLhr()
    delete missingPerformance.categories.performance

    expect(() =>
      summarizeReports([missingPerformance, makeLhr(), makeLhr()]),
    ).toThrow('第 1 份报告的 performance 分数无效。')
    expect(() =>
      summarizeReports([
        makeLhr({ performance: Number.NaN }),
        makeLhr(),
        makeLhr(),
      ]),
    ).toThrow('第 1 份报告的 performance 分数无效。')
  })

  it('loads only LHR JSON files and ignores Lighthouse metadata', async () => {
    const directory = await makeTemporaryDirectory()
    await Promise.all([
      writeFile(join(directory, 'lhr-0.json'), JSON.stringify(makeLhr())),
      writeFile(join(directory, 'lhr-1.json'), JSON.stringify(makeLhr())),
      writeFile(join(directory, 'lhr-2.json'), JSON.stringify(makeLhr())),
      writeFile(join(directory, 'manifest.json'), 'metadata is not an LHR'),
    ])

    await expect(loadReports(directory)).resolves.toHaveLength(3)
  })

  it('names a malformed LHR file in the failure message', async () => {
    const directory = await makeTemporaryDirectory()
    await Promise.all([
      writeFile(join(directory, 'lhr-0.json'), JSON.stringify(makeLhr())),
      writeFile(join(directory, 'lhr-1.json'), JSON.stringify(makeLhr())),
      writeFile(join(directory, 'lhr-2.json'), '{'),
    ])

    await expect(loadReports(directory)).rejects.toThrow(
      'LHR 报告无法解析：lhr-2.json',
    )
  })
})
```

Add the focused command to `package.json` immediately after `test:monitor`:

```json
"test:lighthouse": "vitest run scripts/lighthouse",
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm test:lighthouse
```

Expected: exit `1`; Vitest cannot resolve `./summarize-reports.mjs`. The failure must be caused by the missing production module, not a syntax error in the test.

- [ ] **Step 3: Add the shared thresholds and minimal summarizer**

Create `scripts/lighthouse/thresholds.cjs`:

```js
'use strict'

module.exports = Object.freeze([
  Object.freeze({ id: 'performance', label: '性能', minScore: 0.7 }),
  Object.freeze({ id: 'accessibility', label: '可访问性', minScore: 0.9 }),
  Object.freeze({ id: 'best-practices', label: '最佳实践', minScore: 0.9 }),
  Object.freeze({ id: 'seo', label: 'SEO', minScore: 0.9 }),
])
```

Create `scripts/lighthouse/summarize-reports.mjs`:

```js
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import categoryThresholds from './thresholds.cjs'

const REPORT_COUNT = 3

function scoreFor(report, categoryId, reportIndex) {
  const score = report?.categories?.[categoryId]?.score
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error(
      `第 ${reportIndex + 1} 份报告的 ${categoryId} 分数无效。`,
    )
  }
  return score
}

function percentage(score) {
  return Math.round(score * 100)
}

export function summarizeReports(reports) {
  if (!Array.isArray(reports) || reports.length !== REPORT_COUNT) {
    throw new Error(
      `需要恰好 ${REPORT_COUNT} 份 Lighthouse LHR 报告，实际为 ${reports.length} 份。`,
    )
  }

  const rows = categoryThresholds.map(({ id, label, minScore }) => {
    const values = reports
      .map((report, index) => scoreFor(report, id, index))
      .sort((left, right) => left - right)
    const median = values[1]
    const status = median >= minScore ? '通过' : '未通过'
    return `| ${label} | ${percentage(minScore)} | ${percentage(median)} | ${status} |`
  })

  return [
    '## Lighthouse 移动端质量检查',
    '',
    '| 分类 | 最低分 | 三次中位数 | 结果 |',
    '| --- | ---: | ---: | --- |',
    ...rows,
    '',
  ].join('\n')
}

export async function loadReports(reportDirectory) {
  const entries = await readdir(reportDirectory, { withFileTypes: true })
  const fileNames = entries
    .filter(
      (entry) => entry.isFile() && /^lhr-.*\.json$/.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort()

  return Promise.all(
    fileNames.map(async (fileName) => {
      try {
        return JSON.parse(
          await readFile(resolve(reportDirectory, fileName), 'utf8'),
        )
      } catch (error) {
        throw new Error(`LHR 报告无法解析：${fileName}`, { cause: error })
      }
    }),
  )
}

async function main() {
  const reportDirectory = process.argv[2] ?? '.lighthouseci'
  const reports = await loadReports(reportDirectory)
  process.stdout.write(summarizeReports(reports))
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Lighthouse 摘要失败：${message}`)
    process.exitCode = 1
  })
}
```

- [ ] **Step 4: Run focused tests and lint for GREEN**

In `eslint.config.js`, replace the existing Node.js file glob:

```js
  {
    files: ['scripts/**/*.{cjs,mjs,ts}', '*.{cjs,js,ts}'],
    languageOptions: { globals: globals.node },
  },
```

This keeps the existing Node.js rule scope while adding the new `.cjs` files and
the TypeScript contract tests under `scripts/`.

Run:

```bash
pnpm test:lighthouse
pnpm eslint scripts/lighthouse --max-warnings=0
node --check scripts/lighthouse/summarize-reports.mjs
node --check scripts/lighthouse/thresholds.cjs
```

Expected: all commands exit `0`; Vitest reports `1` file and `6` tests passed.

- [ ] **Step 5: Commit the report summarizer**

```bash
git add package.json scripts/lighthouse/thresholds.cjs \
  scripts/lighthouse/summarize-reports.mjs \
  scripts/lighthouse/summarize-reports.test.ts eslint.config.js
git diff --cached --check
git commit -m "feat: summarize Lighthouse audit reports"
```

Expected: the commit contains exactly the five listed files.

### Task 2: Add the Pinned Lighthouse CI Configuration

**Files:**
- Create: `lighthouserc.cjs`
- Create: `scripts/lighthouse/config.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.gitignore`

- [ ] **Step 1: Write the failing configuration contract**

Create `scripts/lighthouse/config.test.ts`:

```ts
// @vitest-environment node

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const configPath = fileURLToPath(
  new URL('../../lighthouserc.cjs', import.meta.url),
)
const originalMonitorUrl = process.env.MONITOR_URL

function loadConfig(url?: string) {
  if (url === undefined) {
    delete process.env.MONITOR_URL
  } else {
    process.env.MONITOR_URL = url
  }
  const resolvedPath = require.resolve(configPath)
  delete require.cache[resolvedPath]
  return require(resolvedPath)
}

afterEach(() => {
  if (originalMonitorUrl === undefined) {
    delete process.env.MONITOR_URL
  } else {
    process.env.MONITOR_URL = originalMonitorUrl
  }
})

describe('Lighthouse CI configuration', () => {
  it('collects the production URL three times with mobile categories only', () => {
    const config = loadConfig('http://8.163.27.231')

    expect(config.ci.collect).toEqual({
      url: ['http://8.163.27.231'],
      numberOfRuns: 3,
      settings: {
        chromeFlags: '--headless --no-sandbox',
        onlyCategories: [
          'performance',
          'accessibility',
          'best-practices',
          'seo',
        ],
      },
    })
  })

  it('uses exact error thresholds with median aggregation and no upload target', () => {
    const config = loadConfig('http://8.163.27.231')

    expect(config.ci.assert.assertions).toEqual({
      'categories:performance': [
        'error',
        { aggregationMethod: 'median', minScore: 0.7 },
      ],
      'categories:accessibility': [
        'error',
        { aggregationMethod: 'median', minScore: 0.9 },
      ],
      'categories:best-practices': [
        'error',
        { aggregationMethod: 'median', minScore: 0.9 },
      ],
      'categories:seo': [
        'error',
        { aggregationMethod: 'median', minScore: 0.9 },
      ],
    })
    expect(config.ci).not.toHaveProperty('upload')
  })

  it('fails closed when MONITOR_URL is missing', () => {
    expect(() => loadConfig()).toThrow('缺少 MONITOR_URL。')
  })
})
```

- [ ] **Step 2: Run the configuration test and verify RED**

Run:

```bash
pnpm test:lighthouse
```

Expected: exit `1`; the existing `6` summarizer tests pass and all `3` configuration tests fail because `lighthouserc.cjs` does not exist.

- [ ] **Step 3: Add the minimal Lighthouse CI configuration**

Create `lighthouserc.cjs`:

```js
'use strict'

const categoryThresholds = require('./scripts/lighthouse/thresholds.cjs')

const targetUrl = process.env.MONITOR_URL
if (typeof targetUrl !== 'string' || targetUrl.trim() === '') {
  throw new Error('缺少 MONITOR_URL。')
}

module.exports = {
  ci: {
    collect: {
      url: [targetUrl],
      numberOfRuns: 3,
      settings: {
        chromeFlags: '--headless --no-sandbox',
        onlyCategories: categoryThresholds.map(({ id }) => id),
      },
    },
    assert: {
      assertions: Object.fromEntries(
        categoryThresholds.map(({ id, minScore }) => [
          `categories:${id}`,
          ['error', { aggregationMethod: 'median', minScore }],
        ]),
      ),
    },
  },
}
```

- [ ] **Step 4: Lock the official CLI and ignore generated reports**

Run:

```bash
pnpm add -D -E @lhci/cli@0.15.1
```

Expected: `package.json` contains `"@lhci/cli": "0.15.1"`; `pnpm-lock.yaml` changes and the command exits `0`. If the managed sandbox blocks npm registry access, rerun this exact command through the normal approval mechanism; do not use an unpinned version.

Add `.lighthouseci/` between `coverage/` and `*.local` in `.gitignore`:

```gitignore
.DS_Store
.worktrees/
node_modules/
dist/
coverage/
.lighthouseci/
*.local
```

- [ ] **Step 5: Verify configuration GREEN and CLI availability**

Run:

```bash
pnpm test:lighthouse
pnpm exec lhci --version
MONITOR_URL=http://8.163.27.231 node -e \
  'const config=require("./lighthouserc.cjs"); console.log(JSON.stringify(config.ci.collect))'
node --check lighthouserc.cjs
git diff --check
```

Expected:

- focused Vitest passes `2` files and `9` tests;
- `pnpm exec lhci --version` prints `0.15.1`;
- the JSON output contains the production URL, `numberOfRuns: 3`, and the four categories;
- syntax and diff checks exit `0`.

- [ ] **Step 6: Commit the pinned Lighthouse configuration**

```bash
git add .gitignore lighthouserc.cjs scripts/lighthouse/config.test.ts \
  package.json pnpm-lock.yaml
git diff --cached --check
git commit -m "feat: configure production Lighthouse thresholds"
```

Expected: the commit contains exactly the five listed paths.

### Task 3: Add the Independent Lighthouse Workflow

**Files:**
- Create: `.github/workflows/lighthouse.yml`
- Create: `scripts/lighthouse/workflow.test.ts`

- [ ] **Step 1: Write the failing parser-based workflow contract**

Create `scripts/lighthouse/workflow.test.ts`:

```ts
// @vitest-environment node

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface WorkflowStep {
  id: string
  if?: string
  name: string
  run?: string
  shell?: string
  'timeout-minutes': number
  uses?: string
  with?: Record<string, boolean | number | string>
}

interface LighthouseJob {
  env: Record<string, string>
  environment?: unknown
  name: string
  'runs-on': string
  steps: WorkflowStep[]
  'timeout-minutes': number
}

interface LighthouseWorkflow {
  concurrency: {
    'cancel-in-progress': boolean
    group: string
  }
  jobs: {
    lighthouse: LighthouseJob
  }
  name: string
  on: {
    schedule: Array<{ cron: string }>
    workflow_dispatch: null
  }
  permissions: Record<string, string>
}

const workflowPath = fileURLToPath(
  new URL('../../.github/workflows/lighthouse.yml', import.meta.url),
)

function loadWorkflow(): LighthouseWorkflow {
  expect(existsSync(workflowPath), 'Lighthouse workflow must exist').toBe(
    true,
  )
  return parse(readFileSync(workflowPath, 'utf8')) as LighthouseWorkflow
}

function stepById(steps: WorkflowStep[], id: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.id === id)
  expect(step, `workflow step "${id}" must exist`).toBeDefined()
  return step as WorkflowStep
}

describe('production Lighthouse workflow', () => {
  it('runs daily and manually with least-privilege access', () => {
    const workflow = loadWorkflow()

    expect(workflow.name).toBe('生产站点 Lighthouse 检查')
    expect(workflow.on).toEqual({
      schedule: [{ cron: '23 18 * * *' }],
      workflow_dispatch: null,
    })
    expect(workflow.permissions).toEqual({ contents: 'read' })
  })

  it('runs independently without secrets or deployment state', () => {
    const workflow = loadWorkflow()
    const job = workflow.jobs.lighthouse
    const serialized = JSON.stringify(workflow)

    expect(workflow.concurrency).toEqual({
      group: 'sweet-memories-production-lighthouse',
      'cancel-in-progress': false,
    })
    expect(Object.keys(workflow.jobs)).toEqual(['lighthouse'])
    expect(job.name).toBe('检查移动端性能与页面质量')
    expect(job['runs-on']).toBe('ubuntu-latest')
    expect(job.env).toEqual({ MONITOR_URL: '${{ vars.MONITOR_URL }}' })
    expect(job).not.toHaveProperty('environment')
    expect(serialized).not.toContain('secrets.')
    expect(serialized).not.toContain('ALIYUN_')
    expect(serialized).not.toMatch(/\b(?:ssh|scp|rsync)\b/i)
    expect(serialized).not.toContain('scripts/deploy/')
    expect(serialized).not.toContain('temporary-public-storage')
  })

  it('pins every official action to the reviewed immutable commit', () => {
    const actionRefs = loadWorkflow()
      .jobs.lighthouse.steps.map((step) => step.uses)
      .filter((uses): uses is string => uses !== undefined)

    expect(actionRefs).toEqual([
      'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd',
      'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    ])
    for (const actionRef of actionRefs) {
      expect(actionRef).toMatch(/^[^@]+@[0-9a-f]{40}$/)
    }
  })

  it('runs exactly nine bounded steps with recovery headroom', () => {
    const job = loadWorkflow().jobs.lighthouse
    const expectedBudgets = new Map([
      ['checkout', 2],
      ['validate-config', 1],
      ['setup-node', 3],
      ['install-pnpm', 3],
      ['install-dependencies', 5],
      ['collect', 15],
      ['summarize', 2],
      ['assert', 2],
      ['upload-report', 5],
    ])
    const totalBudget = job.steps.reduce(
      (total, step) => total + step['timeout-minutes'],
      0,
    )

    expect(job.steps.map((step) => step.id)).toEqual([
      ...expectedBudgets.keys(),
    ])
    expect(job.steps).toHaveLength(expectedBudgets.size)
    expect(job.steps.every((step) => step.name.trim().length > 0)).toBe(true)
    for (const [id, budget] of expectedBudgets) {
      expect(stepById(job.steps, id)['timeout-minutes']).toBe(budget)
    }
    expect(job['timeout-minutes']).toBe(45)
    expect(job['timeout-minutes']).toBeGreaterThan(totalBudget)
  })

  it('installs exact project tooling before collection', () => {
    const steps = loadWorkflow().jobs.lighthouse.steps
    const setupNode = stepById(steps, 'setup-node')
    const installPnpm = stepById(steps, 'install-pnpm')
    const installDependencies = stepById(steps, 'install-dependencies')

    expect(setupNode.with).toEqual({ 'node-version': '24' })
    expect(installPnpm.run?.trim().split('\n')).toEqual([
      'set -euo pipefail',
      'npm install --global pnpm@8.6.1',
      `test "$(pnpm --version)" = '8.6.1'`,
    ])
    expect(installDependencies.run?.trim().split('\n')).toEqual([
      'set -euo pipefail',
      'pnpm install --frozen-lockfile',
    ])
  })

  it('validates, collects, summarizes, and asserts in exact order', () => {
    const steps = loadWorkflow().jobs.lighthouse.steps
    const validate = stepById(steps, 'validate-config')
    const collect = stepById(steps, 'collect')
    const summarize = stepById(steps, 'summarize')
    const assertion = stepById(steps, 'assert')

    expect(validate.run?.trim().split('\n')).toEqual([
      'set -euo pipefail',
      ': "${MONITOR_URL:?缺少仓库变量 MONITOR_URL}"',
      'python3 scripts/monitor/extract-assets.py --validate-url "$MONITOR_URL"',
    ])
    expect(collect.run?.trim().split('\n')).toEqual([
      'set -euo pipefail',
      'pnpm exec lhci collect --config=./lighthouserc.cjs',
    ])
    expect(summarize.if).toBe("${{ steps.collect.outcome == 'success' }}")
    expect(summarize.run?.trim().split('\n')).toEqual([
      'set -euo pipefail',
      'node scripts/lighthouse/summarize-reports.mjs .lighthouseci >> "$GITHUB_STEP_SUMMARY"',
    ])
    expect(assertion.if).toBe(
      "${{ steps.summarize.outcome == 'success' }}",
    )
    expect(assertion.run?.trim().split('\n')).toEqual([
      'set -euo pipefail',
      'pnpm exec lhci assert --config=./lighthouserc.cjs',
    ])
  })

  it('always uploads private local reports after attempted collection', () => {
    const upload = stepById(
      loadWorkflow().jobs.lighthouse.steps,
      'upload-report',
    )

    expect(upload.if).toBe(
      "${{ always() && steps.collect.outcome != 'skipped' }}",
    )
    expect(upload.with).toEqual({
      name: 'lighthouse-production-${{ github.run_id }}',
      path: '.lighthouseci/*.html\n.lighthouseci/*.json\n',
      'if-no-files-found': 'error',
      'retention-days': 14,
      'include-hidden-files': true,
    })
  })
})
```

- [ ] **Step 2: Run the workflow contract and verify RED**

Run:

```bash
pnpm vitest run scripts/lighthouse/workflow.test.ts
```

Expected: exit `1`; all `7` tests fail because `.github/workflows/lighthouse.yml` is missing.

- [ ] **Step 3: Add the minimal independent workflow**

Create `.github/workflows/lighthouse.yml`:

```yaml
name: 生产站点 Lighthouse 检查

on:
  schedule:
    - cron: '23 18 * * *'
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: sweet-memories-production-lighthouse
  cancel-in-progress: false

jobs:
  lighthouse:
    name: 检查移动端性能与页面质量
    runs-on: ubuntu-latest
    timeout-minutes: 45
    env:
      MONITOR_URL: ${{ vars.MONITOR_URL }}
    steps:
      - name: 检出检查代码
        id: checkout
        timeout-minutes: 2
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2

      - name: 校验生产地址
        id: validate-config
        timeout-minutes: 1
        shell: bash
        run: |
          set -euo pipefail
          : "${MONITOR_URL:?缺少仓库变量 MONITOR_URL}"
          python3 scripts/monitor/extract-assets.py --validate-url "$MONITOR_URL"

      - name: 安装 Node.js
        id: setup-node
        timeout-minutes: 3
        uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0
        with:
          node-version: '24'

      - name: 安装项目指定的 pnpm
        id: install-pnpm
        timeout-minutes: 3
        shell: bash
        run: |
          set -euo pipefail
          npm install --global pnpm@8.6.1
          test "$(pnpm --version)" = '8.6.1'

      - name: 安装锁定依赖
        id: install-dependencies
        timeout-minutes: 5
        shell: bash
        run: |
          set -euo pipefail
          pnpm install --frozen-lockfile

      - name: 采集三次移动端报告
        id: collect
        timeout-minutes: 15
        shell: bash
        run: |
          set -euo pipefail
          pnpm exec lhci collect --config=./lighthouserc.cjs

      - name: 生成分数摘要
        id: summarize
        if: ${{ steps.collect.outcome == 'success' }}
        timeout-minutes: 2
        shell: bash
        run: |
          set -euo pipefail
          node scripts/lighthouse/summarize-reports.mjs .lighthouseci >> "$GITHUB_STEP_SUMMARY"

      - name: 检查质量阈值
        id: assert
        if: ${{ steps.summarize.outcome == 'success' }}
        timeout-minutes: 2
        shell: bash
        run: |
          set -euo pipefail
          pnpm exec lhci assert --config=./lighthouserc.cjs

      - name: 上传 Lighthouse 报告
        id: upload-report
        if: ${{ always() && steps.collect.outcome != 'skipped' }}
        timeout-minutes: 5
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: lighthouse-production-${{ github.run_id }}
          path: |
            .lighthouseci/*.html
            .lighthouseci/*.json
          if-no-files-found: error
          retention-days: 14
          include-hidden-files: true
```

- [ ] **Step 4: Run workflow GREEN and shell syntax checks**

Run:

```bash
pnpm vitest run scripts/lighthouse/workflow.test.ts
pnpm test:lighthouse
pnpm eslint scripts/lighthouse --max-warnings=0

node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/lighthouse.yml', 'utf8'))
for (const step of workflow.jobs.lighthouse.steps) {
  if (typeof step.run !== 'string') continue
  const result = spawnSync('bash', ['-n'], {
    encoding: 'utf8',
    input: step.run,
  })
  if (result.status !== 0) {
    process.stderr.write(`bash -n failed for ${step.id}:\n${result.stderr}`)
    process.exit(1)
  }
}
NODE
```

Expected:

- focused workflow test passes `1` file and `7` tests;
- all Lighthouse tests pass `3` files and `16` tests;
- ESLint and every extracted Bash block exit `0`.

- [ ] **Step 5: Commit the independent workflow**

```bash
git add .github/workflows/lighthouse.yml \
  scripts/lighthouse/workflow.test.ts
git diff --cached --check
git commit -m "ci: audit production Lighthouse scores daily"
```

Expected: the commit contains exactly the workflow and its parser-based contract test.

### Task 4: Add the Beginner Operations Guide

**Files:**
- Create: `docs/lighthouse.md`
- Create: `scripts/lighthouse/docs.test.ts`

- [ ] **Step 1: Write the failing documentation contract**

Create `scripts/lighthouse/docs.test.ts`:

```ts
// @vitest-environment node

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const guidePath = fileURLToPath(
  new URL('../../docs/lighthouse.md', import.meta.url),
)

describe('Lighthouse operations guide', () => {
  it('documents the real workflow, schedule, thresholds, and reports', () => {
    expect(existsSync(guidePath), 'Lighthouse guide must exist').toBe(true)
    const guide = readFileSync(guidePath, 'utf8')
    const required = [
      '# 生产站点 Lighthouse 自动检查',
      '生产站点 Lighthouse 检查',
      '检查移动端性能与页面质量',
      '北京时间约 02:23',
      '每次连续检查 3 次',
      '| 性能 | 70 |',
      '| 可访问性 | 90 |',
      '| 最佳实践 | 90 |',
      '| SEO | 90 |',
      'lighthouse-production-',
      'HTML 和 JSON',
      '14 天',
      'Only notify for failed workflows',
      'pnpm test:lighthouse',
    ]

    for (const text of required) {
      expect(guide, `guide must contain: ${text}`).toContain(text)
    }
  })

  it('keeps troubleshooting read-only and deployment-independent', () => {
    const guide = readFileSync(guidePath, 'utf8')

    expect(guide).toContain('不会阻止发布')
    expect(guide).toContain('不要修改 `MONITOR_URL`')
    expect(guide).toContain('不要停止 Nginx')
    expect(guide).not.toMatch(/\b(?:ssh|scp|rsync)\b/i)
    expect(guide).not.toContain('ALIYUN_SSH_PRIVATE_KEY')
    expect(guide).not.toContain('temporary-public-storage')
    expect(guide).not.toContain('chmod 777')
    expect(guide).not.toContain('rm -rf')
  })
})
```

- [ ] **Step 2: Run the documentation test and verify RED**

Run:

```bash
pnpm vitest run scripts/lighthouse/docs.test.ts
```

Expected: exit `1`; both tests fail because `docs/lighthouse.md` is missing.

- [ ] **Step 3: Write the complete Chinese guide**

Create `docs/lighthouse.md`:

````markdown
# 生产站点 Lighthouse 自动检查

GitHub Actions 每天对公开生产站点进行一次移动端 Lighthouse 检查，也支持随时手动运行。它只读取网页，不连接或修改服务器，也不会阻止发布。

## 自动执行时间

workflow 名称是 `生产站点 Lighthouse 检查`，作业名称是 `检查移动端性能与页面质量`。定时任务每天北京时间约 02:23 触发；GitHub Actions 的定时运行可能延迟，并不是严格的实时任务。

检查地址复用仓库 Variable `MONITOR_URL`。不要为 Lighthouse 新建 Secret，也不要修改该变量来制造失败。

## 第一次手动运行

只有 Lighthouse 代码进入远程 `main` 后才执行：

1. 打开仓库 `Actions`。
2. 左侧选择 `生产站点 Lighthouse 检查`。
3. 点击 `Run workflow`。
4. 分支选择 `main`。
5. 再点击绿色的 `Run workflow`。
6. 等待作业 `检查移动端性能与页面质量` 完成。

检查每次连续检查 3 次，并使用三次分数的中位数，减少一次网络波动造成的误报。

## 分数要求

| 分类 | 最低分 |
| --- | ---: |
| 性能 | 70 |
| 可访问性 | 90 |
| 最佳实践 | 90 |
| SEO | 90 |

四项全部达到最低分时 workflow 为绿色；任意一项低于最低分，或检查过程、报告上传发生错误时，workflow 为红色。

## 查看分数和报告

1. 打开本次 workflow run。
2. 在 `Summary` 中查看四项三次中位数和通过状态。
3. 在运行页面下方找到 `Artifacts`。
4. 下载名称以 `lighthouse-production-` 开头的 Artifact。
5. 解压后使用浏览器打开 HTML 报告；JSON 是相同检查的原始数据。

HTML 和 JSON 报告保留 14 天，过期后 GitHub 会自动删除。报告只保存在 GitHub Artifact 中，不上传到公共 Lighthouse 临时存储。

## 检查失败怎么办

先打开 Actions Summary，确认是哪个分类未达标，再下载 HTML 报告查看具体审计项。

常见原因包括：

- 生产页面或资源暂时无法访问；
- 图片、视频或 JavaScript 影响移动端性能；
- 页面存在可访问性、SEO 或最佳实践问题；
- 当前生产地址使用 HTTP，最佳实践可能因缺少 HTTPS 扣分；
- Chrome、依赖安装或 Artifact 上传出现临时错误。

Lighthouse 红色不会阻止发布，也不会自动重启、回滚或修改生产站点。不要为了让检查变绿而降低阈值、关闭审计、修改 `MONITOR_URL`、停止 Nginx 或破坏生产环境。

## 失败邮件

现有 GitHub 个人设置 `Only notify for failed workflows` 同样适用于这个 workflow。手动运行的通知属于触发该运行的用户；定时运行按照 GitHub 的 scheduled workflow 接收人规则发送。邮件可能延迟，最终状态始终以 Actions 页面为准。

## 本地验证

在仓库根目录运行：

```bash
pnpm test:lighthouse
```

该命令只运行配置、摘要、workflow 和文档契约测试，不访问生产站点，也不生成真实 Lighthouse 报告。真实检查在远程 `main` 的 GitHub Actions 中完成。
````

- [ ] **Step 4: Run documentation and focused tests for GREEN**

Run:

```bash
pnpm vitest run scripts/lighthouse/docs.test.ts
pnpm test:lighthouse
pnpm eslint scripts/lighthouse --max-warnings=0
git diff --check
```

Expected:

- documentation test passes `1` file and `2` tests;
- focused suite passes `4` files and `18` tests;
- ESLint and diff checks exit `0`.

- [ ] **Step 5: Commit the operations guide**

```bash
git add docs/lighthouse.md scripts/lighthouse/docs.test.ts
git diff --cached --check
git commit -m "docs: add production Lighthouse guide"
```

Expected: the commit contains exactly the guide and its contract test.

### Task 5: Run Full Verification and Prepare Operational Handoff

**Files:**
- Verify only; no implementation changes unless a test-first review fix is required.

- [ ] **Step 1: Run the focused Lighthouse suite and static checks**

Run:

```bash
pnpm test:lighthouse
pnpm eslint scripts/lighthouse --max-warnings=0
node --check lighthouserc.cjs
node --check scripts/lighthouse/thresholds.cjs
node --check scripts/lighthouse/summarize-reports.mjs
MONITOR_URL=http://8.163.27.231 pnpm exec lhci healthcheck --fatal \
  --config=./lighthouserc.cjs
```

Expected:

- focused Vitest passes `4` files and `18` tests;
- syntax and focused lint exit `0`;
- Lighthouse CI healthcheck finds the configuration, writable report directory, and Chrome, and exits `0` without auditing production.

- [ ] **Step 2: Validate every workflow Bash block**

Run:

```bash
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/lighthouse.yml', 'utf8'))
for (const step of workflow.jobs.lighthouse.steps) {
  if (typeof step.run !== 'string') continue
  const result = spawnSync('bash', ['-n'], {
    encoding: 'utf8',
    input: step.run,
  })
  if (result.status !== 0) {
    process.stderr.write(`bash -n failed for ${step.id}:\n${result.stderr}`)
    process.exit(1)
  }
}
console.log('Lighthouse workflow Bash syntax passed')
NODE
```

Expected: prints `Lighthouse workflow Bash syntax passed` and exits `0`.

- [ ] **Step 3: Run the full existing quality suite**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:monitor
pnpm test:deploy
pnpm build
```

Expected:

- ESLint exits `0` with zero warnings;
- type checking exits `0`;
- Vitest passes `21` files and `89` tests;
- monitoring parser reports `11` tests and Shell integration ends with `check-site.sh: all tests passed`;
- deployment integration ends with `manage-release.sh: all tests passed`;
- Vite builds `1882` modules and exits `0`.

The monitor integration binds only a temporary `127.0.0.1` port. If the managed sandbox blocks it, rerun the exact `pnpm test:monitor` command through the normal approval mechanism; never skip the test.

- [ ] **Step 4: Prove scope, safety, and lockfile integrity**

Run:

```bash
set -euo pipefail

pnpm install --frozen-lockfile --offline \
  --store-dir /Users/lijianfengdemacbookpro2/Library/pnpm/store/v3

git diff --check 59d4579..HEAD

test -z "$(git diff --name-only 59d4579..HEAD -- \
  .github/workflows/deploy.yml \
  .github/workflows/monitor.yml \
  scripts/deploy \
  scripts/monitor)"

if rg -n 'secrets\.|ALIYUN_|\b(?:ssh|scp|rsync)\b|temporary-public-storage' \
  .github/workflows/lighthouse.yml; then
  echo 'Lighthouse workflow crossed its safety boundary' >&2
  exit 1
fi

git status --short --branch
```

Expected:

- frozen offline install exits `0` without lockfile changes;
- diff and scope checks exit `0`;
- safety scan prints no matches;
- worktree is clean.

- [ ] **Step 5: Perform final independent review**

Review `59d4579..HEAD` against the design, with findings ordered Critical, Important, then Minor. Confirm:

- mobile-only, three-run median behavior;
- `0.70 / 0.90 / 0.90 / 0.90` category thresholds;
- correct URL validation and missing-report failure behavior;
- report upload after assertion failure, 14-day retention, and hidden-directory inclusion;
- no deployment coupling, Secret, remote access, or public Lighthouse upload;
- accurate beginner documentation;
- complete TDD evidence and clean commit scope.

Any review fix must begin with a focused failing test, be implemented minimally, rerun the full relevant suite, and be committed separately rather than amending reviewed commits.

## Operational Handoff After Merge

These steps happen only after the feature branch is reviewed, merged to `main`, and pushed. No release Tag is needed because this feature changes GitHub automation rather than production site files.

1. Open repository `Actions`.
2. Select `生产站点 Lighthouse 检查`.
3. Click `Run workflow`, select `main`, and start the run.
4. Wait for `检查移动端性能与页面质量` to finish.
5. Verify the Summary contains four median scores and the approved thresholds.
6. Download `lighthouse-production-<run-id>` and verify that it contains HTML and JSON reports.
7. If the run is green, no email is expected because failure-only filtering is enabled.
8. If the run is red because of a real score or execution failure, confirm the existing GitHub failure email arrives; do not manufacture a failure.
9. Do not alter `MONITOR_URL`, Nginx, server files, deployment Secrets, or Lighthouse thresholds during validation.

The first real run may correctly fail because the current public URL uses HTTP or because a category is below its approved threshold. That is a site-quality result, not a deployment rollback condition and not permission to weaken the audit.
