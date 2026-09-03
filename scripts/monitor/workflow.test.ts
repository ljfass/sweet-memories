// @vitest-environment node

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface WorkflowStep {
  id: string
  name: string
  run?: string
  shell?: string
  'timeout-minutes': number
  uses?: string
}

interface MonitorJob {
  env: Record<string, string>
  environment?: unknown
  name: string
  'runs-on': string
  steps: WorkflowStep[]
  'timeout-minutes': number
}

interface MonitorWorkflow {
  concurrency: {
    'cancel-in-progress': boolean
    group: string
  }
  jobs: {
    monitor: MonitorJob
  }
  name: string
  on: {
    schedule: Array<{ cron: string }>
    workflow_dispatch: null
  }
  permissions: Record<string, string>
}

const workflowPath = fileURLToPath(
  new URL('../../.github/workflows/monitor.yml', import.meta.url),
)
const packagePath = fileURLToPath(new URL('../../package.json', import.meta.url))
const monitoringGuidePath = fileURLToPath(
  new URL('../../docs/monitoring.md', import.meta.url),
)

function loadWorkflow(): MonitorWorkflow {
  expect(existsSync(workflowPath), 'monitor workflow must exist').toBe(true)
  return parse(readFileSync(workflowPath, 'utf8')) as MonitorWorkflow
}

function stepById(steps: WorkflowStep[], id: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.id === id)
  expect(step, `workflow step "${id}" must exist`).toBeDefined()
  return step as WorkflowStep
}

describe('production site monitoring workflow', () => {
  it('runs on the two hourly offsets and supports manual checks', () => {
    const workflow = loadWorkflow()

    expect(workflow.name).toBe('生产站点巡检')
    expect(workflow.on).toEqual({
      schedule: [{ cron: '7,37 * * * *' }],
      workflow_dispatch: null,
    })
    expect(workflow.permissions).toEqual({ contents: 'read' })
  })

  it('runs independently without cancelling an active check', () => {
    const workflow = loadWorkflow()

    expect(workflow.concurrency).toEqual({
      group: 'sweet-memories-production-monitor',
      'cancel-in-progress': false,
    })
  })

  it('isolates the monitor job from secrets and deployment state', () => {
    const workflow = loadWorkflow()
    const monitor = workflow.jobs.monitor
    const serialized = JSON.stringify(workflow)

    expect(Object.keys(workflow.jobs)).toEqual(['monitor'])
    expect(monitor.name).toBe('检查公网首页和构建资源')
    expect(monitor['runs-on']).toBe('ubuntu-latest')
    expect(monitor.env).toEqual({ MONITOR_URL: '${{ vars.MONITOR_URL }}' })
    expect(monitor).not.toHaveProperty('environment')
    expect(serialized).not.toContain('secrets.')
    expect(serialized).not.toContain('ALIYUN_')
    expect(serialized).not.toMatch(/\b(?:npm|pnpm|yarn)\s+(?:ci|install|add)\b/)
    expect(serialized).not.toMatch(/\b(?:ssh|scp|rsync)\b/i)
    expect(serialized).not.toContain('scripts/deploy/')
  })

  it('pins its only action to the reviewed checkout commit', () => {
    const actionRefs = loadWorkflow()
      .jobs.monitor.steps.map((step) => step.uses)
      .filter((uses): uses is string => uses !== undefined)

    expect(actionRefs).toEqual([
      'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd',
    ])
    for (const actionRef of actionRefs) {
      expect(actionRef).toMatch(/^[^@]+@[0-9a-f]{40}$/)
    }
  })

  it('runs exactly four bounded steps in the required order', () => {
    const monitor = loadWorkflow().jobs.monitor
    const expectedBudgets = new Map([
      ['checkout', 2],
      ['validate-config', 1],
      ['syntax', 1],
      ['monitor-site', 5],
    ])
    const stepBudgets = monitor.steps.map((step) => step['timeout-minutes'])
    const totalStepBudget = stepBudgets.reduce(
      (total, budget) => total + budget,
      0,
    )

    expect(monitor.steps.map((step) => step.id)).toEqual([
      ...expectedBudgets.keys(),
    ])
    expect(monitor.steps).toHaveLength(4)
    expect(monitor.steps.every((step) => step.name.trim().length > 0)).toBe(
      true,
    )
    for (const [id, budget] of expectedBudgets) {
      expect(stepById(monitor.steps, id)['timeout-minutes']).toBe(budget)
    }
    expect(monitor['timeout-minutes']).toBe(12)
    expect(monitor['timeout-minutes']).toBeGreaterThan(totalStepBudget)
  })

  it('validates configuration and syntax before running the monitor', () => {
    const steps = loadWorkflow().jobs.monitor.steps
    const validateConfig = stepById(steps, 'validate-config')
    const syntax = stepById(steps, 'syntax')
    const monitorSite = stepById(steps, 'monitor-site')

    expect(validateConfig.shell).toBe('bash')
    expect(validateConfig.run).toContain(': "${MONITOR_URL:?缺少仓库变量 MONITOR_URL}"')
    expect(validateConfig.run).toContain("url.protocol !== 'https:'")
    expect(validateConfig.run).toContain(
      "readFileSync('src/config/album-source.json', 'utf8')",
    )
    expect(validateConfig.run).toContain("['static', 'api'].includes(config.mode)")
    expect(validateConfig.run).toContain("Object.keys(config).length === 1")
    expect(validateConfig.run).toContain("printf 'ALBUM_MODE=%s\\n' \"$ALBUM_MODE\" >> \"$GITHUB_ENV\"")
    expect(validateConfig.run).toContain(
      'python3 scripts/monitor/extract-assets.py --validate-url "$MONITOR_URL"',
    )
    expect(syntax.shell).toBe('bash')
    expect(syntax.run?.trim().split('\n')).toEqual([
      'set -euo pipefail',
      'bash -n scripts/monitor/check-site.sh',
      'node --check scripts/monitor/check-photo-api.mjs',
      `python3 -c 'compile(open("scripts/monitor/extract-assets.py", encoding="utf-8").read(), "scripts/monitor/extract-assets.py", "exec")'`,
    ])
    expect(monitorSite.shell).toBe('bash')
    expect(monitorSite.run?.trim().split('\n')).toEqual([
      'set -euo pipefail',
      'bash scripts/monitor/check-site.sh "$MONITOR_URL"',
      'node scripts/monitor/check-photo-api.mjs "$MONITOR_URL" "$ALBUM_MODE"',
    ])
  })

  it('keeps the root monitor command on the exact offline test chain', () => {
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      scripts: Record<string, string>
    }

    expect(packageJson.scripts['test:monitor']).toBe(
      'python3 scripts/monitor/test_extract_assets.py && bash scripts/monitor/check-site.test.sh && vitest run scripts/monitor/check-photo-api.test.ts',
    )
  })

  it('documents the HTTPS production origin and repository variable update', () => {
    const guide = readFileSync(monitoringGuidePath, 'utf8')

    expect(guide).toContain('`MONITOR_URL`，在 `Value` 中填写 `https://huangjianfen.cn`')
    expect(guide).toContain('更新已有的 repository variable')
    expect(guide).toContain(
      'bash scripts/monitor/check-site.sh https://huangjianfen.cn',
    )
    expect(guide).toContain(
      'node scripts/monitor/check-photo-api.mjs https://huangjianfen.cn',
    )
    expect(guide).not.toContain('http://8.163.27.231')
  })
})
