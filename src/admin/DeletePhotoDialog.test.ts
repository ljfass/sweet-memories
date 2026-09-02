import { flushPromises, mount } from '@vue/test-utils'
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
})
