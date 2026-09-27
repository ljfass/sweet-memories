import { describe, expect, it } from 'vitest'
import { calculateMonthAge, formatMonthAge } from './calculateMonthAge'

const birthDate = new Date('2025-10-09T08:55:00')

describe('calculateMonthAge', () => {
  it('returns a zero age on the day of birth', () => {
    expect(calculateMonthAge(birthDate, '2025-10-09')).toEqual({
      months: 0,
      days: 0,
    })
  })

  it('counts days before the first month completes', () => {
    expect(calculateMonthAge(birthDate, '2025-10-31')).toEqual({
      months: 0,
      days: 22,
    })
  })

  it('completes a month exactly on the monthly anniversary', () => {
    expect(calculateMonthAge(birthDate, '2025-11-09')).toEqual({
      months: 1,
      days: 0,
    })
  })

  it('ignores the birth clock time when comparing calendar days', () => {
    // Birth is 08:55 local; a photo taken earlier the same calendar day still
    // belongs to that day rather than the previous one.
    expect(calculateMonthAge(birthDate, '2025-11-09')).toEqual({
      months: 1,
      days: 0,
    })
  })

  it('clamps the anniversary to the last day of a shorter month', () => {
    const endOfJanuary = new Date('2025-01-31T00:00:00')

    expect(calculateMonthAge(endOfJanuary, '2025-02-28')).toEqual({
      months: 1,
      days: 0,
    })
    expect(calculateMonthAge(endOfJanuary, '2025-03-01')).toEqual({
      months: 1,
      days: 1,
    })
  })

  it('can report more than 30 days when the birth day clamps', () => {
    expect(calculateMonthAge(new Date('2025-01-31T00:00:00'), '2025-03-30'))
      .toEqual({ months: 1, days: 30 })
  })

  it('handles a leap-day birth in a common year', () => {
    expect(calculateMonthAge(new Date('2024-02-29T00:00:00'), '2025-02-28'))
      .toEqual({ months: 12, days: 0 })
  })

  it('returns null when the photo predates the birth date', () => {
    expect(calculateMonthAge(birthDate, '2025-10-08')).toBeNull()
  })

  it.each([
    'not-a-date',
    '2025-13-01',
    '2026-02-30',
    '2025-1-9',
    '',
  ])('returns null for the malformed captured date %j', (capturedDate) => {
    expect(calculateMonthAge(birthDate, capturedDate)).toBeNull()
  })

  it('returns null for an invalid birth date', () => {
    expect(calculateMonthAge(new Date('invalid'), '2026-01-01')).toBeNull()
  })
})

describe('formatMonthAge', () => {
  it.each([
    [null, null],
    [{ months: 0, days: 0 }, '出生当天'],
    [{ months: 0, days: 22 }, '22天'],
    [{ months: 1, days: 0 }, '1个月'],
    [{ months: 8, days: 4 }, '8个月 4天'],
    [{ months: 11, days: 30 }, '11个月 30天'],
    [{ months: 12, days: 0 }, '1岁'],
    [{ months: 12, days: 5 }, '1岁'],
    [{ months: 14, days: 5 }, '1岁 2个月'],
    [{ months: 24, days: 0 }, '2岁'],
  ])('formats %j as %j', (age, expected) => {
    expect(formatMonthAge(age)).toBe(expected)
  })
})
