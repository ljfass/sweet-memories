import type { AgeParts } from '../types/album'

const DAY_IN_MS = 24 * 60 * 60 * 1000
const HOUR_IN_MS = 60 * 60 * 1000
const MINUTE_IN_MS = 60 * 1000
const SECOND_IN_MS = 1000

export const ZERO_AGE: Readonly<AgeParts> = Object.freeze({
  years: 0,
  days: 0,
  hours: 0,
  minutes: 0,
  seconds: 0,
})

function zeroAge(): AgeParts {
  return { ...ZERO_AGE }
}

function anniversaryForYear(birthDate: Date, year: number): Date {
  const anniversary = new Date(birthDate)
  const month = birthDate.getMonth()
  const day = birthDate.getDate()
  const lastDayOfMonth = new Date(year, month + 1, 0).getDate()

  anniversary.setDate(1)
  anniversary.setFullYear(year)
  anniversary.setMonth(month)
  anniversary.setDate(Math.min(day, lastDayOfMonth))

  return anniversary
}

export function calculateAge(birthDate: Date, now = new Date()): AgeParts {
  const birthTime = birthDate.getTime()
  const nowTime = now.getTime()

  if (!Number.isFinite(birthTime) || !Number.isFinite(nowTime) || nowTime < birthTime) {
    return zeroAge()
  }

  let years = now.getFullYear() - birthDate.getFullYear()
  let anniversary = anniversaryForYear(birthDate, birthDate.getFullYear() + years)

  if (anniversary.getTime() > nowTime) {
    years -= 1
    anniversary = anniversaryForYear(birthDate, birthDate.getFullYear() + years)
  }

  let remainder = nowTime - anniversary.getTime()
  const days = Math.floor(remainder / DAY_IN_MS)
  remainder %= DAY_IN_MS
  const hours = Math.floor(remainder / HOUR_IN_MS)
  remainder %= HOUR_IN_MS
  const minutes = Math.floor(remainder / MINUTE_IN_MS)
  remainder %= MINUTE_IN_MS
  const seconds = Math.floor(remainder / SECOND_IN_MS)

  return { years, days, hours, minutes, seconds }
}
