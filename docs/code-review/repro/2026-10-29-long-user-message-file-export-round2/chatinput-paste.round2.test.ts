// @vitest-environment jsdom
/**
 * 第 2 轮审查复现脚本（vitest + jsdom）——复核第 1 轮问题 1 的 UI 侧修复：
 *   1) 粘贴序号改为模块级自增后，新建态 → 会话态（ChatInput 实例重建）再粘贴不再复用同一个
 *      `pasted-text-1.txt`（序号跨实例连续）；
 *   2) 对照：CLOUD 模式长文本仍正常转 pasted-text-N.txt 附件、不插入编辑器。
 * 配套的落盘避重（dedupe）验证见同目录 dedupe-semantics.test.cjs。
 *
 * 运行方式见同目录 README.md（需先把本文件与 vitest.config.ts 拷到 desktop/.tmp-test/）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createApp, defineComponent, h, ref } from 'vue'
import { createPinia } from 'pinia'

const mocks = vi.hoisted(() => {
  // ChatInput 的 isElectronClient 是模块级常量，必须在导入前就位（LOCAL 分支需要它为真）
  ;(globalThis as any).window = globalThis.window ?? {}
  ;(globalThis as any).window.electronAPI = {
    localCopyAttachment: async () => ({ ok: true, absolutePath: '/x' }),
    localWriteTextFile: async () => ({ ok: true, absolutePath: '/x' }),
    getPathForFile: () => '',
  }
  return {
    get: vi.fn(async () => ({ data: { skills: [], commands: [] } })),
    post: vi.fn(async () => ({ data: {} })),
    getUploadConfig: vi.fn(async () => ({ storageMode: 'oss', baseUrl: '', maxSizeMb: 50 })),
  }
})
vi.mock('../src/api', () => ({ api: { get: mocks.get, post: mocks.post, put: mocks.post, delete: mocks.post } }))
vi.mock('../src/utils/storageMode', () => ({ getUploadConfig: mocks.getUploadConfig }))

import ChatInput from '../src/components/chat/ChatInput.vue'

function stubBrowserApis() {
  const w = window as any
  if (typeof w.matchMedia !== 'function') {
    w.matchMedia = (q: string) => ({
      matches: false, media: q, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
      dispatchEvent: () => false,
    })
  }
  if (typeof w.ResizeObserver !== 'function') w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  const d = document as any
  if (typeof d.elementFromPoint !== 'function') d.elementFromPoint = () => document.body
}
stubBrowserApis()

function pasteText(dom: Element, text: string) {
  const clipboardData = { items: [] as unknown[], getData: (t: string) => (t === 'text/plain' ? text : '') }
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: clipboardData })
  dom.dispatchEvent(event)
  return event
}
const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms))
const common = { draftKey: null, executionMode: 'LOCAL' as const }

/** 复刻 ChatPanel（ChatPanel.vue:5/67/24/175）：v-if 是 div 分支，v-else 是 template 片段（多根 → Fragment）。 */
const PanelLike = defineComponent({
  setup(_, { expose }) {
    const newTask = ref(true)
    expose({ setNewTask: (v: boolean) => { newTask.value = v } })
    return () => (newTask.value
      ? h('div', { class: 'center-stage' }, [
        h('div', { class: 'center-brand' }),
        h('div', { class: 'center-composer' }, [h(ChatInput, { ...common, layout: 'centered' })]),
      ])
      : [
        h('div', { class: 'messages-wrap' }),
        h('div', { class: 'composer-dock' }, [h(ChatInput, { ...common, layout: 'docked' })]),
      ])
  },
})

describe('长文本粘贴 · 第 2 轮复核', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  it('1. 新建态粘贴 → 切到会话态（实例重建）再粘贴：序号连续，不再同名', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp(PanelLike)
    app.use(createPinia())
    const vm = app.mount(container) as any
    await flush()

    const chips = () => Array.from(container.querySelectorAll('.pending-file .file-name')).map((n) => n.textContent)

    pasteText(container.querySelector('.ProseMirror')!, '1'.repeat(2500))
    await flush()
    const first = chips()
    expect(first.length).toBe(1)

    vm.setNewTask(false) // 会话创建：centered 输入框卸载、docked 输入框新建
    await flush(60)
    expect(chips()).toEqual([])

    pasteText(container.querySelector('.ProseMirror')!, '2'.repeat(2500))
    await flush()
    const second = chips()

    const seqOf = (names: (string | null)[]) => Number(/pasted-text-(\d+)\.txt/.exec(String(names[0]))?.[1])
    console.log('[round2] 第一次 =', first, '第二次 =', second)
    expect(second.length).toBe(1)
    expect(second[0]).not.toBe(first[0]) // 不再同名
    expect(seqOf(second)).toBe(seqOf(first) + 1) // 模块级自增连续
  })

  it('2. 对照·CLOUD 模式长文本仍转附件', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({ render: () => h(ChatInput, { draftKey: null, executionMode: 'CLOUD' }) })
    app.use(createPinia())
    app.mount(container)
    await flush()
    const pm = container.querySelector('.ProseMirror') as HTMLElement
    pasteText(pm, '3'.repeat(2500))
    await flush()
    const chips = Array.from(container.querySelectorAll('.pending-file .file-name')).map((n) => n.textContent)
    expect(chips.length).toBe(1)
    expect(String(chips[0])).toMatch(/^pasted-text-\d+\.txt$/)
    expect(pm.textContent ?? '').toBe('')
  })
})
