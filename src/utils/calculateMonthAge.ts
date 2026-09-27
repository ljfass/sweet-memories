const CAPTURED_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_IN_MS = 24 * 60 * 60 * 1000

export interface MonthAge {
  months: number
  days: number
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

function monthAnniversary(
  birthYear: number,
  birthMonth: number,
  birthDay: number,
  months: number,
): number {
  const total = birthMonth + months
  const year = birthYear + Math.floor(total / 12)
  const month = ((total % 12) + 12) % 12

  // Clamp to the target month's last day so 1/31 + 1 month lands on 2/28,
  // mirroring anniversaryForYear in calculateAge.ts.
  return Date.UTC(year, month, Math.min(birthDay, daysInMonth(year, month)))
}

export function calculateMonthAge(
  birthDate: Date,
  capturedDate: string,
): MonthAge | null {
  if (!Number.isFinite(birthDate.getTime())) {
    return null
  }

  const match = CAPTURED_DATE_PATTERN.exec(capturedDate)
  if (match === null) {
    return null
  }
  const capturedYear = Number(match[1])
  const capturedMonth = Number(match[2]) - 1
  const capturedDay = Number(match[3])
  if (capturedMonth < 0 || capturedMonth > 11) {
    return null
  }
  if (capturedDay < 1 || capturedDay > daysInMonth(capturedYear, capturedMonth)) {
    return null
  }

  const birthYear = birthDate.getFullYear()
  const birthMonth = birthDate.getMonth()
  const birthDay = birthDate.getDate()

  // Both endpoints are UTC midnights so the day difference stays exact across
  // daylight-saving boundaries. The birth timestamp's clock time is irrelevant
  // here — this is calendar arithmetic, not elapsed wall-clock time.
  const capturedStamp = Date.UTC(capturedYear, capturedMonth, capturedDay)
  if (capturedStamp < Date.UTC(birthYear, birthMonth, birthDay)) {
    return null
  }

  let months = (capturedYear - birthYear) * 12 + (capturedMonth - birthMonth)
  if (capturedDay < Math.min(birthDay, daysInMonth(capturedYear, capturedMonth))) {
    months -= 1
  }

  const anniversary = monthAnniversary(birthYear, birthMonth, birthDay, months)

  return { months, days: (capturedStamp - anniversary) / DAY_IN_MS }
}

export function formatMonthAge(age: MonthAge | null): string | null {
  if (age === null) {
    return null
  }

  const { months, days } = age
  if (months >= 12) {
    const years = Math.floor(months / 12)
    const remainingMonths = months % 12
    return remainingMonths === 0 ? `${years}岁` : `${years}岁 ${remainingMonths}个月`
  }
  if (months === 0) {
    return days === 0 ? '出生当天' : `${days}天`
  }
  return days === 0 ? `${months}个月` : `${months}个月 ${days}天`
}
