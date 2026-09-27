import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgeCounter from './AgeCounter.vue'

const birthDate = new Date('2025-10-09T08:55:00')

function mountAt(now: string) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(now))
  return mount(AgeCounter, { props: { birthDate } })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AgeCounter', () => {
  it('omits the year segment during the first year', () => {
    const text = mountAt('2026-09-27T21:03:40').text()

    expect(text).not.toContain('年')
    expect(text).toContain('353 天')
  })

  it('shows the year segment once a full year has passed', () => {
    const text = mountAt('2026-10-10T10:57:03').text()

    expect(text).toContain('1 年')
    expect(text).toContain('1 天')
  })

  it('keeps the remaining units and the accessible label', () => {
    const wrapper = mountAt('2026-09-27T21:03:40')

    expect(wrapper.get('.age-counter').attributes('aria-label')).toBe(
      '宝宝年龄实时计时',
    )
    expect(wrapper.text()).toContain('来到这个美丽世界已经')
    expect(wrapper.findAll('strong')).toHaveLength(4)
  })
})
