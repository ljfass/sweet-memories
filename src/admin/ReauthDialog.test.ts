import { flushPromises, mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { AdminSessionState } from './types'
import AdminApp from './AdminApp.vue'
import ReauthDialog from './ReauthDialog.vue'

describe('ReauthDialog', () => {
  it('opens as a modal and moves focus to the username field', async () => {
    const wrapper = mount(ReauthDialog, {
      attachTo: document.body,
      props: { open: true, username: 'alice', login: vi.fn(), logout: vi.fn() },
    })
    await nextTick()

    expect(wrapper.get('[role="dialog"]').attributes('aria-modal')).toBe('true')
    expect(wrapper.get('[role="dialog"]').text()).toContain('登录已过期')
    expect(document.activeElement).toBe(wrapper.get('input[name="username"]').element)
    expect(wrapper.get('input[name="password"]').attributes()).not.toHaveProperty('maxlength')
  })

  it('traps keyboard focus and keeps the dialog open when Escape is pressed', async () => {
    const wrapper = mount(ReauthDialog, {
      attachTo: document.body,
      props: { open: true, username: 'alice', login: vi.fn(), logout: vi.fn() },
    })
    await nextTick()
    const submit = wrapper.get('button[type="submit"]')
    ;(submit.element as HTMLButtonElement).focus()

    await wrapper.get('[role="dialog"]').trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(wrapper.get('input[name="username"]').element)

    await wrapper.get('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.get('[role="dialog"]').isVisible()).toBe(true)
    expect(wrapper.get('[aria-live="polite"]').text()).toBe('请重新登录或退出登录')
  })

  it('clears the password and reports successful reauthentication', async () => {
    const login = vi.fn().mockResolvedValue(undefined)
    const wrapper = mount(ReauthDialog, {
      props: { open: true, username: 'alice', login, logout: vi.fn() },
    })
    await wrapper.get('input[name="password"]').setValue('new-password')

    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(login).toHaveBeenCalledWith('alice', 'new-password')
    expect((wrapper.get('input[name="password"]').element as HTMLInputElement).value).toBe('')
    expect(wrapper.emitted('reauthenticated')).toHaveLength(1)
  })

  it('keeps the authenticated workspace and its draft mounted under the modal', async () => {
    const status = ref<AdminSessionState['status']['value']>('authenticated')
    const session: AdminSessionState = {
      status,
      username: ref('alice'),
      csrfToken: ref('csrf-token'),
      initialize: vi.fn(async () => undefined),
      login: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
    }
    const wrapper = mount(AdminApp, {
      props: { session },
      slots: {
        workspace: '<input data-testid="preserved-draft" aria-label="照片标题草稿">',
      },
    })
    const library = wrapper.get('[data-testid="photo-library"]')
    const draft = wrapper.get('[data-testid="preserved-draft"]')
    await draft.setValue('尚未保存的标题')

    status.value = 'reauth-required'
    await nextTick()

    expect(wrapper.get('[data-testid="photo-library"]').element).toBe(library.element)
    expect((wrapper.get('[data-testid="preserved-draft"]').element as HTMLInputElement).value)
      .toBe('尚未保存的标题')
    expect(wrapper.get('[role="dialog"]').text()).toContain('登录已过期')
  })
})
