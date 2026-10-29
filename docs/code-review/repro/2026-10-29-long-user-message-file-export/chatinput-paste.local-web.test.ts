// @vitest-environment jsdom
/**
 * 第 1 轮审查复现脚本（vitest + jsdom）——问题 2：LOCAL 模式 + 非 Electron 客户端（浏览器）
 * 粘贴超长文本时，ChatInput 先 preventDefault 再被 addPendingFile 拒收 → 文本既没进附件也没进编辑器。
 *
 * 说明：ChatInput 的 isElectronClient 是模块级常量，因此本文件必须独立运行（不能与
 * chatinput-paste.behavior.test.ts 共享进程），且不得设置 window.electronAPI。
 *
 * 运行（见同目录 README.md）。
 */
import { describe, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  get: vi.fn(async () => ({ data: { skills: [], commands: [] } })),
  post: vi.fn(async () => ({ data: {} })),
  getUploadConfig: vi.fn(async () => ({ storageMode: 'oss', baseUrl: '', maxSizeMb: 50 })),
}))
vi.mock('../src/api', () => ({ api: { get: mocks.get, post: mocks.post, put: mocks.post, delete: mocks.post } }))
vi.mock('../src/utils/storageMode', () => ({ getUploadConfig: mocks.getUploadConfig }))

import ChatInput from '../src/components/chat/ChatInput.vue'

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

function pasteText(dom: Element, text: string) {
  const clipboardData = { items: [] as unknown[], getData: (t: string) => (t === 'text/plain' ? text : '') }
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: clipboardData })
  dom.dispatchEvent(event)
  return event
}
const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms))

describe('LOCAL + 非 Electron：长文本粘贴被吞', () => {
  it('浏览器端 LOCAL 模式粘贴 2500 字符：附件 0 个、编辑器 0 字符、默认粘贴被阻止', async () => {
    // 断言前提：本进程没有 electronAPI（ChatInput 的 isElectronClient=false）
    expect(w.electronAPI).toBeUndefined()

    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({ render: () => h(ChatInput, { draftKey: null, executionMode: 'LOCAL' }) })
    app.use(createPinia())
    app.mount(container)
    await flush()

    const pm = container.querySelector('.ProseMirror') as HTMLElement
    const ev = pasteText(pm, '1'.repeat(2500))
    await flush()

    const chips = Array.from(container.querySelectorAll('.pending-file .file-name')).map((n) => n.textContent)
    expect(chips).toEqual([]) // 没进待发附件（addPendingFile 因「本地模式不支持文件上传」拒收）
    expect(pm.textContent ?? '').toBe('') // 也没进编辑器（event.preventDefault 已把默认粘贴挡掉）
    expect(ev.defaultPrevented).toBe(true)
  })
})
