import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { UploadQueueItem, UploadQueueState } from './types'
import UploadQueue from './UploadQueue.vue'

function item(overrides: Partial<UploadQueueItem> = {}): UploadQueueItem {
  return {
    id: 'item-1',
    requestId: '0195c681-9c63-7db0-8000-000000000001',
    file: new File(['family'], 'family.jpg', { type: 'image/jpeg' }),
    previewUrl: 'blob:family',
    status: 'uploading',
    progress: 46,
    errorCode: null,
    photo: null,
    hasUnrecognizedExtension: false,
    ...overrides,
  }
}

function queue(
  items: readonly UploadQueueItem[],
  status: UploadQueueState['status']['value'] = 'uploading',
): UploadQueueState {
  return {
    items: ref(items),
    status: ref(status),
    add: vi.fn(),
    retry: vi.fn(),
    remove: vi.fn(),
    continueAfterLogin: vi.fn(),
  }
}

describe('UploadQueue', () => {
  it('shows stable thumbnail, file size, progress, and a polite queue summary', () => {
    const state = queue([item()])
    const wrapper = mount(UploadQueue, { props: { queue: state } })

    expect(wrapper.get('[data-upload-item="item-1"] img').attributes()).toMatchObject({
      src: 'blob:family',
      alt: '',
    })
    expect(wrapper.text()).toContain('family.jpg')
    expect(wrapper.text()).toContain('6 B')
    expect(wrapper.get('progress').attributes()).toMatchObject({
      max: '100',
      value: '46',
      'aria-label': '上传 family.jpg',
    })
    expect(wrapper.get('[aria-label="移除 family.jpg"]')).toBeDefined()
    expect(wrapper.get('[aria-live="polite"]').text()).toContain('正在上传 1 张照片')
  })

  it('uses accessible icon actions for one failed item without exposing internal errors', async () => {
    const state = queue([item({ status: 'failed', progress: 0, errorCode: 'upload-unavailable' })], 'complete')
    const wrapper = mount(UploadQueue, { props: { queue: state } })

    expect(wrapper.text()).toContain('暂时无法上传，请稍后重试')
    expect(wrapper.text()).not.toMatch(/stack|private|sqlite/i)
    const retry = wrapper.get('[aria-label="重试 family.jpg"]')
    const remove = wrapper.get('[aria-label="移除 family.jpg"]')
    expect(retry.attributes('title')).toBe('重试')
    expect(remove.attributes('title')).toBe('移除')

    await retry.trigger('click')
    await remove.trigger('click')
    expect(state.retry).toHaveBeenCalledWith('item-1')
    expect(state.remove).toHaveBeenCalledWith('item-1')
  })

  it('does not resume automatically and offers one explicit continue action after login', async () => {
    const state = queue([
      item({ status: 'paused', progress: 25 }),
      item({ id: 'item-2', status: 'succeeded', progress: 100 }),
    ], 'ready-to-resume')
    const wrapper = mount(UploadQueue, { props: { queue: state } })

    expect(wrapper.text()).toContain('登录已恢复，上传仍处于暂停状态')
    const resume = wrapper.get('[data-continue-upload]')
    await resume.trigger('click')
    expect(state.continueAfterLogin).toHaveBeenCalledTimes(1)
  })

  it('hints about an unrecognized extension without presenting it as a rejected upload', () => {
    const state = queue([item({
      file: new File(['raw'], 'camera.raw'),
      status: 'queued',
      progress: 0,
      hasUnrecognizedExtension: true,
    })])
    const wrapper = mount(UploadQueue, { props: { queue: state } })

    expect(wrapper.text()).toContain('扩展名不常见，将由服务器检查图片内容')
    expect(wrapper.text()).toContain('等待上传')
  })
})
