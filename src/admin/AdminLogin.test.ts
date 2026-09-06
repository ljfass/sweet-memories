import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { AdminApiError } from './api'
import AdminLogin from './AdminLogin.vue'

describe('AdminLogin', () => {
  it('uses explicit labels and password-manager autocomplete fields', () => {
    const wrapper = mount(AdminLogin, { props: { login: vi.fn() } })
    const username = wrapper.get('input[name="username"]')
    const password = wrapper.get('input[name="password"]')

    expect(wrapper.get(`label[for="${username.attributes('id')}"]`).text()).toBe('用户名')
    expect(wrapper.get(`label[for="${password.attributes('id')}"]`).text()).toBe('密码')
    expect(username.attributes('autocomplete')).toBe('username')
    expect(password.attributes()).toMatchObject({
      type: 'password',
      autocomplete: 'current-password',
    })
    expect(password.attributes()).not.toHaveProperty('maxlength')
  })

  it('prevents duplicate submission and clears the password only after login succeeds', async () => {
    let resolveLogin: (() => void) | undefined
    const login = vi.fn(() => new Promise<void>((resolve) => {
      resolveLogin = resolve
    }))
    const wrapper = mount(AdminLogin, { props: { login } })
    await wrapper.get('input[name="username"]').setValue('alice')
    await wrapper.get('input[name="password"]').setValue('correct-password')

    await wrapper.get('form').trigger('submit')
    await wrapper.get('form').trigger('submit')

    expect(login).toHaveBeenCalledTimes(1)
    expect(wrapper.get('button[type="submit"]').attributes()).toHaveProperty('disabled')
    expect((wrapper.get('input[name="password"]').element as HTMLInputElement).value)
      .toBe('correct-password')

    resolveLogin?.()
    await flushPromises()

    expect((wrapper.get('input[name="password"]').element as HTMLInputElement).value).toBe('')
    expect(wrapper.get('button[type="submit"]').attributes()).not.toHaveProperty('disabled')
  })

  it('clears username and password independently and restores field focus', async () => {
    const wrapper = mount(AdminLogin, {
      attachTo: document.body,
      props: { login: vi.fn() },
    })
    const username = wrapper.get('input[name="username"]')
    const password = wrapper.get('input[name="password"]')
    await username.setValue('alice')
    await password.setValue('correct-password')

    await wrapper.get('button[aria-label="清空用户名"]').trigger('click')
    expect((username.element as HTMLInputElement).value).toBe('')
    expect((password.element as HTMLInputElement).value).toBe('correct-password')
    expect(document.activeElement).toBe(username.element)

    await wrapper.get('button[aria-label="显示密码"]').trigger('click')
    expect(password.attributes('type')).toBe('text')
    await wrapper.get('button[aria-label="清空密码"]').trigger('click')
    expect((password.element as HTMLInputElement).value).toBe('')
    expect(password.attributes('type')).toBe('text')
    expect(document.activeElement).toBe(password.element)
    wrapper.unmount()
  })

  it('hides clear controls for empty fields and locks them during submission', async () => {
    let resolveLogin: (() => void) | undefined
    const login = vi.fn(() => new Promise<void>((resolve) => {
      resolveLogin = resolve
    }))
    const wrapper = mount(AdminLogin, { props: { login } })

    expect(wrapper.find('button[aria-label="清空用户名"]').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="清空密码"]').exists()).toBe(false)
    await wrapper.get('input[name="username"]').setValue('alice')
    await wrapper.get('input[name="password"]').setValue('correct-password')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.get('button[aria-label="清空用户名"]').attributes())
      .toHaveProperty('disabled')
    expect(wrapper.get('button[aria-label="清空密码"]').attributes())
      .toHaveProperty('disabled')
    resolveLogin?.()
    await flushPromises()
  })

  it('announces sanitized errors without rendering internal exception details', async () => {
    const login = vi.fn()
      .mockRejectedValueOnce(new AdminApiError('credentials', '用户名或密码错误'))
      .mockRejectedValueOnce(new Error('SQLITE at /srv/private.sqlite password=secret'))
    const wrapper = mount(AdminLogin, { props: { login } })
    await wrapper.get('input[name="username"]').setValue('alice')
    await wrapper.get('input[name="password"]').setValue('wrong-password')

    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[aria-live="polite"]').text()).toBe('用户名或密码错误')

    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[aria-live="polite"]').text()).toBe('登录暂时失败，请稍后重试')
    expect(wrapper.text()).not.toMatch(/SQLITE|private|password|secret/i)
  })
})
