import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { AdminPhoto, PhotoDraft } from './types'
import PhotoEditor from './PhotoEditor.vue'

const photo: AdminPhoto = {
  id: 'photo-1', title: '满月', alt: '满月照片', description: null,
  capturedDate: null, status: 'migration_pending', version: 1,
  transform: { rotation: 0, x: 0, y: 0 },
  sources: {
    avif: [{ url: '/media/photo-1/320.avif', width: 320 }],
    webp: [{ url: '/media/photo-1/320.webp', width: 320 }],
    jpeg: [{ url: '/media/photo-1/320.jpg', width: 320 }],
    fallback: { url: '/media/photo-1/320.jpg', width: 320, height: 240 },
  },
}
const draft: PhotoDraft = { title: '满月', description: '', capturedDate: '' }

describe('PhotoEditor', () => {
  it('presents the editor as a mounted growth-journal record page', () => {
    const wrapper = mount(PhotoEditor, {
      props: {
        photo, draft, conflict: false, saving: false, message: '', messageTone: null,
      },
    })

    expect(wrapper.get('.admin-photo-editor-kicker').text()).toBe('照片信息')
    expect(wrapper.get('.admin-photo-editor-header h2').text()).toBe('记录这张照片')
    const mountFrame = wrapper.get('.admin-editor-mount')
    const preview = mountFrame.get('img')
    expect(preview.attributes()).toMatchObject({
      alt: photo.alt,
      src: photo.sources.fallback.url,
      width: String(photo.sources.fallback.width),
      height: String(photo.sources.fallback.height),
    })
  })

  it('edits title, date, and description with an empty-description fallback hint', async () => {
    const wrapper = mount(PhotoEditor, {
      props: {
        photo, draft, conflict: false, saving: false, message: '', messageTone: null,
      },
    })

    expect(wrapper.get('aside').attributes('aria-label')).toBe('照片编辑器')
    expect(wrapper.get('[data-description-fallback]').text()).toContain('使用标题')
    await wrapper.get('input[name="title"]').setValue('新的满月标题')
    await wrapper.get('input[name="capturedDate"]').setValue('2026-06-01')
    await wrapper.get('textarea[name="description"]').setValue('新的公开说明')

    expect(wrapper.emitted('update-draft')?.at(-1)?.[0]).toMatchObject({ description: '新的公开说明' })
  })

  it('clears each draft field independently and restores focus after the parent update', async () => {
    const populatedDraft: PhotoDraft = {
      title: '满月',
      capturedDate: '2026-06-01',
      description: '宝宝满月留念',
    }
    const wrapper = mount(PhotoEditor, {
      attachTo: document.body,
      props: {
        photo, draft: populatedDraft, conflict: false, saving: false,
        message: '', messageTone: null,
      },
    })
    const fields = [
      { field: 'title', selector: 'input[name="title"]', label: '清空标题' },
      { field: 'capturedDate', selector: 'input[name="capturedDate"]', label: '清空拍摄日期' },
      { field: 'description', selector: 'textarea[name="description"]', label: '清空图片描述' },
    ] as const

    for (const { field, selector, label } of fields) {
      await wrapper.setProps({ draft: populatedDraft })
      await wrapper.get(`button[aria-label="${label}"]`).trigger('click')
      const updatedDraft = wrapper.emitted('update-draft')?.at(-1)?.[0] as PhotoDraft
      expect(updatedDraft).toMatchObject({ ...populatedDraft, [field]: '' })
      await wrapper.setProps({ draft: updatedDraft })
      expect(document.activeElement).toBe(wrapper.get(selector).element)
    }
    wrapper.unmount()
  })

  it('hides clear controls for empty fields and locks them while saving', async () => {
    const wrapper = mount(PhotoEditor, {
      props: {
        photo, draft: { title: '', capturedDate: '', description: '' },
        conflict: false, saving: false, message: '', messageTone: null,
      },
    })
    const labels = ['清空标题', '清空拍摄日期', '清空图片描述']

    for (const label of labels) {
      expect(wrapper.find(`button[aria-label="${label}"]`).exists()).toBe(false)
    }

    await wrapper.setProps({
      draft: { title: '满月', capturedDate: '2026-06-01', description: '宝宝满月留念' },
      saving: true,
    })
    for (const label of labels) {
      expect(wrapper.get(`button[aria-label="${label}"]`).attributes())
        .toHaveProperty('disabled')
    }
  })

  it('shows a conflict reload action and uses an accessible Trash icon button', async () => {
    const wrapper = mount(PhotoEditor, {
      props: {
        photo, draft, conflict: true, saving: false,
        message: '照片已在其他页面修改', messageTone: 'error',
      },
    })

    expect(wrapper.text()).toContain('照片已在其他页面修改')
    await wrapper.get('[data-load-latest]').trigger('click')
    expect(wrapper.emitted('load-latest')).toHaveLength(1)
    const remove = wrapper.get('[data-open-delete]')
    expect(remove.attributes()).toMatchObject({ 'aria-label': '永久删除照片', title: '永久删除照片' })
    expect(remove.find('svg').exists()).toBe(true)
  })

  it('announces save success and errors with distinct visual tones', async () => {
    const wrapper = mount(PhotoEditor, {
      props: {
        photo, draft, conflict: false, saving: false,
        message: '保存成功', messageTone: 'success',
      },
    })

    const message = wrapper.get('.admin-form-message')
    expect(message.attributes('aria-live')).toBe('polite')
    expect(message.attributes('role')).toBe('status')
    expect(message.attributes('data-save-success')).toBeDefined()
    expect(message.text()).toBe('保存成功')
    expect(message.classes()).toContain('is-success')
    expect(message.classes()).not.toContain('is-error')
    expect(message.find('svg').exists()).toBe(true)

    await wrapper.setProps({ message: '暂时无法保存照片，请稍后重试', messageTone: 'error' })

    expect(message.attributes('role')).toBeUndefined()
    expect(message.attributes('data-save-success')).toBeUndefined()
    expect(message.classes()).toContain('is-error')
    expect(message.classes()).not.toContain('is-success')
    expect(message.find('svg').exists()).toBe(false)
  })
})
