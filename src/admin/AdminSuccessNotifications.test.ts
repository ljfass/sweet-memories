// @ts-expect-error -- Node test helpers are intentionally outside the browser tsconfig types.
import { readFileSync } from 'node:fs'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import AdminSuccessNotifications from './AdminSuccessNotifications.vue'
import type { AdminSuccessNotification } from './useAdminSuccessNotifications'

vi.mock('@lucide/vue', () => ({
  CheckCircle2: { template: '<svg data-icon="check-circle-2" />' },
  X: { template: '<svg data-icon="x" />' },
}))

const items: readonly AdminSuccessNotification[] = [
  { id: 1, key: 'photo:1', message: '照片已保存' },
  { id: 2, key: 'photo:2', message: '上传已完成' },
]

describe('AdminSuccessNotifications', () => {
  it('renders a polite status with named icons without stealing focus', () => {
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()

    const wrapper = mount(AdminSuccessNotifications, {
      attachTo: document.body,
      props: { items, suspended: false },
    })

    const host = wrapper.get('[data-success-notifications]')
    expect(host.attributes()).toMatchObject({
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'false',
    })
    expect(wrapper.findAll('[data-success-notification]')).toHaveLength(2)
    expect(wrapper.text()).toContain('照片已保存')
    expect(wrapper.findAll('[data-icon="check-circle-2"]')).toHaveLength(2)
    expect(wrapper.findAll('[data-icon="x"]')).toHaveLength(2)
    expect(document.activeElement).toBe(input)

    input.remove()
  })

  it('emits pause, resume, and dismiss from pointer interactions', async () => {
    const wrapper = mount(AdminSuccessNotifications, {
      props: { items: [items[0]!], suspended: false },
    })
    const notice = wrapper.get('[data-success-notification]')
    const close = wrapper.get('button')

    expect(notice.attributes('tabindex')).toBe('0')
    expect(close.attributes()).toMatchObject({
      type: 'button',
      title: '关闭提示',
      'aria-label': '关闭提示',
      'data-dismiss-success': '',
    })

    await notice.trigger('mouseenter')
    await notice.trigger('mouseleave')
    await close.trigger('click')

    expect(wrapper.emitted('pause')).toEqual([[1]])
    expect(wrapper.emitted('resume')).toEqual([[1]])
    expect(wrapper.emitted('dismiss')).toEqual([[1]])
  })

  it('does not resume when focus moves within the same notice', async () => {
    const wrapper = mount(AdminSuccessNotifications, {
      attachTo: document.body,
      props: { items: [items[0]!], suspended: false },
    })
    const notice = wrapper.get('[data-success-notification]')
    const close = wrapper.get('button')

    await notice.trigger('focusin')
    await notice.trigger('focusout', { relatedTarget: close.element })
    expect(wrapper.emitted('pause')).toEqual([[1]])
    expect(wrapper.emitted('resume')).toBeUndefined()

    const outside = document.createElement('button')
    document.body.append(outside)
    await notice.trigger('focusout', { relatedTarget: outside })
    expect(wrapper.emitted('resume')).toEqual([[1]])
    outside.remove()
  })

  it('resumes only after both hover and focus have left the notice', async () => {
    const wrapper = mount(AdminSuccessNotifications, {
      attachTo: document.body,
      props: { items: [items[0]!], suspended: false },
    })
    const notice = wrapper.get('[data-success-notification]')
    const outside = document.createElement('button')
    document.body.append(outside)

    await notice.trigger('mouseenter')
    await notice.trigger('focusin')
    await notice.trigger('mouseleave')
    expect(wrapper.emitted('pause')).toEqual([[1]])
    expect(wrapper.emitted('resume')).toBeUndefined()

    await notice.trigger('focusout', { relatedTarget: outside })
    expect(wrapper.emitted('resume')).toEqual([[1]])
    outside.remove()
  })

  it('releases an interaction pause after a suspended interval', async () => {
    const wrapper = mount(AdminSuccessNotifications, {
      props: { items: [items[0]!], suspended: false },
    })
    const notice = wrapper.get('[data-success-notification]')

    await notice.trigger('mouseenter')
    await wrapper.setProps({ suspended: true })
    await notice.trigger('mouseleave')
    expect(wrapper.emitted('resume')).toBeUndefined()

    await wrapper.setProps({ suspended: false })
    expect(wrapper.emitted('pause')).toEqual([[1]])
    expect(wrapper.emitted('resume')).toEqual([[1]])
  })

  it('makes suspended notices inert and emits no interaction events', async () => {
    const wrapper = mount(AdminSuccessNotifications, {
      props: { items: [items[0]!], suspended: true },
    })
    const host = wrapper.get('[data-success-notifications]')
    const notice = wrapper.get('[data-success-notification]')
    const close = wrapper.get('button')

    expect(host.attributes('data-suspended')).toBe('true')
    expect(notice.attributes('tabindex')).toBe('-1')
    expect(close.attributes()).toHaveProperty('disabled')

    await notice.trigger('mouseenter')
    await notice.trigger('mouseleave')
    await notice.trigger('focusin')
    await notice.trigger('focusout')
    await close.trigger('click')

    expect(wrapper.emitted('pause')).toBeUndefined()
    expect(wrapper.emitted('resume')).toBeUndefined()
    expect(wrapper.emitted('dismiss')).toBeUndefined()
  })

  it('uses notification ids as stable keys when the list is reordered', async () => {
    const wrapper = mount(AdminSuccessNotifications, {
      props: { items, suspended: false },
    })
    const original = wrapper.findAll('[data-success-notification]').map((notice) => notice.element)

    await wrapper.setProps({ items: [items[1]!, items[0]!] })
    const reordered = wrapper.findAll('[data-success-notification]').map((notice) => notice.element)

    expect(reordered).toEqual([original[1], original[0]])
  })
})

