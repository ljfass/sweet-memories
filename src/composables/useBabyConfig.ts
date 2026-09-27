import babyConfig from '../config/baby.json'

const LOCAL_DATE_TIME_PATTERN
  = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/

export interface BabyConfig {
  readonly birthDate: Date
}

export function parseBabyConfig(value: unknown): BabyConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('宝宝信息配置无效')
  }
  const keys = Object.keys(value)
  const birthDate = Reflect.get(value, 'birthDate')
  if (keys.length !== 1 || keys[0] !== 'birthDate' || typeof birthDate !== 'string') {
    throw new Error('宝宝信息配置无效')
  }
  const match = LOCAL_DATE_TIME_PATTERN.exec(birthDate)
  if (match === null) {
    throw new Error('宝宝信息配置无效')
  }

  // No trailing offset, so this is local time by spec — matching how the album
  // has always counted the baby's age.
  const parsed = new Date(birthDate)
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error('宝宝信息配置无效')
  }

  // new Date rolls impossible values over (2025-02-30 becomes 2025-03-02), so
  // the regex alone is not enough — require every field to survive the parse.
  const [, year, month, day, hours, minutes, seconds] = match
  if (
    parsed.getFullYear() !== Number(year)
    || parsed.getMonth() + 1 !== Number(month)
    || parsed.getDate() !== Number(day)
    || parsed.getHours() !== Number(hours)
    || parsed.getMinutes() !== Number(minutes)
    || parsed.getSeconds() !== Number(seconds)
  ) {
    throw new Error('宝宝信息配置无效')
  }
  return { birthDate: parsed }
}

export function useBabyConfig(config: unknown = babyConfig): BabyConfig {
  return parseBabyConfig(config)
}
