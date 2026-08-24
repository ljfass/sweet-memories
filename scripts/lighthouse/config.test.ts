// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

const require = createRequire(import.meta.url)
const configPath = require.resolve('../../lighthouserc.cjs')
const thresholdsPath = require.resolve('./thresholds.cjs')
const seoThresholdRecord = "id: 'seo', label: 'SEO', minScore: 0.9, assertionLevel: 'warn'"
const originalMonitorUrl = process.env.MONITOR_URL
const hadMonitorUrl = Object.prototype.hasOwnProperty.call(process.env, 'MONITOR_URL')

function loadConfig() {
  delete require.cache[configPath]
  return require(configPath)
}

function loadThresholdsWithSeoRecord(record: string) {
  const source = readFileSync(thresholdsPath, 'utf8')
  const mutatedSource = source.replace(seoThresholdRecord, record)

  if (mutatedSource === source) {
    throw new Error('无法替换 SEO Lighthouse 阈值记录。')
  }

  const commonJsModule = { exports: {} }
  runInNewContext(mutatedSource, { module: commonJsModule }, { filename: thresholdsPath })
  return commonJsModule.exports
}

afterEach(() => {
  if (hadMonitorUrl) {
    process.env.MONITOR_URL = originalMonitorUrl
  } else {
    delete process.env.MONITOR_URL
  }
  delete require.cache[configPath]
})

describe('Lighthouse CI configuration', () => {
  it('rejects a missing assertion level while initializing shared thresholds', () => {
    expect(() => loadThresholdsWithSeoRecord("id: 'seo', label: 'SEO', minScore: 0.9")).toThrow(
      'Lighthouse 阈值 seo 的 assertionLevel 无效：undefined。',
    )
  })

  it('rejects an invalid assertion level while initializing shared thresholds', () => {
    expect(() => loadThresholdsWithSeoRecord(
      "id: 'seo', label: 'SEO', minScore: 0.9, assertionLevel: 'warning'",
    )).toThrow('Lighthouse 阈值 seo 的 assertionLevel 无效：warning。')
  })

  it('collects the target URL with the required mobile quality categories', () => {
    process.env.MONITOR_URL = 'http://8.163.27.231'

    expect(loadConfig().ci.collect).toEqual({
      url: ['http://8.163.27.231'],
      numberOfRuns: 3,
      settings: {
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      },
    })
  })

  it('asserts required categories as errors and private SEO as a median warning', () => {
    process.env.MONITOR_URL = 'http://8.163.27.231'

    const { ci } = loadConfig()

    expect(ci.assert.assertions).toEqual({
      'categories:performance': ['error', { aggregationMethod: 'median', minScore: 0.7 }],
      'categories:accessibility': ['error', { aggregationMethod: 'median', minScore: 0.9 }],
      'categories:best-practices': ['error', { aggregationMethod: 'median', minScore: 0.9 }],
      'categories:seo': ['warn', { aggregationMethod: 'median', minScore: 0.9 }],
    })
    expect(ci).not.toHaveProperty('upload')
  })

  it('requires MONITOR_URL', () => {
    delete process.env.MONITOR_URL

    expect(loadConfig).toThrow('缺少 MONITOR_URL。')
  })
})
