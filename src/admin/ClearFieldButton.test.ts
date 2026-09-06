import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ClearFieldButton from './ClearFieldButton.vue'

describe('ClearFieldButton', () => {
  it('exposes one named non-submit icon action', async () => {
    const wrapper = mount(ClearFieldButton, { props: { label: '清空用户名' } })
    const button = wrapper.get('button')

    expect(button.attributes()).toMatchObject({
      type: 'button',
      title: '清空用户名',
      'aria-label': '清空用户名',
    })
    expect(button.find('svg').attributes('aria-hidden')).toBe('true')

    await button.trigger('click')
    expect(wrapper.emitted('clear')).toHaveLength(1)
  })

  it('does not emit while disabled', async () => {
    const wrapper = mount(ClearFieldButton, {
      props: { label: '清空密码', disabled: true },
    })

    expect(wrapper.get('button').attributes()).toHaveProperty('disabled')
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('clear')).toBeUndefined()
  })
})
