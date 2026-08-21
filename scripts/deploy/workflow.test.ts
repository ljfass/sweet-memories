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
  uses?: string
}

interface DeployJob {
  environment: {
    name: string
    url: string
  }
  steps: WorkflowStep[]
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
