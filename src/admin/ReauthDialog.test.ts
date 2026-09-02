import { flushPromises, mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { AdminPhotoApiClient, AdminSessionState } from './types'
import AdminApp from './AdminApp.vue'
import ReauthDialog from './ReauthDialog.vue'

function createEmptyPhotoApi(): AdminPhotoApiClient {
  return {
    listPhotos: vi.fn().mockResolvedValue([]),
    updatePhoto: vi.fn(),
    deletePhoto: vi.fn(),
  }
}

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

  it('restores the element focused before reauthentication when it remains connected', async () => {
    const returnTarget = document.createElement('button')
    returnTarget.textContent = '编辑照片标题'
    document.body.append(returnTarget)
    returnTarget.focus()
    const wrapper = mount(ReauthDialog, {
      attachTo: document.body,
      props: { open: false, username: 'alice', login: vi.fn(), logout: vi.fn() },
    })

    await wrapper.setProps({ open: true })
    await nextTick()
    expect(document.activeElement).toBe(wrapper.get('input[name="username"]').element)

    await wrapper.setProps({ open: false })
    await nextTick()
    expect(document.activeElement).toBe(returnTarget)
    returnTarget.remove()
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
      props: { session, photoApi: createEmptyPhotoApi() },
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

  it('announces a sanitized logout failure without discarding the authenticated workspace', async () => {
    const status = ref<AdminSessionState['status']['value']>('authenticated')
    const session: AdminSessionState = {
      status,
      username: ref('alice'),
      csrfToken: ref('csrf-token'),
      initialize: vi.fn(async () => undefined),
      login: vi.fn(async () => undefined),
      logout: vi.fn(async () => {
        throw new Error('SQLITE at /srv/private.sqlite password=secret')
      }),
    }
    const wrapper = mount(AdminApp, {
      props: { session, photoApi: createEmptyPhotoApi() },
    })

    await wrapper.get('.admin-toolbar button').trigger('click')
    await flushPromises()

    expect(wrapper.get('[aria-live="polite"]').text()).toBe('暂时无法退出登录，请稍后重试')
    expect(wrapper.text()).not.toMatch(/SQLITE|private|password|secret/i)
    expect(wrapper.find('[data-testid="photo-library"]').exists()).toBe(true)
  })

  it('announces a sanitized logout failure inside the active reauthentication dialog', async () => {
    const status = ref<AdminSessionState['status']['value']>('reauth-required')
    const logout = vi.fn(async () => {
      throw new Error('SQLITE at /srv/private.sqlite password=secret')
    })
    const session: AdminSessionState = {
      status,
      username: ref('alice'),
      csrfToken: ref(null),
      initialize: vi.fn(async () => undefined),
      login: vi.fn(async () => undefined),
      logout,
    }
    const wrapper = mount(AdminApp, {
      props: { session, photoApi: createEmptyPhotoApi() },
    })

    await wrapper.get('[data-testid="reauth-logout"]').trigger('click')
    await flushPromises()

    const dialog = wrapper.get('[role="dialog"]')
    expect(dialog.get('[aria-live="polite"]').text())
      .toBe('暂时无法退出登录，请稍后重试')
    expect(dialog.text()).not.toMatch(/SQLITE|private|password|secret/i)
    expect(wrapper.get('.admin-workspace-content').attributes()).toMatchObject({
      inert: '',
      'aria-hidden': 'true',
    })
    expect(logout).toHaveBeenCalledTimes(1)
  })

  it('does not restore focus to a removed workspace control after logout opens the login page', async () => {
    const status = ref<AdminSessionState['status']['value']>('authenticated')
    const session: AdminSessionState = {
      status,
      username: ref('alice'),
      csrfToken: ref('csrf-token'),
      initialize: vi.fn(async () => undefined),
      login: vi.fn(async () => undefined),
      logout: vi.fn(async () => {
        status.value = 'anonymous'
      }),
    }
    const wrapper = mount(AdminApp, {
      attachTo: document.body,
      props: { session, photoApi: createEmptyPhotoApi() },
    })
    const removedControl = wrapper.get('.admin-toolbar button').element as HTMLButtonElement
    removedControl.focus()
    status.value = 'reauth-required'
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('input[name="username"]').element)

    await wrapper.get('[data-testid="reauth-logout"]').trigger('click')
    await flushPromises()

    expect(removedControl.isConnected).toBe(false)
    expect(document.activeElement).not.toBe(removedControl)
    expect(wrapper.find('input[name="username"]').exists()).toBe(true)
  })
})
