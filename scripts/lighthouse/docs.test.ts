// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const guideUrl = new URL('../../docs/lighthouse.md', import.meta.url)

function loadGuide() {
  return readFileSync(guideUrl, 'utf8')
}

describe('production Lighthouse guide', () => {
  it('documents the workflow, schedule, thresholds, reports, and local contract', () => {
    const guide = loadGuide()

    for (const requiredText of [
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
    ]) {
      expect(guide).toContain(requiredText)
    }
  })

  it('keeps beginner operations read-only and free from unsafe instructions', () => {
    const guide = loadGuide()

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
