// @vitest-environment node

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface WorkflowStep {
  'continue-on-error'?: boolean
  env?: Record<string, string>
  id?: string
  if?: string
  run?: string
  'timeout-minutes'?: number
  uses?: string
}

interface DeployJob {
  environment: {
    name: string
    url: string
  }
  steps: WorkflowStep[]
  'timeout-minutes': number
}

interface Workflow {
  concurrency: {
    'cancel-in-progress': boolean
    group: string
  }
  jobs: {
    deploy: DeployJob
  }
  on: {
    push: {
      branches?: unknown
      tags: string[]
    }
  }
  permissions: Record<string, string>
}

const workflowPath = fileURLToPath(
  new URL('../../.github/workflows/deploy.yml', import.meta.url),
)

function loadWorkflow(): Workflow {
  expect(existsSync(workflowPath), 'deploy workflow must exist').toBe(true)
  return parse(readFileSync(workflowPath, 'utf8')) as Workflow
}

function stepById(steps: WorkflowStep[], id: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.id === id)
  expect(step, `workflow step "${id}" must exist`).toBeDefined()
  return step as WorkflowStep
}

describe('production deployment workflow', () => {
  it('runs only for version tags with least-privilege repository access', () => {
    const workflow = loadWorkflow()

    expect(workflow.on).toEqual({ push: { tags: ['v*'] } })
    expect(workflow.permissions).toEqual({ contents: 'read' })
  })

  it('serializes production deployments without cancelling an active release', () => {
    const workflow = loadWorkflow()

    expect(workflow.concurrency).toEqual({
      group: 'sweet-memories-production',
      'cancel-in-progress': false,
    })
    expect(workflow.jobs.deploy.environment).toEqual({
      name: 'production',
      url: '${{ vars.PRODUCTION_URL }}',
    })
  })

  it('validates the tag commit against origin/main before installing or building', () => {
    const steps = loadWorkflow().jobs.deploy.steps
    const validateIndex = steps.findIndex((step) => step.id === 'validate-main')
    const dependencyIndex = steps.findIndex(
      (step) => step.id === 'install-dependencies',
    )
    const buildIndex = steps.findIndex((step) => step.id === 'build')
    const command = stepById(steps, 'validate-main').run

    expect(validateIndex).toBeGreaterThanOrEqual(0)
    expect(dependencyIndex).toBeGreaterThan(validateIndex)
    expect(buildIndex).toBeGreaterThan(validateIndex)
    expect(command).toContain(
      'git fetch origin main:refs/remotes/origin/main --no-tags',
    )
    expect(command).toContain(
      'git merge-base --is-ancestor "$GITHUB_SHA" origin/main',
    )
  })

  it('pins executable actions to reviewed immutable commits', () => {
    const actionRefs = loadWorkflow()
      .jobs.deploy.steps.map((step) => step.uses)
      .filter((uses): uses is string => uses !== undefined)

    expect(actionRefs).toEqual([
      'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd',
      'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
    ])
    for (const actionRef of actionRefs) {
      expect(actionRef).toMatch(/^[^@]+@[0-9a-f]{40}$/)
    }
  })

  it('runs exact quality and packaging commands in order before upload', () => {
    const steps = loadWorkflow().jobs.deploy.steps
    const commands = new Map([
      ['install-dependencies', 'pnpm install --frozen-lockfile'],
      ['typecheck', 'pnpm typecheck'],
      ['lint', 'pnpm lint'],
      ['test', 'pnpm test'],
      ['test-deploy', 'pnpm test:deploy'],
      ['build', 'pnpm build'],
      ['package', 'tar -C dist -czf "$RUNNER_TEMP/release.tar.gz" .'],
      ['upload', 'scp "$RUNNER_TEMP/release.tar.gz" "production:$REMOTE_ARCHIVE"'],
    ])
    const orderedIds = [...commands.keys()]
    const orderedIndexes = orderedIds.map((id) =>
      steps.findIndex((step) => step.id === id),
    )

    expect(orderedIndexes.every((index) => index >= 0)).toBe(true)
    expect(orderedIndexes).toEqual(
      [...orderedIndexes].sort((a, b) => a - b),
    )
    for (const [id, command] of commands) {
      expect(stepById(steps, id).run).toBe(command)
    }
  })

  it('gives every step a bounded budget with job recovery headroom', () => {
    const deploy = loadWorkflow().jobs.deploy
    const expectedBudgets = new Map([
      ['checkout', 2],
      ['validate-main', 2],
      ['setup-node', 3],
      ['install-pnpm', 3],
      ['install-dependencies', 5],
      ['typecheck', 3],
      ['lint', 3],
      ['test', 5],
      ['test-deploy', 3],
      ['build', 5],
      ['package', 2],
      ['validate-config', 1],
      ['configure-ssh', 1],
      ['upload', 5],
      ['activate', 5],
      ['health-check', 5],
      ['archive-cleanup', 2],
      ['cleanup', 5],
    ])
    const stepBudgets = deploy.steps.map((step) => step['timeout-minutes'])
    const totalStepBudget = stepBudgets.reduce(
      (total, budget) => total + (budget ?? 0),
      0,
    )

    expect(deploy.steps).toHaveLength(expectedBudgets.size)
    expect(
      stepBudgets.every(
        (budget) => typeof budget === 'number' && budget > 0,
      ),
    ).toBe(true)
    for (const [id, budget] of expectedBudgets) {
      expect(stepById(deploy.steps, id)['timeout-minutes']).toBe(budget)
    }
    expect(deploy['timeout-minutes']).toBe(75)
    expect(deploy['timeout-minutes']).toBeGreaterThan(totalStepBudget)
  })

  it('bounds SSH sessions and the public health request', () => {
    const steps = loadWorkflow().jobs.deploy.steps

    const sshConfig = stepById(steps, 'configure-ssh').run
    expect(sshConfig).toContain('ConnectTimeout 15')
    expect(sshConfig).toContain('ServerAliveInterval 15')
    expect(sshConfig).toContain('ServerAliveCountMax 3')

    const healthCheck = stepById(steps, 'health-check').run
    expect(healthCheck).toContain('--connect-timeout 10')
    expect(healthCheck).toContain('--max-time 30')
    expect(healthCheck).toContain('--retry-max-time 120')
    expect(healthCheck).toContain('--retry-all-errors')
  })

  it('validates SSH config interpolations as safe single-line tokens', () => {
    const command = stepById(
      loadWorkflow().jobs.deploy.steps,
      'validate-config',
    ).run

    expect(command).toContain('^[A-Za-z0-9.-]+$')
    expect(command).toContain('^[a-z_][a-z0-9_-]*$')
    expect(command).toContain('^[0-9]+$')
    expect(command).toContain('^https?://[^[:space:]]+$')
  })

  it('activates, rolls back after a failed health check, and cleans releases', () => {
    const steps = loadWorkflow().jobs.deploy.steps
    const activateIndex = steps.findIndex((step) => step.id === 'activate')
    const healthCheckIndex = steps.findIndex(
      (step) => step.id === 'health-check',
    )
    const cleanupIndex = steps.findIndex((step) => step.id === 'cleanup')
    const activate = stepById(steps, 'activate').run
    const healthCheck = stepById(steps, 'health-check').run
    const cleanup = stepById(steps, 'cleanup').run

    expect(healthCheckIndex).toBeGreaterThan(activateIndex)
    expect(cleanupIndex).toBeGreaterThan(healthCheckIndex)
    expect(activate).toContain(
      'bash -s -- activate "$SITE_ROOT" "$GITHUB_SHA" "$REMOTE_ARCHIVE"',
    )
    expect(activate).toContain('< scripts/deploy/manage-release.sh')
    expect(healthCheck).toContain('bash -s -- rollback "$SITE_ROOT"')
    expect(healthCheck).toContain('< scripts/deploy/manage-release.sh')
    expect(cleanup).toContain('bash -s -- cleanup "$SITE_ROOT" 5')
    expect(cleanup).toContain('< scripts/deploy/manage-release.sh')
  })

  it('coordinates ambiguous activation results through the live release', () => {
    const steps = loadWorkflow().jobs.deploy.steps
    const activate = stepById(steps, 'activate')
    const healthCheck = stepById(steps, 'health-check')

    expect(activate['continue-on-error']).toBe(true)
    expect(healthCheck.if).toBe(
      "${{ always() && steps.activate.outcome != 'skipped' }}",
    )
    expect(healthCheck.run).toContain('readlink -f "$SITE_ROOT/html"')
    expect(healthCheck.run).toContain('$SITE_ROOT/releases/$GITHUB_SHA')
  })

  it('removes the exact remote archive before success-only release cleanup', () => {
    const steps = loadWorkflow().jobs.deploy.steps
    const uploadIndex = steps.findIndex((step) => step.id === 'upload')
    const activateIndex = steps.findIndex((step) => step.id === 'activate')
    const healthCheckIndex = steps.findIndex(
      (step) => step.id === 'health-check',
    )
    const archiveCleanupIndex = steps.findIndex(
      (step) => step.id === 'archive-cleanup',
    )
    const cleanupIndex = steps.findIndex((step) => step.id === 'cleanup')
    const archiveCleanup = stepById(steps, 'archive-cleanup')
    const releaseCleanup = stepById(steps, 'cleanup')

    expect(activateIndex).toBeGreaterThan(uploadIndex)
    expect(healthCheckIndex).toBeGreaterThan(activateIndex)
    expect(archiveCleanupIndex).toBeGreaterThan(healthCheckIndex)
    expect(cleanupIndex).toBeGreaterThan(archiveCleanupIndex)
    expect(archiveCleanup.if).toBe(
      "${{ always() && steps.upload.outcome != 'skipped' }}",
    )
    expect(archiveCleanup['continue-on-error']).toBe(true)
    expect(archiveCleanup.run).toContain(
      'ssh production rm -f -- "$REMOTE_ARCHIVE"',
    )
    expect(releaseCleanup.if).toBeUndefined()
  })

  it('pins the ephemeral SSH client to the supplied known-hosts file', () => {
    const sshStep = stepById(
      loadWorkflow().jobs.deploy.steps,
      'configure-ssh',
    )
    const command = sshStep.run

    expect(sshStep.env?.ALIYUN_KNOWN_HOSTS).toBe(
      '${{ secrets.ALIYUN_KNOWN_HOSTS }}',
    )
    expect(command).toContain('> "$HOME/.ssh/known_hosts"')
    expect(command).toContain('StrictHostKeyChecking yes')
    expect(command).toContain(
      'UserKnownHostsFile $HOME/.ssh/known_hosts',
    )
  })
})
