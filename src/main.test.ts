import { describe, expect, it } from 'vitest'
import source from './main.ts?raw'
import { selectRoot } from './main'

describe('administrator entry selection', () => {
  it.each([
    ['/admin', 'admin'],
    ['/admin/', 'admin'],
    ['/administrator', 'public'],
    ['/admin/photos', 'public'],
    ['/admin//', 'public'],
    ['//outside.example/admin', 'public'],
    ['/%61dmin', 'public'],
    ['/', 'public'],
  ] as const)('selects %s as %s', (pathname, expected) => {
    expect(selectRoot(pathname)).toBe(expected)
  })

  it('shares reset and theme styles while loading the scoped admin stylesheet separately', () => {
    expect(source).toContain("import './styles/reset.css'")
    expect(source).toContain("import './styles/theme.css'")
    expect(source).toContain("import './styles/global.css'")
    expect(source).toContain("import('./styles/admin.css')")
    expect(source).not.toMatch(/vue-router|createRouter/)
  })
})
