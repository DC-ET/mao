// @vitest-environment jsdom
/**
 * 第 1 轮审查复现脚本（vitest + jsdom）——ChatInput 粘贴超长文本的两处行为：
 *   A. 新建态「粘贴→发送」后输入框切换到另一个实例（ChatPanel 的 v-if / template-v-else 两分支），
 *      再粘贴时附件序号从 1 重新开始 → 同一会话内第二次仍是 pasted-text-1.txt（LOCAL 落盘覆盖的前提）；
 *   B. LOCAL 模式但非 Electron 客户端（浏览器）粘贴超长文本：附件没加、编辑器也没插入 → 内容丢失；
 *   C. 对照：CLOUD 模式粘贴转附件正常；短文本照常进编辑器；附件位满（10 个）时回落插入编辑器。
 *
 * 运行（见同目录 README.md）：
 *   1) 把本文件与 vitest.config.ts 拷到 desktop/.tmp-test/
 *   2) cd desktop && NODE_OPTIONS="--require <仓库根>/docs/code-review/repro/2026-10-29-long-user-message-file-export/zstd-stub.cjs" \
 *        npx vitest run --config .tmp-test/vitest.config.ts
 *   （NODE_OPTIONS 里的 zstd 补丁仅为规避本机 Node 22.14 缺 zlib.createZstdDecompress 导致 jsdom worker 起不来，
 *    与本次被审代码无关；Node ≥ 22.15 可去掉。）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createApp, defineComponent, h, ref } from 'vue'
import { createPinia } from 'pinia'

const mocks = vi.hoisted(() => {
  // ChatInput 的 isElectronClient 是模块级常量，必须在导入前就位（否则 LOCAL 分支不可用）
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

// jsdom 缺实现的浏览器 API 补齐（仅测试用）
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

function mount(component: unknown, props: Record<string, unknown> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(component as never, { draftKey: null, ...props }) })
  app.use(createPinia())
  app.mount(container)
  return { container, chips: () => Array.from(container.querySelectorAll('.pending-file .file-name')).map((n) => n.textContent) }
}

const common = { draftKey: null, executionMode: 'LOCAL' as const }

/** 复刻 ChatPanel（ChatPanel.vue:5/67/24/175）：v-if 是一个 div 分支，v-else 是 template 片段（多根 → Fragment）。 */
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

describe('长文本粘贴 · 第 1 轮审查复现', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  it('A. 新建态粘贴 → 切到会话态再粘贴：两次附件都叫 pasted-text-1.txt（同一会话 → LOCAL 同名覆盖）', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp(PanelLike)
    app.use(createPinia())
    const vm = app.mount(container) as any
    await flush()

    const chips = () => Array.from(container.querySelectorAll('.pending-file .file-name')).map((n) => n.textContent)

    pasteText(container.querySelector('.ProseMirror')!, '1'.repeat(2500))
    await flush()
    expect(chips()).toEqual(['pasted-text-1.txt']) // 新建态：第一次粘贴

    vm.setNewTask(false) // 发送后会话创建：ChatPanel 切到 docked 分支，centered 输入框卸载
    await flush(60)
    expect(chips()).toEqual([]) // 旧实例已销毁

    pasteText(container.querySelector('.ProseMirror')!, '2'.repeat(2500))
    await flush()
    expect(chips()).toEqual(['pasted-text-1.txt']) // 序号回退 → 与第一次同名
  })

  it('C1. 对照·CLOUD 模式：≥2000 字符转 pasted-text-1.txt，编辑器不插入文本', async () => {
    const { container, chips } = mount(ChatInput, { executionMode: 'CLOUD' })
    await flush()
    const pm = container.querySelector('.ProseMirror') as HTMLElement
    pasteText(pm, '1'.repeat(2500))
    await flush()
    expect(chips()).toEqual(['pasted-text-1.txt'])
    expect(pm.textContent ?? '').not.toContain('1111111111')
  })

  it('C2. 对照·短文本仍进编辑器', async () => {
    const { container } = mount(ChatInput, { executionMode: 'CLOUD' })
    await flush()
    const pm = container.querySelector('.ProseMirror') as HTMLElement
    pasteText(pm, 'short text')
    await flush()
    expect(pm.textContent).toContain('short text')
  })

  it('C3. 对照·附件位已满（10 个）时再粘贴长文本：回落插入编辑器，不吞文本', async () => {
    const { container, chips } = mount(ChatInput, { executionMode: 'CLOUD' })
    await flush()
    const pm = container.querySelector('.ProseMirror') as HTMLElement
    for (let i = 0; i < 10; i++) {
      pasteText(pm, `${i}`.repeat(2500))
      await flush(15)
    }
    expect(chips().length).toBe(10)
    pasteText(pm, 'y'.repeat(2500))
    await flush()
    expect(chips().length).toBe(10)
    expect(pm.textContent ?? '').toContain('yyyyyyyyyy')
  })
})
