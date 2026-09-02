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
  it('edits title, date, and description with an empty-description fallback hint', async () => {
    const wrapper = mount(PhotoEditor, {
      props: { photo, draft, conflict: false, saving: false, message: '' },
    })

    expect(wrapper.get('aside').attributes('aria-label')).toBe('照片编辑器')
    expect(wrapper.get('[data-description-fallback]').text()).toContain('使用标题')
    await wrapper.get('input[name="title"]').setValue('新的满月标题')
    await wrapper.get('input[name="capturedDate"]').setValue('2026-06-01')
    await wrapper.get('textarea[name="description"]').setValue('新的公开说明')

    expect(wrapper.emitted('update-draft')?.at(-1)?.[0]).toMatchObject({ description: '新的公开说明' })
  })

  it('shows a conflict reload action and uses an accessible Trash icon button', async () => {
    const wrapper = mount(PhotoEditor, {
      props: { photo, draft, conflict: true, saving: false, message: '照片已在其他页面修改' },
    })

    expect(wrapper.text()).toContain('照片已在其他页面修改')
    await wrapper.get('[data-load-latest]').trigger('click')
    expect(wrapper.emitted('load-latest')).toHaveLength(1)
    const remove = wrapper.get('[data-open-delete]')
    expect(remove.attributes()).toMatchObject({ 'aria-label': '永久删除照片', title: '永久删除照片' })
    expect(remove.find('svg').exists()).toBe(true)
  })
})
