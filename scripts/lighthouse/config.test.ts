// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const configPath = require.resolve('../../lighthouserc.cjs')
const originalMonitorUrl = process.env.MONITOR_URL
const hadMonitorUrl = Object.prototype.hasOwnProperty.call(process.env, 'MONITOR_URL')

function loadConfig() {
  delete require.cache[configPath]
  return require(configPath)
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
  it('collects the target URL with the required mobile quality categories', () => {
    process.env.MONITOR_URL = 'http://8.163.27.231'

    expect(loadConfig().ci.collect).toEqual({
      url: ['http://8.163.27.231'],
      numberOfRuns: 3,
      settings: {
        chromeFlags: '--headless --no-sandbox',
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      },
    })
  })

  it('asserts median category thresholds without an upload target', () => {
    process.env.MONITOR_URL = 'http://8.163.27.231'

    const { ci } = loadConfig()

    expect(ci.assert.assertions).toEqual({
      'categories:performance': ['error', { aggregationMethod: 'median', minScore: 0.7 }],
      'categories:accessibility': ['error', { aggregationMethod: 'median', minScore: 0.9 }],
      'categories:best-practices': ['error', { aggregationMethod: 'median', minScore: 0.9 }],
      'categories:seo': ['error', { aggregationMethod: 'median', minScore: 0.9 }],
    })
    expect(ci).not.toHaveProperty('upload')
  })

  it('requires MONITOR_URL', () => {
    delete process.env.MONITOR_URL

    expect(loadConfig).toThrow('缺少 MONITOR_URL。')
  })
})
