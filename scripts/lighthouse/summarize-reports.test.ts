// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { loadReports, summarizeReports } from './summarize-reports.mjs'

const temporaryDirectories: string[] = []
const execFileAsync = promisify(execFile)

function report(scores: Record<string, number> = {}) {
  return {
    categories: {
      performance: { score: scores.performance ?? 0.72 },
      accessibility: { score: scores.accessibility ?? 0.91 },
      'best-practices': { score: scores['best-practices'] ?? 0.92 },
      seo: { score: scores.seo ?? 0.96 },
    },
  }
}

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'lighthouse-summary-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe('Lighthouse report summarizer', () => {
  it('prints the mobile quality Markdown summary from three report medians', () => {
    const summary = summarizeReports([
      report({ performance: 0.71, accessibility: 0.9, 'best-practices': 0.91, seo: 0.95 }),
      report({ performance: 0.72, accessibility: 0.91, 'best-practices': 0.92, seo: 0.96 }),
      report({ performance: 0.75, accessibility: 0.94, 'best-practices': 0.95, seo: 0.99 }),
    ])

    expect(summary).toBe([
      '## Lighthouse 移动端质量检查',
      '',
      '| 分类 | 目标分 | 三次中位数 | 结果 |',
      '| --- | ---: | ---: | --- |',
      '| 性能 | 70 | 72 | 通过 |',
      '| 可访问性 | 90 | 91 | 通过 |',
      '| 最佳实践 | 90 | 92 | 通过 |',
      '| SEO | 90 | 96 | 通过 |',
      '',
    ].join('\n') + '\n')
  })

  it('treats a performance median of exactly 0.7 as passing', () => {
    const summary = summarizeReports([
      report({ performance: 0.69 }),
      report({ performance: 0.7 }),
      report({ performance: 0.89 }),
    ])

    expect(summary).toContain('| 性能 | 70 | 70 | 通过 |')
    expect(summary).not.toContain('未通过')
  })

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

  it('requires exactly three reports', () => {
    expect(() => summarizeReports([report(), report()])).toThrow(
      '需要恰好 3 份 Lighthouse LHR 报告，实际为 2 份。',
    )
  })

  it('rejects missing and NaN performance scores', () => {
    expect(() => summarizeReports([{ categories: {} }, report(), report()])).toThrow(
      '第 1 份报告的 performance 分数无效。',
    )
    expect(() => summarizeReports([report({ performance: Number.NaN }), report(), report()])).toThrow(
      '第 1 份报告的 performance 分数无效。',
    )
  })

  it('loads only LHR files and ignores malformed manifest metadata', async () => {
    const directory = await createTemporaryDirectory()
    const first = report({ performance: 0.71 })
    const second = report({ performance: 0.72 })
    const third = report({ performance: 0.73 })
    await Promise.all([
      writeFile(join(directory, 'lhr-3.json'), JSON.stringify(third)),
      writeFile(join(directory, 'lhr-1.json'), JSON.stringify(first)),
      writeFile(join(directory, 'lhr-2.json'), JSON.stringify(second)),
      writeFile(join(directory, 'manifest.json'), '{ not valid JSON'),
    ])

    await expect(loadReports(directory)).resolves.toEqual([first, second, third])
  })

  it('reports malformed LHR JSON using its file name', async () => {
    const directory = await createTemporaryDirectory()
    await Promise.all([
      writeFile(join(directory, 'lhr-1.json'), JSON.stringify(report())),
      writeFile(join(directory, 'lhr-2.json'), '{ invalid JSON'),
      writeFile(join(directory, 'lhr-3.json'), JSON.stringify(report())),
    ])

    await expect(loadReports(directory)).rejects.toThrow('LHR 报告无法解析：lhr-2.json')
  })

  it('uses the direct invocation report directory argument', async () => {
    const directory = await createTemporaryDirectory()
    await Promise.all([
      writeFile(join(directory, 'lhr-1.json'), JSON.stringify(report({ performance: 0.71 }))),
      writeFile(join(directory, 'lhr-2.json'), JSON.stringify(report({ performance: 0.72 }))),
      writeFile(join(directory, 'lhr-3.json'), JSON.stringify(report({ performance: 0.73 }))),
    ])

    const { stderr, stdout } = await execFileAsync(process.execPath, [
      join(process.cwd(), 'scripts/lighthouse/summarize-reports.mjs'),
      directory,
    ])

    expect(stderr).toBe('')
    expect(stdout).toContain('| 性能 | 70 | 72 | 通过 |')
  })
})
