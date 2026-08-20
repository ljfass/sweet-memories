import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import App from './App.vue'

describe('App', () => {
  it('renders the baby album landmark and title', () => {
    const wrapper = mount(App)

    expect(wrapper.get('main').attributes('aria-label')).toBe('宝贝成长相册')
    expect(wrapper.get('h1').text()).toBe('宝贝的快乐时光')
  })
})
