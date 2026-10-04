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

function normalizePrelude(prelude: string): string {
  return prelude.replace(/\s+/g, ' ').trim()
}

function closingBraceIndex(source: string, openingBraceIndex: number): number {
  let depth = 1
  let quote: '"' | "'" | null = null

  for (let index = openingBraceIndex + 1; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (character === quote && source[index - 1] !== '\\') quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
    } else if (character === '{') {
      depth += 1
    } else if (character === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }

  throw new Error('Unclosed CSS block')
}

function blocksFor(
  source: string,
  matchesPrelude: (prelude: string) => boolean,
): string[] {
  const uncommentedSource = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const matchingBodies: string[] = []
  let cursor = 0

  while (cursor < uncommentedSource.length) {
    const openingBraceIndex = uncommentedSource.indexOf('{', cursor)
    if (openingBraceIndex === -1) break

    const prelude = normalizePrelude(uncommentedSource.slice(cursor, openingBraceIndex))
    const closingIndex = closingBraceIndex(uncommentedSource, openingBraceIndex)
    if (matchesPrelude(prelude)) {
      matchingBodies.push(uncommentedSource.slice(openingBraceIndex + 1, closingIndex))
    }
    cursor = closingIndex + 1
  }

  return matchingBodies
}

function blockFor(source: string, prelude: string): string {
  const normalizedPrelude = normalizePrelude(prelude)
  const matchingBodies = blocksFor(source, (candidate) => candidate === normalizedPrelude)
  if (matchingBodies.length !== 1) {
    throw new Error(`Expected one ${prelude} block, received ${matchingBodies.length}`)
  }
  return matchingBodies[0]!
}

function mediaBody(source: string, condition: string): string {
  return blockFor(source, `@media ${condition}`)
}

function declarationsFor(source: string, selector: string): Map<string, string> {
  const normalizedSelector = normalizePrelude(selector)
  const bodies = blocksFor(source, (prelude) => (
    !prelude.startsWith('@')
    && prelude.split(',').some((candidate) => normalizePrelude(candidate) === normalizedSelector)
  ))
  if (bodies.length === 0) throw new Error(`CSS rule not found: ${selector}`)

  const declarations = new Map<string, string>()
  for (const body of bodies) {
    for (const declaration of body.split(';')) {
      const separatorIndex = declaration.indexOf(':')
      if (separatorIndex === -1) continue

      const property = declaration.slice(0, separatorIndex).trim()
      const value = declaration.slice(separatorIndex + 1).trim()
      if (property && value) declarations.set(property, value)
    }
  }

  return declarations
}

function assertDeclarations(
  declarations: ReadonlyMap<string, string>,
  selector: string,
  expected: Readonly<Record<string, string>>,
): void {
  for (const [property, expectedValue] of Object.entries(expected)) {
    const actualValue = declarations.get(property)
    if (actualValue !== expectedValue) {
      throw new Error(
        `${selector} expected ${property}: ${expectedValue}, received ${actualValue ?? '<missing>'}`,
      )
    }
  }
}

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

  it('parses declarations independently of order and keeps the final override', () => {
    const declarations = declarationsFor(`
      .sample {
        right: 24px;
        position: fixed;
        top: 30px;
      }

      .other { top: 80px; }

      .sample {
        top: 24px;
      }
    `, '.sample')

    expect(Object.fromEntries(declarations)).toEqual({
      right: '24px',
      position: 'fixed',
      top: '24px',
    })
  })

  it('reports a missing required declaration', () => {
    expect(() => assertDeclarations(
      new Map([['position', 'fixed']]),
      '.sample',
      { position: 'fixed', top: '24px' },
    )).toThrow('.sample expected top: 24px, received <missing>')
  })

  it('keeps the desktop layer fixed, bounded, wrapping, and outside document flow', () => {
    assertDeclarations(declarationsFor(css, '.admin-success-notifications'), '.admin-success-notifications', {
      position: 'fixed',
      'z-index': '60',
      top: '24px',
      right: '24px',
      width: 'min(360px, calc(100vw - 32px))',
      gap: '8px',
      'pointer-events': 'none',
    })
    assertDeclarations(declarationsFor(css, '.admin-success-notification'), '.admin-success-notification', {
      'grid-template-columns': '20px minmax(0, 1fr) 32px',
      'border-radius': '7px',
      'pointer-events': 'auto',
    })
    assertDeclarations(
      declarationsFor(css, '.admin-success-notification-message'),
      '.admin-success-notification-message',
      { 'overflow-wrap': 'anywhere' },
    )
  })

  it('uses the mobile safe area and removes notification motion when requested', () => {
    const mobileCss = mediaBody(css, '(max-width: 720px)')
    assertDeclarations(
      declarationsFor(mobileCss, '.admin-success-notifications'),
      '@media (max-width: 720px) .admin-success-notifications',
      {
        top: 'calc(64px + env(safe-area-inset-top, 0px))',
        right: '12px',
        left: '12px',
        width: 'auto',
      },
    )
    assertDeclarations(
      declarationsFor(css, '.admin-success-notifications[data-suspended="true"] .admin-success-notification'),
      '.admin-success-notifications[data-suspended="true"] .admin-success-notification',
      { 'pointer-events': 'none' },
    )

    const reducedMotionCss = mediaBody(css, '(prefers-reduced-motion: reduce)')
    for (const selector of [
      '.admin-success-notification-enter-active',
      '.admin-success-notification-leave-active',
    ]) {
      assertDeclarations(declarationsFor(reducedMotionCss, selector), selector, {
        transition: 'none',
      })
    }
    for (const selector of [
      '.admin-success-notification-enter-from',
      '.admin-success-notification-leave-to',
    ]) {
      assertDeclarations(declarationsFor(reducedMotionCss, selector), selector, {
        transform: 'none',
      })
    }
  })
})
