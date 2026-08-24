// @vitest-environment node
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const guideUrl = new URL('../../docs/lighthouse.md', import.meta.url)
const workflowUrl = new URL('../../.github/workflows/lighthouse.yml', import.meta.url)
const require = createRequire(import.meta.url)
const thresholds = require('../../scripts/lighthouse/thresholds.cjs')

function loadGuide() {
  return readFileSync(guideUrl, 'utf8')
}

function loadWorkflow() {
  return parse(readFileSync(workflowUrl, 'utf8'))
}

function bashCodeBlocks(guide: string) {
  return Array.from(guide.matchAll(/^```bash\n([\s\S]*?)^```/gm), (match) => match[1]).join('\n')
}

describe('production Lighthouse guide', () => {
  it('documents the workflow, schedule, thresholds, reports, and local contract', () => {
    const guide = loadGuide()
    const workflow = loadWorkflow()
    const job = workflow.jobs.lighthouse
    const artifact = job.steps.find((step: { id?: string }) => step.id === 'upload-report')
    const artifactPrefix = artifact.with.name.split('${{')[0]

    for (const requiredText of [
      '# 生产站点 Lighthouse 自动检查',
      workflow.name,
      job.name,
      workflow.on.schedule[0].cron,
      '18:23 UTC = 次日北京时间约 02:23',
      '北京时间约 02:23',
      '每次连续检查 3 次',
      '中位数',
      '远程 `main`',
      artifactPrefix,
      'HTML 和 JSON',
      `${artifact.with['retention-days']} 天`,
      'Only notify for failed workflows',
      'pnpm test:lighthouse',
      '不会访问生产站点',
      'SEO 低于 90 分只显示提示',
      '不会单独让工作流变红',
      '不是密码保护或访问控制',
      '知道地址的任何人仍然可以访问',
      '`User-agent: *`',
      '`Disallow: /`',
      '`noindex`',
      '最佳实践仍是强制项',
    ]) {
      expect(guide).toContain(requiredText)
    }

    expect(workflow.on.schedule).toHaveLength(1)
    for (const threshold of thresholds) {
      const resultType = threshold.assertionLevel === 'warn' ? '提示' : '强制'
      expect(guide).toContain(
        `| ${threshold.label} | ${Math.round(threshold.minScore * 100)} | ${resultType} |`,
      )
    }
  })

  it('keeps beginner operations read-only and free from unsafe instructions', () => {
    const guide = loadGuide()
    const workflow = loadWorkflow()
    const job = workflow.jobs.lighthouse

    expect(guide).toContain('不会阻止发布')
    expect(guide).toContain('不要修改 `MONITOR_URL`')
    expect(guide).toContain('不要停止 Nginx')
    expect(guide).toContain('第一个红色步骤')
    expect(guide).toContain('可能没有 Summary 或 Artifact')
    expect(guide).toContain('Summary 已可查看；Artifact 仍需等待后续上传成功')
    expect(guide).not.toContain('Summary 和 Artifact 都可用')
    for (const step of job.steps) {
      expect(guide).toContain(step.name)
    }
    for (const requiredText of [
      '不是仓库级广播',
      '每位用户自行配置',
      'Settings -> Notifications',
      'Default notifications email',
      'Watch -> All Activity',
      'System -> Actions',
      'Email',
      '初始创建者',
      'cron 修改者',
      '重新启用者',
      'Lighthouse 的公开临时存储',
    ]) {
      expect(guide).toContain(requiredText)
    }
    expect(guide).toMatch(/\]\(monitoring\.md#github-失败邮件通知\)/)
    expect(bashCodeBlocks(guide)).not.toMatch(/\b(?:ssh|scp|rsync)\b/i)
    expect(guide).not.toContain('ALIYUN_SSH_PRIVATE_KEY')
    expect(guide).not.toContain('temporary-public-storage')
    expect(guide).not.toContain('chmod 777')
    expect(guide).not.toContain('rm -rf')
    expect(guide).toContain('也不要对生产环境做破坏性操作')
    expect(guide).not.toMatch(/(?:请|应当|需要|可以|执行).{0,16}(?:重启|回滚|修改|更改).{0,16}(?:生产|站点)/)
  })
})
