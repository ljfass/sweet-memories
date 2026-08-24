'use strict'

const assertionLevels = new Set(['error', 'warn'])
const thresholds = [
  { id: 'performance', label: '性能', minScore: 0.7, assertionLevel: 'error' },
  { id: 'accessibility', label: '可访问性', minScore: 0.9, assertionLevel: 'error' },
  { id: 'best-practices', label: '最佳实践', minScore: 0.9, assertionLevel: 'error' },
  { id: 'seo', label: 'SEO', minScore: 0.9, assertionLevel: 'warn' },
]

module.exports = Object.freeze(thresholds.map((threshold) => {
  if (!assertionLevels.has(threshold.assertionLevel)) {
    throw new Error(
      `Lighthouse 阈值 ${threshold.id} 的 assertionLevel 无效：${String(threshold.assertionLevel)}。`,
    )
  }

  return Object.freeze(threshold)
}))
