import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { AdminPhoto } from './types'
import DeletePhotoDialog from './DeletePhotoDialog.vue'

const photo = {
  id: 'photo-1', title: '公园的一天', alt: '公园照片', description: null,
  capturedDate: '2026-05-01', status: 'published', version: 2,
  transform: { rotation: 0, x: 0, y: 0 },
  sources: {
    avif: [{ url: '/media/photo-1/320.avif', width: 320 }],
    webp: [{ url: '/media/photo-1/320.webp', width: 320 }],
    jpeg: [{ url: '/media/photo-1/320.jpg', width: 320 }],
    fallback: { url: '/media/photo-1/320.jpg', width: 320, height: 240 },
  },
} satisfies AdminPhoto

describe('DeletePhotoDialog', () => {
  it('requires an explicit second confirmation and identifies the permanent operation', async () => {
    const confirm = vi.fn(async () => true)
    const wrapper = mount(DeletePhotoDialog, {
      props: { open: true, photo, confirm, message: '' },
    })

    expect(wrapper.get('[role="dialog"]').attributes('aria-modal')).toBe('true')
    expect(wrapper.text()).toContain('公园的一天')
    expect(wrapper.text()).toContain('永久删除，无法恢复')
    expect(wrapper.get('img').attributes('src')).toBe('/media/photo-1/320.jpg')
    expect(confirm).not.toHaveBeenCalled()

    await wrapper.get('[data-confirm-delete]').trigger('click')
    await flushPromises()

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('deleted')).toHaveLength(1)
  })

  it('stays open and announces a sanitized failure when deletion fails', async () => {
    const confirm = vi.fn(async () => false)
    const wrapper = mount(DeletePhotoDialog, {
      props: { open: true, photo, confirm, message: '暂时无法删除照片，请稍后重试' },
    })

    await wrapper.get('[data-confirm-delete]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    expect(wrapper.get('[aria-live="polite"]').text()).toBe('暂时无法删除照片，请稍后重试')
    expect(wrapper.emitted('deleted')).toBeUndefined()
  })

  it('traps keyboard focus inside the dialog', async () => {
    const wrapper = mount(DeletePhotoDialog, {
      attachTo: document.body,
      props: { open: true, photo, confirm: vi.fn(async () => false), message: '' },
    })
    await nextTick()
    const cancel = wrapper.findAll('.admin-dialog-actions button')[0]!
    const confirm = wrapper.get('[data-confirm-delete]')

    expect(document.activeElement).toBe(confirm.element)
    await confirm.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(cancel.element)
    await cancel.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(confirm.element)
    wrapper.unmount()
  })

  it('restores focus to the connected trigger when the dialog closes', async () => {
    const trigger = document.createElement('button')
    trigger.textContent = '删除照片'
    document.body.append(trigger)
    trigger.focus()
    const wrapper = mount(DeletePhotoDialog, {
      attachTo: document.body,
      props: { open: true, photo, confirm: vi.fn(async () => false), message: '' },
    })
    await nextTick()

    await wrapper.setProps({ open: false })
    await nextTick()

    expect(document.activeElement).toBe(trigger)
    wrapper.unmount()
    trigger.remove()
  })

  it('cannot be cancelled with Escape or the cancel button while deletion is pending', async () => {
    let resolveDelete: ((deleted: boolean) => void) | undefined
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveDelete = resolve
    }))
    const wrapper = mount(DeletePhotoDialog, {
      props: { open: true, photo, confirm, message: '' },
    })

    await wrapper.get('[data-confirm-delete]').trigger('click')
    await nextTick()
    await wrapper.get('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    await wrapper.findAll('.admin-dialog-actions button')[0]!.trigger('click')

    expect(wrapper.emitted('cancel')).toBeUndefined()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    resolveDelete?.(true)
    await flushPromises()
    expect(wrapper.emitted('deleted')).toHaveLength(1)
  })
})