describe('admin success notification styles', () => {
  const css = readFileSync('src/styles/admin.css', 'utf8')

  it('keeps the desktop layer fixed, bounded, wrapping, and outside document flow', () => {
    expect(css).toMatch(/\.admin-success-notifications\s*{[^}]*position:\s*fixed;[^}]*z-index:\s*60;[^}]*top:\s*24px;[^}]*right:\s*24px;/s)
    expect(css).toMatch(/\.admin-success-notifications\s*{[^}]*width:\s*min\(360px, calc\(100vw - 32px\)\);[^}]*gap:\s*8px;[^}]*pointer-events:\s*none;/s)
    expect(css).toMatch(/\.admin-success-notification\s*{[^}]*grid-template-columns:\s*20px minmax\(0, 1fr\) 32px;[^}]*border-radius:\s*7px;[^}]*pointer-events:\s*auto;/s)
    expect(css).toMatch(/\.admin-success-notification-message\s*{[^}]*overflow-wrap:\s*anywhere;/s)
  })

  it('uses the mobile safe area and removes notification motion when requested', () => {
    expect(css).toMatch(/@media \(max-width:\s*720px\)\s*{[\s\S]*?\.admin-success-notifications\s*{[^}]*top:\s*calc\(64px \+ env\(safe-area-inset-top, 0px\)\);[^}]*right:\s*12px;[^}]*left:\s*12px;[^}]*width:\s*auto;/)
    expect(css).toMatch(/\[data-suspended="true"\][^{]*{[^}]*pointer-events:\s*none;/s)
    expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)\s*{[\s\S]*?\.admin-success-notification-(?:enter|leave)-active[^{]*{[^}]*transition:\s*none;/)
    expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)\s*{[\s\S]*?\.admin-success-notification-(?:enter|leave)-(?:from|to)[^{]*{[^}]*transform:\s*none;/)
  })
})
