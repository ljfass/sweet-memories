import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SleepView from './SleepView.vue'
import componentSource from './SleepView.vue?raw'

describe('SleepView', () => {
  it('keeps the sleeping portrait and whisper copy', () => {
    const wrapper = mount(SleepView)

    expect(wrapper.get('.sleep-view').attributes('aria-label')).toBe('睡眠模式')
    expect(wrapper.get('.sleep-image').attributes('alt')).toBe('安静熟睡的宝宝')
    expect(wrapper.get('.sleep-title').text()).toBe('嘘，宝宝睡着了... 💤')
    expect(wrapper.get('.sleep-subtitle').text()).toBe('Good night, sweet dreams')
    expect(wrapper.find('.moon-frame').exists()).toBe(true)
  })

  it('crops the portrait as a still moon with a quiet title', () => {
    expect(componentSource).toMatch(/\.moon-frame\s*\{[^}]*border-radius:\s*50%;/s)
    expect(componentSource).toMatch(/\.sleep-picture\s*\{[^}]*border-radius:\s*50%;/s)
    expect(componentSource).toMatch(/\.sleep-image\s*\{[^}]*object-position:\s*28% 42%;/s)
    expect(componentSource).not.toMatch(/animation:\s*float/)
    expect(componentSource).not.toMatch(/-webkit-text-fill-color:\s*transparent/)
    expect(componentSource).toMatch(/\.sleep-title\s*\{[^}]*color:\s*#f4efe6;[^}]*font-size:\s*1\.15rem;[^}]*font-weight:\s*500;/s)
    expect(componentSource).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.moon-frame\s*\{[^}]*animation:\s*none;/s)
  })
})
