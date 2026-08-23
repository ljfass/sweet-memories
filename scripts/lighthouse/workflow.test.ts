// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

interface WorkflowStep {
  id?: string
  name?: string
  uses?: string
  run?: string
  if?: string
  shell?: string
  'timeout-minutes'?: number
  with?: Record<string, string | number | boolean>
}

interface WorkflowJob {
  name?: string
  'runs-on'?: string
  'timeout-minutes'?: number
  environment?: unknown
  env?: Record<string, string>
  steps?: WorkflowStep[]
}

interface Workflow {
  name?: string
  on?: {
    schedule?: Array<{ cron: string }>
    workflow_dispatch?: null
  }
  permissions?: Record<string, string>
  concurrency?: {
    group?: string
    'cancel-in-progress'?: boolean
  }
  jobs?: Record<string, WorkflowJob>
}

const workflowUrl = new URL('../../.github/workflows/lighthouse.yml', import.meta.url)

function loadWorkflow(): Workflow {
  expect(existsSync(workflowUrl)).toBe(true)
  return parse(readFileSync(workflowUrl, 'utf8')) as Workflow
}

function stepById(job: WorkflowJob, id: string): WorkflowStep {
  const matches = job.steps?.filter((step) => step.id === id) ?? []
  expect(matches).toHaveLength(1)
  return matches[0]
}

describe('production Lighthouse workflow', () => {
  it('declares the expected metadata, triggers, permissions, and concurrency policy', () => {
    const workflow = loadWorkflow()

    expect(workflow.name).toBe('生产站点 Lighthouse 检查')
    expect(workflow.on).toEqual({
      schedule: [{ cron: '23 18 * * *' }],
      workflow_dispatch: null,
    })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.concurrency).toEqual({
      group: 'sweet-memories-production-lighthouse',
      'cancel-in-progress': false,
    })
  })

  it('defines one isolated Lighthouse job without secrets or deployment environment', () => {
    const workflow = loadWorkflow()
    const jobs = workflow.jobs ?? {}
    const serializedWorkflow = JSON.stringify(workflow)

    expect(Object.keys(jobs)).toEqual(['lighthouse'])
    expect(jobs.lighthouse).toMatchObject({
      name: '检查移动端性能与页面质量',
      'runs-on': 'ubuntu-latest',
    })
    expect(jobs.lighthouse.env).toEqual({ MONITOR_URL: '${{ vars.MONITOR_URL }}' })
    expect(jobs.lighthouse.environment).toBeUndefined()
    expect(jobs.lighthouse).not.toHaveProperty('permissions')
    expect(serializedWorkflow).not.toMatch(/secrets\.|ALIYUN_/)
    expect(serializedWorkflow).not.toMatch(/\b(?:ssh|scp|rsync)\b/i)
    expect(serializedWorkflow).not.toMatch(/scripts\/deploy|manage-release\.sh/i)
    expect(serializedWorkflow).not.toMatch(/\blhci\s+upload\b|temporary-public-storage/i)
  })

  it('uses only the required immutable official action revisions in order', () => {
    const job = loadWorkflow().jobs?.lighthouse as WorkflowJob

    expect(job.steps?.filter((step) => step.uses).map((step) => step.uses)).toEqual([
      'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd',
      'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    ])
    for (const action of job.steps?.filter((step) => step.uses) ?? []) {
      expect(action.uses).toMatch(/@[a-f0-9]{40}$/)
    }
    expect(stepById(job, 'checkout').with).toEqual({ 'persist-credentials': false })
  })

  it('keeps the nine-step execution budget and order bounded', () => {
    const job = loadWorkflow().jobs?.lighthouse as WorkflowJob
    const expected: Array<[string, string, number]> = [
      ['检出检查代码', 'checkout', 2],
      ['校验生产地址', 'validate-config', 1],
      ['安装 Node.js', 'setup-node', 3],
      ['安装项目指定的 pnpm', 'install-pnpm', 3],
      ['安装锁定依赖', 'install-dependencies', 5],
      ['采集三次移动端报告', 'collect', 15],
      ['生成分数摘要', 'summarize', 2],
      ['检查质量阈值', 'assert', 2],
      ['上传 Lighthouse 报告', 'upload-report', 5],
    ]

    expect(job.steps?.filter((step) => step.name)).toHaveLength(9)
    expect(job.steps?.map((step) => [step.name, step.id, step['timeout-minutes']])).toEqual(expected)
    expect(job['timeout-minutes']).toBe(45)
    expect(job['timeout-minutes']).toBeGreaterThan(expected.reduce((total, [, , timeout]) => total + timeout, 0))
  })

  it('installs the prescribed Node, pnpm, and frozen dependency set', () => {
    const job = loadWorkflow().jobs?.lighthouse as WorkflowJob

    expect(stepById(job, 'setup-node')).toMatchObject({
      with: { 'node-version': '24' },
    })
    expect(stepById(job, 'install-pnpm').run?.trim()).toBe([
      'set -euo pipefail',
      'npm install --global pnpm@8.6.1',
      `test "$(pnpm --version)" = '8.6.1'`,
    ].join('\n'))
    expect(stepById(job, 'install-dependencies').run?.trim()).toBe([
      'set -euo pipefail',
      'pnpm install --frozen-lockfile',
    ].join('\n'))
  })

  it('validates, collects, summarizes, and asserts in the required order', () => {
    const job = loadWorkflow().jobs?.lighthouse as WorkflowJob
    const runSteps = job.steps?.filter((step) => typeof step.run === 'string') ?? []

    expect(runSteps).toHaveLength(6)
    for (const step of runSteps) {
      expect(step.shell).toBe('bash')
    }

    expect(stepById(job, 'validate-config')).toMatchObject({
      shell: 'bash',
      run: [
        'set -euo pipefail',
        ': "${MONITOR_URL:?缺少仓库变量 MONITOR_URL}"',
        'python3 scripts/monitor/extract-assets.py --validate-url "$MONITOR_URL"',
      ].join('\n') + '\n',
    })
    expect(stepById(job, 'collect')).toMatchObject({
      shell: 'bash',
      run: 'set -euo pipefail\npnpm exec lhci collect --config=./lighthouserc.cjs\n',
    })
    expect(stepById(job, 'summarize')).toMatchObject({
      if: '${{ steps.collect.outcome == \'success\' }}',
      shell: 'bash',
      run: 'set -euo pipefail\nnode scripts/lighthouse/summarize-reports.mjs .lighthouseci >> "$GITHUB_STEP_SUMMARY"\n',
    })
    expect(stepById(job, 'assert')).toMatchObject({
      if: '${{ steps.summarize.outcome == \'success\' }}',
      shell: 'bash',
      run: 'set -euo pipefail\npnpm exec lhci assert --config=./lighthouserc.cjs\n',
    })
  })

  it('uploads retained reports after collection even when the quality assertion fails', () => {
    const job = loadWorkflow().jobs?.lighthouse as WorkflowJob
    const upload = stepById(job, 'upload-report')

    expect(upload.if).toBe('${{ always() && steps.collect.outcome != \'skipped\' }}')
    expect(upload.with).toEqual({
      name: 'lighthouse-production-${{ github.run_id }}',
      path: '.lighthouseci/*.html\n.lighthouseci/*.json\n',
      'if-no-files-found': 'error',
      'retention-days': 14,
      'include-hidden-files': true,
    })
  })
})
