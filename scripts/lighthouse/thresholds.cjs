'use strict'

module.exports = Object.freeze([
  Object.freeze({ id: 'performance', label: '性能', minScore: 0.7, assertionLevel: 'error' }),
  Object.freeze({ id: 'accessibility', label: '可访问性', minScore: 0.9, assertionLevel: 'error' }),
  Object.freeze({ id: 'best-practices', label: '最佳实践', minScore: 0.9, assertionLevel: 'error' }),
  Object.freeze({ id: 'seo', label: 'SEO', minScore: 0.9, assertionLevel: 'warn' }),
])
