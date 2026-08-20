import { describe, expect, it } from 'vitest'
import { calculateAge } from './calculateAge'

describe('calculateAge', () => {
  it('returns zero parts for a future birth date', () => {
    expect(
      calculateAge(
        new Date('2030-01-01T00:00:00'),
        new Date('2026-01-01T00:00:00'),
      ),
    ).toEqual({
      years: 0,
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
    })
  })

  it('uses completed calendar years and elapsed time since the anniversary', () => {
    expect(
      calculateAge(
        new Date('2025-10-09T08:55:00'),
        new Date('2026-10-10T10:57:03'),
      ),
    ).toEqual({
      years: 1,
      days: 1,
      hours: 2,
      minutes: 2,
      seconds: 3,
    })
  })

  it('increments years exactly on the birthday timestamp', () => {
    expect(
      calculateAge(
        new Date('2020-10-09T08:55:00'),
        new Date('2026-10-09T08:55:00'),
      ).years,
    ).toBe(6)
  })

  it('returns zero parts for invalid input', () => {
    expect(calculateAge(new Date('invalid'), new Date())).toEqual({
      years: 0,
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
    })
  })
})
