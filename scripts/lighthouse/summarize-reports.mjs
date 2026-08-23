import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import thresholds from './thresholds.cjs'

const LHR_FILE_NAME = /^lhr-.*\.json$/

export function summarizeReports(reports) {
  if (!Array.isArray(reports) || reports.length !== 3) {
    throw new Error(`需要恰好 3 份 Lighthouse LHR 报告，实际为 ${reports?.length ?? 0} 份。`)
  }

  const rows = thresholds.map((threshold) => {
    const scores = reports.map((report, index) => {
      const score = report?.categories?.[threshold.id]?.score

      if (!Number.isFinite(score) || score < 0 || score > 1) {
        throw new Error(`第 ${index + 1} 份报告的 ${threshold.id} 分数无效。`)
      }

      return score
    }).sort((first, second) => first - second)
    const median = scores[1]
    const minimum = Math.round(threshold.minScore * 100)
    const medianPercent = Math.round(median * 100)
    const result = median >= threshold.minScore ? '通过' : '未通过'

    return `| ${threshold.label} | ${minimum} | ${medianPercent} | ${result} |`
  })

  return [
    '## Lighthouse 移动端质量检查',
    '',
    '| 分类 | 最低分 | 三次中位数 | 结果 |',
    '| --- | ---: | ---: | --- |',
    ...rows,
    '',
  ].join('\n') + '\n'
}

export async function loadReports(reportDirectory) {
  const directory = resolve(reportDirectory)
  const entries = await readdir(directory, { withFileTypes: true })
  const fileNames = entries
    .filter((entry) => entry.isFile() && LHR_FILE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  const reports = []

  for (const fileName of fileNames) {
    try {
      reports.push(JSON.parse(await readFile(resolve(directory, fileName), 'utf8')))
    } catch (error) {
      throw new Error(`LHR 报告无法解析：${fileName}`, { cause: error })
    }
  }

  return reports
}

async function main(reportDirectory) {
  const reports = await loadReports(reportDirectory)
  process.stdout.write(summarizeReports(reports))
}

const invokedFile = process.argv[1]

if (invokedFile && import.meta.url === pathToFileURL(resolve(invokedFile)).href) {
  main(process.argv[2] ?? '.lighthouseci')
    .catch((error) => {
      process.stderr.write(`Lighthouse 摘要失败：${error.message}\n`)
      process.exitCode = 1
    })
}
