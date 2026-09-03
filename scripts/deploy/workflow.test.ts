// @vitest-environment node

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
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
  environment: { name: string; url: string }
  'runs-on': string
  steps: WorkflowStep[]
  'timeout-minutes': number
}

interface Workflow {
  concurrency: { 'cancel-in-progress': boolean; group: string; queue: string }
  jobs: { deploy: DeployJob }
  on: { push: { branches?: unknown; tags: string[] } }
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

function stepIndex(steps: WorkflowStep[], id: string): number {
  const index = steps.findIndex((step) => step.id === id)
  expect(index, `workflow step "${id}" must exist`).toBeGreaterThanOrEqual(0)
  return index
}

type StepOutcome = 'success' | 'failure' | 'cancelled' | 'skipped'

interface ConditionState {
  cancelled?: boolean
  failure?: boolean
  mode?: 'static' | 'api'
  outcomes?: Record<string, StepOutcome>
}

const conditionStepIds = [
  'activate-api',
  'read-album-mode',
  'prepare-photo-mode',
  'activate-legacy',
  'upload-frontend',
  'activate-frontend',
  'health-check',
  'enable-uploads',
  'rollback-frontend',
  'rollback-api',
  'upload-api',
] as const

function evaluateCondition(condition: string | undefined, state: ConditionState): boolean {
  expect(condition, 'step condition must exist').toBeDefined()
  const outcomes = Object.fromEntries(
    conditionStepIds.map((id) => [id, { outcome: 'skipped', outputs: {} }]),
  ) as Record<string, { outcome: StepOutcome; outputs: Record<string, string> }>
  for (const [id, outcome] of Object.entries(state.outcomes ?? {})) {
    expect(outcomes[id], `condition fixture uses known step "${id}"`).toBeDefined()
    outcomes[id].outcome = outcome
  }
  outcomes['read-album-mode'].outputs.mode = state.mode ?? 'api'

  const source = (condition as string)
    .replace(/^\s*\$\{\{\s*/u, '')
    .replace(/\s*\}\}\s*$/u, '')
    .replace(/\balways\(\)/gu, 'status.always')
    .replace(/\bsuccess\(\)/gu, 'status.success')
    .replace(/\bfailure\(\)/gu, 'status.failure')
    .replace(/\bcancelled\(\)/gu, 'status.cancelled')
    .replace(
      /steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/gu,
      'steps["$1"].outputs["$2"]',
    )
    .replace(
      /steps\.([A-Za-z0-9_-]+)\.outcome/gu,
      'steps["$1"].outcome',
    )
  const failure = state.failure ?? false
  const cancelled = state.cancelled ?? false
  const result = runInNewContext(source, {
    status: {
      always: true,
      cancelled,
      failure,
      success: !failure && !cancelled,
    },
    steps: outcomes,
  }) as unknown
  expect(typeof result, 'condition must evaluate to a boolean').toBe('boolean')
  return result as boolean
}

describe('production deployment workflow', () => {
  it('runs only for version tags with least-privilege serialized production access', () => {
    const workflow = loadWorkflow()

    expect(workflow.on).toEqual({ push: { tags: ['v*'] } })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.concurrency).toEqual({
      group: 'sweet-memories-production',
      queue: 'max',
      'cancel-in-progress': false,
    })
    expect(workflow.jobs.deploy.environment).toEqual({
      name: 'production',
      url: '${{ vars.PRODUCTION_URL }}',
    })
  })

  it('pins executable actions and the API package runner to reviewed versions', () => {
    const deploy = loadWorkflow().jobs.deploy
    const actionRefs = deploy.steps
      .map((step) => step.uses)
      .filter((uses): uses is string => uses !== undefined)

    expect(deploy['runs-on']).toBe('ubuntu-24.04')
    expect(actionRefs).toEqual([
      'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd',
      'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
    ])
    for (const actionRef of actionRefs) {
      expect(actionRef).toMatch(/^[^@]+@[0-9a-f]{40}$/)
    }
  })

  it('installs and verifies HEIF tools before installing project dependencies', () => {
    const steps = loadWorkflow().jobs.deploy.steps
    const command = stepById(steps, 'install-heif').run ?? ''

    expect(stepIndex(steps, 'install-heif')).toBeLessThan(
      stepIndex(steps, 'install-dependencies'),
    )
    expect(command).toContain('sudo apt-get update')
    expect(command).toContain(
      'sudo apt-get install --yes --no-install-recommends libheif-examples',
    )
    expect(command).toContain('heif-info --help >/dev/null')
    expect(command).toContain('heif-convert --help >/dev/null')
  })

  it('validates main ancestry before dependencies, builds, or uploads', () => {
    const steps = loadWorkflow().jobs.deploy.steps
    const validateIndex = stepIndex(steps, 'validate-main')
    const command = stepById(steps, 'validate-main').run ?? ''

    expect(stepIndex(steps, 'install-dependencies')).toBeGreaterThan(validateIndex)
    expect(stepIndex(steps, 'build-frontend')).toBeGreaterThan(validateIndex)
    expect(stepIndex(steps, 'build-api')).toBeGreaterThan(validateIndex)
    expect(stepIndex(steps, 'upload-api')).toBeGreaterThan(validateIndex)
    expect(command).toContain(
      'git fetch origin main:refs/remotes/origin/main --no-tags',
    )
    expect(command).toContain(
      'git merge-base --is-ancestor "$GITHUB_SHA" origin/main',
    )
  })

  it('runs the fixed quality gate and packages API before frontend', () => {
    const steps = loadWorkflow().jobs.deploy.steps
    const commands = new Map([
      ['install-dependencies', 'pnpm install --frozen-lockfile'],
      ['typecheck', 'pnpm typecheck'],
      ['lint', 'pnpm lint'],
      ['test', 'pnpm test'],
      ['test-api', 'pnpm test:api'],
      ['test-deploy', 'pnpm test:deploy'],
      ['test-monitor', 'pnpm test:monitor'],
      ['build-frontend', 'pnpm build:frontend'],
      ['build-api', 'pnpm build:api'],
      [
        'package-api',
        'bash scripts/deploy/package-api.sh "$RUNNER_TEMP/api-release.tar.gz"',
      ],
      ['package-frontend', 'tar -C dist -czf "$RUNNER_TEMP/release.tar.gz" .'],
    ])
    const orderedIndexes = [...commands.keys()].map((id) => stepIndex(steps, id))

    expect(orderedIndexes).toEqual([...orderedIndexes].sort((a, b) => a - b))
    for (const [id, command] of commands) {
      expect(stepById(steps, id).run).toBe(command)
    }
  })

  it('uploads and activates the API before any frontend upload or activation', () => {
    const steps = loadWorkflow().jobs.deploy.steps
    const uploadApi = stepById(steps, 'upload-api').run ?? ''
    const activateApi = stepById(steps, 'activate-api')
    const uploadFrontend = stepById(steps, 'upload-frontend')

    expect(stepIndex(steps, 'package-api')).toBeLessThan(stepIndex(steps, 'package-frontend'))
    expect(stepIndex(steps, 'upload-api')).toBeLessThan(stepIndex(steps, 'upload-frontend'))
    expect(stepIndex(steps, 'activate-api')).toBeLessThan(stepIndex(steps, 'activate-frontend'))
    expect(uploadApi).toBe(
      'timeout 240s scp "$RUNNER_TEMP/api-release.tar.gz" "production:$REMOTE_API_ARCHIVE"',
    )
    expect(activateApi.run).toContain(
      'sudo /usr/local/sbin/manage-sweet-memories-api activate "$GITHUB_SHA" "$REMOTE_API_ARCHIVE"',
    )
    expect(activateApi['continue-on-error']).toBe(true)
    expect(uploadFrontend.if).toContain("steps.activate-api.outcome == 'success'")
  })

  it('reads the album source as exact structured JSON after API health succeeds', () => {
    const steps = loadWorkflow().jobs.deploy.steps
    const readMode = stepById(steps, 'read-album-mode')
    const command = readMode.run ?? ''

    expect(stepIndex(steps, 'read-album-mode')).toBeGreaterThan(stepIndex(steps, 'activate-api'))
    expect(readMode.if).toContain("steps.activate-api.outcome == 'success'")
    expect(command).toContain("readFileSync('src/config/album-source.json', 'utf8')")
    expect(command).toContain('JSON.parse')
    expect(command).toContain("Object.keys(config).join('\\0') !== 'mode'")
    expect(command).toContain("config.mode !== 'static' && config.mode !== 'api'")
    expect(command).toContain('mode=%s\\n')
    expect(command).toContain('>> "$GITHUB_OUTPUT"')
  })

  it('disables uploads in both modes before readiness, migration, or frontend activation', () => {
    const steps = loadWorkflow().jobs.deploy.steps
    const prepare = stepById(steps, 'prepare-photo-mode')
    const activateLegacy = stepById(steps, 'activate-legacy')
    const command = prepare.run ?? ''
    const disableCommand =
      'sudo /usr/local/sbin/manage-sweet-memories-api cli uploads disable'
    const disableIndex = command.indexOf(disableCommand)
    const caseIndex = command.indexOf('case "$ALBUM_MODE" in')
    const readinessIndex = command.indexOf(
      'sudo /usr/local/sbin/manage-sweet-memories-api cli migration check-ready',
    )

    expect(prepare.env?.ALBUM_MODE).toBe('${{ steps.read-album-mode.outputs.mode }}')
    expect(command.match(/cli uploads disable/gu)).toHaveLength(1)
    expect(disableIndex).toBeGreaterThanOrEqual(0)
    expect(disableIndex).toBeLessThan(caseIndex)
    expect(command).toContain('static)')
    expect(command).toContain('api)')
    expect(readinessIndex).toBeGreaterThan(caseIndex)
    expect(readinessIndex).toBeGreaterThan(disableIndex)
    expect(activateLegacy.if).toContain("steps.read-album-mode.outputs.mode == 'api'")
    expect(activateLegacy.run).toContain(
      'sudo /usr/local/sbin/manage-sweet-memories-api cli migration activate',
    )
    expect(stepIndex(steps, 'prepare-photo-mode')).toBeLessThan(stepIndex(steps, 'activate-legacy'))
    expect(stepIndex(steps, 'activate-legacy')).toBeLessThan(stepIndex(steps, 'activate-frontend'))
  })

  it('enables uploads only after every API activation gate explicitly succeeds', () => {
    const steps = loadWorkflow().jobs.deploy.steps
    const enable = stepById(steps, 'enable-uploads')
    const criticalSteps = [
      'activate-api',
      'prepare-photo-mode',
      'activate-legacy',
      'activate-frontend',
      'health-check',
    ]
    const allGreen = Object.fromEntries(
      criticalSteps.map((id) => [id, 'success']),
    ) as Record<string, StepOutcome>

    expect(evaluateCondition(enable.if, { mode: 'api', outcomes: allGreen })).toBe(true)
    expect(evaluateCondition(enable.if, {
      failure: true,
      mode: 'api',
      outcomes: allGreen,
    })).toBe(false)
    expect(evaluateCondition(enable.if, {
      cancelled: true,
      mode: 'api',
      outcomes: allGreen,
    })).toBe(false)
    expect(evaluateCondition(enable.if, { mode: 'static', outcomes: allGreen })).toBe(false)
    for (const id of criticalSteps) {
      expect(enable.if).toContain(`steps.${id}.outcome == 'success'`)
      for (const outcome of ['failure', 'cancelled'] as const) {
        expect(evaluateCondition(enable.if, {
          mode: 'api',
          outcomes: { ...allGreen, [id]: outcome },
        }), `${id}=${outcome} must not enable uploads`).toBe(false)
      }
    }
  })

  it('checks HTTPS, public order, five legacy IDs, and first media before uploads', () => {
    const steps = loadWorkflow().jobs.deploy.steps
    const health = stepById(steps, 'health-check').run ?? ''
    const enable = stepById(steps, 'enable-uploads')
    const fixedIds = [
      '9a9a60f7-1edb-48ef-8ceb-5d9e188c2ab1',
      '58efb95e-2a98-45be-bbe4-acde6c34f7cd',
      'f83da4e8-d94e-4b8a-a725-36e2d1f931bf',
      'a15b8021-9842-4ed7-bd0f-9f98518a2d72',
      'c9608cd6-3480-43fb-84ab-623899262ff9',
    ]

    expect(health).toContain('site_origin="${PRODUCTION_URL%/}"')
    expect(health).toContain('"$site_origin/api/photos"')
    expect(health).toContain('JSON.parse')
    expect(health).toContain('previous.capturedDate > current.capturedDate')
    for (const id of fixedIds) expect(health).toContain(id)
    expect(health).toContain('photo.sources.fallback.url')
    expect(health).toContain('mediaUrl.origin !== siteOrigin')
    expect(health).toContain("mediaUrl.pathname.startsWith('/media/')")
    expect(health).toContain('[[ "$media_status" == 2[0-9][0-9] ]]')
    expect(enable.if).toContain("steps.health-check.outcome == 'success'")
    expect(enable.if).toContain("steps.read-album-mode.outputs.mode == 'api'")
    expect(enable.run).toContain(
      'sudo /usr/local/sbin/manage-sweet-memories-api cli uploads enable',
    )
    expect(stepIndex(steps, 'health-check')).toBeLessThan(stepIndex(steps, 'enable-uploads'))
  })

  it('disables uploads before bounded conditional frontend and API rollback', () => {
    const steps = loadWorkflow().jobs.deploy.steps
    const disable = stepById(steps, 'disable-uploads')
    const frontend = stepById(steps, 'rollback-frontend')
    const api = stepById(steps, 'rollback-api')

    expect(disable.if).toContain('failure()')
    expect(disable.run).toContain(
      'sudo /usr/local/sbin/manage-sweet-memories-api cli uploads disable',
    )
    expect(stepIndex(steps, 'disable-uploads')).toBeLessThan(stepIndex(steps, 'rollback-frontend'))
    expect(stepIndex(steps, 'rollback-frontend')).toBeLessThan(stepIndex(steps, 'rollback-api'))
    expect(frontend.if).toContain('failure()')
    expect(frontend.run).toContain('for attempt in 1 2 3')
    expect(frontend.run).toContain(
      'bash -s -- rollback-if-current "$SITE_ROOT" "$GITHUB_SHA"',
    )
    expect(frontend.run).toContain('< scripts/deploy/manage-release.sh')
    expect(frontend.run).toContain('readlink -f -- "$SITE_ROOT/html"')
    expect(api.if).toContain('failure()')
    expect(api.run).toContain('for attempt in 1 2 3')
    expect(api.run).toContain(
      'sudo /usr/local/sbin/manage-sweet-memories-api rollback-if-current "$GITHUB_SHA"',
    )
    expect(api.run).toContain('readlink -f -- /opt/sweet-memories-api/current')
  })

  it('runs fail-closed compensation on cancellation and preserves API ordering', () => {
    const steps = loadWorkflow().jobs.deploy.steps
    const disable = stepById(steps, 'disable-uploads')
    const frontend = stepById(steps, 'rollback-frontend')
    const api = stepById(steps, 'rollback-api')
    const report = stepById(steps, 'fail-deployment')
    const activationStarted = {
      'activate-api': 'success',
      'activate-frontend': 'skipped',
      'rollback-frontend': 'skipped',
    } satisfies Record<string, StepOutcome>

    for (const cleanup of [disable, frontend, api]) {
      expect(cleanup.if).toContain('cancelled()')
      expect(cleanup.if).toContain("== 'cancelled'")
    }
    expect(evaluateCondition(disable.if, {
      cancelled: true,
      outcomes: activationStarted,
    })).toBe(true)
    expect(evaluateCondition(api.if, {
      cancelled: true,
      outcomes: activationStarted,
    })).toBe(true)
    expect(evaluateCondition(frontend.if, {
      cancelled: true,
      outcomes: {
        ...activationStarted,
        'activate-frontend': 'success',
      },
    })).toBe(true)
    expect(evaluateCondition(disable.if, {
      outcomes: {
        ...activationStarted,
        'activate-api': 'cancelled',
      },
    })).toBe(true)

    const frontendActivated = {
      'activate-api': 'success',
      'activate-frontend': 'success',
    } satisfies Record<string, StepOutcome>
    expect(evaluateCondition(api.if, {
      failure: true,
      outcomes: {
        ...frontendActivated,
        'rollback-frontend': 'success',
      },
    })).toBe(true)
    for (const outcome of ['failure', 'cancelled', 'skipped'] as const) {
      expect(evaluateCondition(api.if, {
        failure: true,
        outcomes: {
          ...frontendActivated,
          'rollback-frontend': outcome,
        },
      }), `API rollback must wait when frontend rollback is ${outcome}`).toBe(false)
    }
    expect(evaluateCondition(report.if, {
      failure: true,
      outcomes: {
        ...frontendActivated,
        'rollback-frontend': 'failure',
      },
    })).toBe(true)
    expect(report.env?.FRONTEND_ROLLBACK_OUTCOME).toBe(
      '${{ steps.rollback-frontend.outcome }}',
    )
    expect(report.run).toContain('前端回退未确认，API 保持当前版本')
  })

  it('always removes exact archives and only cleans five releases on success', () => {
    const steps = loadWorkflow().jobs.deploy.steps
    const frontendArchive = stepById(steps, 'archive-cleanup-frontend')
    const apiArchive = stepById(steps, 'archive-cleanup-api')
    const frontendCleanup = stepById(steps, 'cleanup-frontend')
    const apiCleanup = stepById(steps, 'cleanup-api')

    expect(frontendArchive.if).toBe(
      "${{ always() && steps.upload-frontend.outcome != 'skipped' }}",
    )
    expect(apiArchive.if).toBe(
      "${{ always() && steps.upload-api.outcome != 'skipped' }}",
    )
    expect(frontendArchive['continue-on-error']).toBe(true)
    expect(apiArchive['continue-on-error']).toBe(true)
    expect(frontendArchive.run).toBe(
      'timeout 30s ssh production rm -f -- "$REMOTE_FRONTEND_ARCHIVE"',
    )
    expect(apiArchive.run).toBe(
      'timeout 30s ssh production rm -f -- "$REMOTE_API_ARCHIVE"',
    )
    expect(evaluateCondition(frontendArchive.if, {
      cancelled: true,
      outcomes: { 'upload-frontend': 'success' },
    })).toBe(true)
    expect(evaluateCondition(apiArchive.if, {
      cancelled: true,
      outcomes: { 'upload-api': 'success' },
    })).toBe(true)
    expect(frontendCleanup.if).toContain("steps.health-check.outcome == 'success'")
    expect(frontendCleanup.run).toContain('bash -s -- cleanup "$SITE_ROOT" 5')
    expect(apiCleanup.if).toContain("steps.health-check.outcome == 'success'")
    expect(apiCleanup.run).toContain(
      'sudo /usr/local/sbin/manage-sweet-memories-api cleanup 5',
    )

    const packageAndCleanup = [
      'package-api',
      'package-frontend',
      'archive-cleanup-api',
      'archive-cleanup-frontend',
      'cleanup-api',
      'cleanup-frontend',
    ].map((id) => stepById(steps, id).run ?? '').join('\n')
    expect(packageAndCleanup).not.toContain('/var/lib/sweet-memories')
    expect(packageAndCleanup).not.toContain('/var/www/huangjianfen.cn/html')
  })

  it('gives every step a positive budget and the job more than ten minutes headroom', () => {
    const deploy = loadWorkflow().jobs.deploy
    const expectedBudgets = new Map([
      ['checkout', 2], ['validate-main', 2], ['setup-node', 3],
      ['install-pnpm', 3], ['install-heif', 5], ['install-dependencies', 5],
      ['typecheck', 5], ['lint', 5], ['test', 7], ['test-api', 8],
      ['test-deploy', 5], ['test-monitor', 5], ['build-frontend', 5],
      ['build-api', 5], ['package-api', 5], ['package-frontend', 2],
      ['validate-config', 1], ['configure-ssh', 1], ['validate-live', 3],
      ['upload-api', 5], ['activate-api', 5], ['read-album-mode', 1],
      ['prepare-photo-mode', 5], ['activate-legacy', 3], ['upload-frontend', 5],
      ['activate-frontend', 5], ['health-check', 8], ['enable-uploads', 3],
      ['disable-uploads', 3], ['rollback-frontend', 5], ['rollback-api', 11],
      ['archive-cleanup-frontend', 2], ['archive-cleanup-api', 2],
      ['cleanup-frontend', 5], ['cleanup-api', 5], ['fail-deployment', 1],
    ])
    const budgets = deploy.steps.map((step) => step['timeout-minutes'])
    const total = budgets.reduce((sum, budget) => sum + (budget ?? 0), 0)

    expect(deploy.steps).toHaveLength(expectedBudgets.size)
    expect(budgets.every((budget) => typeof budget === 'number' && budget > 0)).toBe(true)
    for (const [id, budget] of expectedBudgets) {
      expect(stepById(deploy.steps, id)['timeout-minutes']).toBe(budget)
    }
    expect(deploy['timeout-minutes']).toBe(170)
    expect(deploy['timeout-minutes']).toBeGreaterThan(total + 10)
  })

  it('bounds network operations and preserves strict host-key verification', () => {
    const steps = loadWorkflow().jobs.deploy.steps
    const sshStep = stepById(steps, 'configure-ssh')
    const sshConfig = sshStep.run ?? ''
    const health = stepById(steps, 'health-check').run ?? ''

    expect(sshStep.env?.ALIYUN_KNOWN_HOSTS).toBe('${{ secrets.ALIYUN_KNOWN_HOSTS }}')
    expect(sshConfig).toContain('> "$HOME/.ssh/known_hosts"')
    expect(sshConfig).toContain('StrictHostKeyChecking yes')
    expect(sshConfig).toContain('UserKnownHostsFile $HOME/.ssh/known_hosts')
    expect(sshConfig).toContain('ConnectTimeout 15')
    expect(sshConfig).toContain('ServerAliveInterval 15')
    expect(sshConfig).toContain('ServerAliveCountMax 3')
    expect(health).toContain('timeout 120s curl')
    expect(health).toContain('--connect-timeout 10')
    expect(health).toContain('--max-time 30')
    expect(health).toContain('--retry-max-time 120')
    expect(health).toContain('--retry-all-errors')
  })

  it('rejects unsafe configuration and stale or unverifiable frontend releases', () => {
    const steps = loadWorkflow().jobs.deploy.steps
    const config = stepById(steps, 'validate-config').run ?? ''
    const live = stepById(steps, 'validate-live').run ?? ''

    expect(config).toContain('^[A-Za-z0-9.-]+$')
    expect(config).toContain('^[a-z_][a-z0-9_-]*$')
    expect(config).toContain('^[0-9]+$')
    expect(config).toContain('^https://[^[:space:]]+$')
    expect(live).toContain('for attempt in 1 2 3')
    expect(live).toContain('ssh production readlink -f -- "$SITE_ROOT/html"')
    expect(live).toContain('^initial-[0-9]{8}T[0-9]{6}Z$')
    expect(live).toContain('^[0-9a-f]{40}$')
    expect(live).toContain('git cat-file -e "$active_sha^{commit}"')
    expect(live).toContain(
      'git merge-base --is-ancestor "$active_sha" "$GITHUB_SHA"',
    )
  })

  it('parses every run block as Bash', () => {
    for (const step of loadWorkflow().jobs.deploy.steps) {
      if (step.run === undefined) continue
      const result = spawnSync('bash', ['-n'], { encoding: 'utf8', input: step.run })
      expect(
        result.status,
        `run block ${step.id ?? '<missing id>'}: ${result.stderr}`,
      ).toBe(0)
    }
  })
})
