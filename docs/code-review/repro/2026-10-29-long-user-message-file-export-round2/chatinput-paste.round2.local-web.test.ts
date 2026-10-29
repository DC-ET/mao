// @vitest-environment jsdom
/**
 * 第 2 轮审查复现脚本（vitest + jsdom）——复核第 1 轮问题 2 的修复：
 * LOCAL 模式 + 非 Electron 客户端（浏览器）粘贴超长文本不再被吞：
 * 不生成附件、不 preventDefault，文本回落插入编辑器（与附件位已满分支同口径）。
 *
 * 说明：ChatInput 的 isElectronClient 是模块级常量，本文件必须独立进程运行，且不得设置 window.electronAPI。
 * 运行方式见同目录 README.md。
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

describe('LOCAL + 非 Electron：长文本不再被吞（第 2 轮复核）', () => {
  it('浏览器端 LOCAL 模式粘贴 2500 字符：不生成附件、不拦截粘贴，文本插入编辑器', async () => {
    expect(w.electronAPI).toBeUndefined() // 前提：非 Electron

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
    const inserted = (pm.textContent ?? '').includes('1111111111')
    console.log('[round2] chips =', chips, '| 文本已插入编辑器 =', inserted, '| defaultPrevented =', ev.defaultPrevented)
    expect(chips).toEqual([]) // 不生成附件（本地模式不支持）
    expect(inserted).toBe(true) // 文本不丢（回落 TipTap/ProseMirror 默认粘贴；event.defaultPrevented 由 ProseMirror 内部置位，不代表本层拦截）
  })
})
