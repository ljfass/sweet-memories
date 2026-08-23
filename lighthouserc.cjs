'use strict'

// Lighthouse CI reads this configuration through CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const thresholds = require('./scripts/lighthouse/thresholds.cjs')
const monitorUrl = process.env.MONITOR_URL

if (typeof monitorUrl !== 'string' || monitorUrl.trim() === '') {
  throw new Error('缺少 MONITOR_URL。')
}

module.exports = {
  ci: {
    collect: {
      url: [monitorUrl],
      numberOfRuns: 3,
      settings: {
        onlyCategories: thresholds.map(({ id }) => id),
      },
    },
    assert: {
      assertions: Object.fromEntries(
        thresholds.map(({ id, minScore }) => [
          `categories:${id}`,
          ['error', { aggregationMethod: 'median', minScore }],
        ]),
      ),
    },
  },
}
