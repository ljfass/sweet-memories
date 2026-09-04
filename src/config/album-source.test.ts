import { describe, expect, it } from 'vitest'
import albumSource from './album-source.json'
import { parseAlbumSourceConfig } from '../composables/usePublicMemories'

describe('public album source configuration', () => {
  it('uses the exact API configuration for the activation release', () => {
    expect(albumSource).toEqual({ mode: 'api' })
    expect(Object.keys(albumSource)).toEqual(['mode'])
  })

  it.each([
    null,
    {},
    { mode: 'remote' },
    { mode: 'static', extra: true },
  ])('rejects an unsupported configuration: %j', (value) => {
    expect(() => parseAlbumSourceConfig(value)).toThrow('相册数据源配置无效')
  })

  it.each(['static', 'api'] as const)('accepts the %s mode', (mode) => {
    expect(parseAlbumSourceConfig({ mode })).toEqual({ mode })
  })
})
