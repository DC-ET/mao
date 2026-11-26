/**
 * @vitest-environment jsdom
 */
// 进设置页会卸载输入框。useEditor 的卸载钩子先 destroy()，之后再 saveDraft 时
// getHTML 已经拿不到，草稿 html 退回纯文本。返回时 setContent 按 HTML 解析，换行折成空格。
// 刷新往往来不及跑卸载钩子，读的是输入时写下的 HTML，所以换行还在。
import { createApp, h, nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDraftStore } from '../../stores/draft'

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

vi.mock('./QuickCommandPanel.vue', () => ({ default: { name: 'QuickCommandPanel', render: () => null } }))
vi.mock('./FileReferencePanel.vue', () => ({ default: { name: 'FileReferencePanel', render: () => null } }))
vi.mock('./ChatNewTaskConfigBar.vue', () => ({ default: { name: 'ChatNewTaskConfigBar', render: () => null } }))
vi.mock('./ChatPendingFileList.vue', () => ({ default: { name: 'ChatPendingFileList', render: () => null } }))
vi.mock('./ChatInputToolbar.vue', () => ({ default: { name: 'ChatInputToolbar', render: () => null } }))
vi.mock('./ChatMobileConfigRow.vue', () => ({ default: { name: 'ChatMobileConfigRow', render: () => null } }))
vi.mock('./ImageAnnotatorDialog.vue', () => ({ default: { name: 'ImageAnnotatorDialog', render: () => null } }))

import ChatInput from './ChatInput.vue'

interface ChatInputApi {
  restoreContent: (text: string, files: File[]) => void
  getPlainText: () => string
}

function installDomShims() {
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia
  }
  if (typeof document.elementFromPoint !== 'function') {
    document.elementFromPoint = () => null
  }
}

function mountInput(pinia: Pinia, draftKey: string) {
  installDomShims()
  const el = document.createElement('div')
  document.body.appendChild(el)
  const exposed: { api: ChatInputApi | null } = { api: null }
  const app = createApp({
    setup() {
      return () => h(ChatInput, {
        draftKey,
        ref: (value: unknown) => {
          exposed.api = value as ChatInputApi | null
        },
      })
    },
  })
  app.use(pinia)
  app.config.warnHandler = () => {}
  app.mount(el)
  return {
    api: () => exposed.api,
    destroy() {
      app.unmount()
      el.remove()
    },
  }
}

describe('ChatInput 草稿换行在卸载后保留', () => {
  let pinia: Pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('离开再挂上后多行正文仍是多行', async () => {
    const first = mountInput(pinia, 's:1')
    await nextTick()
    await nextTick()
    first.api()?.restoreContent('1\n2\n3', [])
    await nextTick()

    const store = useDraftStore()
    const before = store.getDraft('s:1')
    expect(before?.text).toBe('1\n2\n3')
    expect(before?.html ?? '').toMatch(/<br|<\/p>\s*<p>/)

    first.destroy()

    const after = store.getDraft('s:1')
    expect(after?.html ?? '').toMatch(/<br|<\/p>\s*<p>/)
    expect(after?.text).toBe('1\n2\n3')

    const second = mountInput(pinia, 's:1')
    await nextTick()
    await nextTick()
    expect(second.api()?.getPlainText()).toBe('1\n2\n3')
    second.destroy()
  })

  it('已经存成纯文本的草稿，再挂上时换行恢复', async () => {
    const store = useDraftStore()
    store.setDraft('s:1', { html: '1\n2\n3', text: '1\n2\n3', files: [] })
    const view = mountInput(pinia, 's:1')
    await nextTick()
    await nextTick()
    expect(view.api()?.getPlainText()).toBe('1\n2\n3')
    view.destroy()
    expect(store.getDraft('s:1')?.html ?? '').toMatch(/<br|<\/p>\s*<p>/)
  })
})
