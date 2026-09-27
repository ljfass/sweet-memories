import { describe, expect, it } from 'vitest'
import babyConfig from './baby.json'
import { parseBabyConfig } from '../composables/useBabyConfig'

describe('baby profile configuration', () => {
  it('pins the birth timestamp the album has always counted from', () => {
    expect(babyConfig).toEqual({ birthDate: '2025-10-09T08:55:00' })
    expect(Object.keys(babyConfig)).toEqual(['birthDate'])
  })

  it('parses the shipped configuration into a local-time date', () => {
    expect(parseBabyConfig(babyConfig).birthDate).toEqual(
      new Date('2025-10-09T08:55:00'),
    )
  })

  it.each([
    null,
    [],
    {},
    { birthDate: '2025-10-09' },
    { birthDate: '2025-10-09T08:55:00Z' },
    { birthDate: '2025-10-09T08:55' },
    { birthDate: '2025-02-30T08:55:00' },
    { birthDate: 1_760_000_000_000 },
    { birthDate: '2025-10-09T08:55:00', extra: true },
  ])('rejects an unsupported configuration: %j', (value) => {
    expect(() => parseBabyConfig(value)).toThrow('宝宝信息配置无效')
  })
})
