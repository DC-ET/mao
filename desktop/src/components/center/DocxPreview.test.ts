// @vitest-environment jsdom
// DocxPreview 接线回归（技术方案 §5.6 / §9）：mammoth 输出经主链同款 DOMPurify
// 消毒后进 v-html（全方案唯一 v-html，F1）、字节上限降级、解析失败降级、
// toArrayBuffer 视图边界、加载代际守卫。mammoth 走 mock（state 挂 mock 模块
// 自身，跨 SFC 动态 import 边界保持同一份对象）；DOMPurify 用真实模块——被
// 验的正是它剥危险标签。
import { readFileSync } from 'node:fs'
import { join as pathJoin } from 'node:path'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as Vue from 'vue'
import { h, nextTick, ref, isRef, defineComponent, createRenderer, type Ref } from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { compile } from '@vue/compiler-dom'

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useSSRContext: () => ({ modules: new Set(), scopeId: null, styles: '' }),
  }
})

vi.mock('@element-plus/icons-vue', () => ({
  Refresh: { render: () => null },
  Download: { render: () => null },
}))

// ---- mammoth mock：convertToHtml 行为由 mock 内 state 注入 ----
interface MammothMockState {
  args: Array<{ arrayBuffer: ArrayBuffer }>
  result: { value: string; messages: unknown[] } | null
  error: Error | null
  /** 置 true 时 convertToHtml 挂起，resolvers 逐个放行（过期响应守卫用） */
  defer: boolean
  resolvers: Array<() => void>
}

vi.mock('mammoth', () => {
  const state: MammothMockState = {
    args: [],
    result: null,
    error: null,
    defer: false,
    resolvers: [],
  }
  const mammoth = {
    convertToHtml: async (input: { arrayBuffer: ArrayBuffer }) => {
      state.args.push(input)
      if (state.error) throw state.error
      if (state.defer) {
        await new Promise<void>((resolve) => {
          state.resolvers.push(resolve)
        })
      }
      return state.result ?? { value: '', messages: [] }
    },
  }
  return { default: mammoth, __mockState: state }
})

import * as mammothMock from 'mammoth'
const mammothState = (mammothMock as unknown as { __mockState: MammothMockState }).__mockState

// DOMPurify / externalLink 不 mock——被接线的正是它们（jsdom 环境真实可用）
import DocxPreview from './DocxPreview.vue'

// jsdom 环境下 import.meta.url 是 http scheme，readFileSync 只吃 file:——按 cwd 拼路径
const sfcPath = pathJoin(process.cwd(), 'src/components/center/DocxPreview.vue')
const descriptor = parse(readFileSync(sfcPath, 'utf8')).descriptor
const script = compileScript(descriptor, { id: 'docx-preview' })
const compiled = compile(descriptor.template!.content, {
  mode: 'function',
  prefixIdentifiers: true,
  bindingMetadata: script.bindings,
})
const clientRender = new Function('Vue', compiled.code)(Vue) as (ctx: unknown, cache: unknown) => unknown

const ClientDocx = {
  ...(DocxPreview as object),
  render: clientRender,
}

interface StubEl { tag: string; children: StubNode[]; parent: StubEl | null; props: Record<string, unknown>; style: Record<string, string> }
type StubNode = StubEl | { text: string; parent: StubEl | null }

function nodeOps() {
  const createElement = (tag: string): StubEl => ({ tag, children: [], parent: null, props: {}, style: {} })
  const createText = (text: string): StubNode => ({ text, parent: null })
  return {
    createElement,
    createText,
    createComment: () => createText(''),
    setText: (n: StubNode, t: string) => { if ('text' in n) n.text = String(t) },
    setElementText: (el: StubEl, t: string) => { el.children = [{ text: t, parent: el }] },
    insert: (child: StubNode, parent: StubEl, anchor?: StubNode | null) => {
      child.parent = parent
      const at = anchor == null ? -1 : parent.children.indexOf(anchor)
      if (at < 0) parent.children.push(child)
      else parent.children.splice(at, 0, child)
    },
    remove: (child: StubNode) => {
      const p = child.parent
      if (p && !('text' in child)) {
        const i = p.children.indexOf(child)
        if (i >= 0) p.children.splice(i, 1)
      }
      child.parent = null
    },
    parentNode: (n: StubNode) => n.parent ?? null,
    nextSibling: (n: StubNode) => {
      const p = n.parent
      if (!p) return null
      return p.children[p.children.indexOf(n) + 1] ?? null
    },
    querySelector: () => null,
    setScopeId: () => {},
    cloneNode: (el: StubEl) => el,
    insertStaticContent: () => [createElement('static-start'), createElement('static-end')] as [StubEl, StubEl],
    patchProp: (el: StubEl, key: string, _prev: unknown, next: unknown) => { el.props[key] = next },
  }
}

// mammoth 动态 import 经 vitest 模块运行时加载，纯微任务 flush 等不到：
// 每轮补一个 setTimeout(0) 宏任务让位（同 ArchiveBrowser / SpreadsheetView 用例）
async function flush(rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function collectText(node: StubNode | null): string {
  if (node == null) return ''
  if ('text' in node) return node.text
  return node.children.map((child) => collectText(child)).join(' ')
}

function flatText(root: StubEl): string {
  return collectText(root).replace(/\s+/g, ' ')
}

function findAll(node: StubNode | null, pred: (el: StubEl) => boolean): StubEl[] {
  if (node == null || 'text' in node) return []
  const self = pred(node) ? [node] : []
  return [...self, ...node.children.flatMap((child) => findAll(child, pred))]
}

function byClass(cls: string) {
  return (el: StubEl) => typeof el.props.class === 'string' && el.props.class.split(' ').includes(cls)
}

function click(el: StubEl) {
  ;(el.props.onClick as (() => void) | undefined)?.()
}

async function mountDocx(
  bytes: Uint8Array | Ref<Uint8Array>,
  provider: Record<string, unknown> | null = null,
): Promise<StubEl> {
  const bytesRef = isRef(bytes) ? bytes : ref(bytes)
  const Host = defineComponent({
    render: () => h(ClientDocx as never, { filePath: 'spec.docx', bytes: bytesRef.value, provider } as never),
  })
  const ops = nodeOps()
  const { createApp } = createRenderer(ops)
  const root = ops.createElement('root')
  const app = createApp(Host)
  const errors: unknown[] = []
  app.config.warnHandler = () => {}
  app.config.errorHandler = (err) => { errors.push(err) }
  app.mount(root as never)
  if (errors.length) throw errors[0]
  await flush()
  return root
}

describe('DocxPreview 解析与消毒', () => {
  beforeEach(() => {
    mammothState.args.length = 0
    mammothState.result = null
    mammothState.error = null
    mammothState.defer = false
    mammothState.resolvers.length = 0
  })

  it('解析成功：mammoth 输出经 DOMPurify 后进 v-html，工具条显示文件名', async () => {
    mammothState.result = {
      value: '<h1>季度报告</h1><p>正文<strong>加粗</strong></p>',
      messages: [],
    }
    const root = await mountDocx(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))

    expect(mammothState.args).toHaveLength(1)
    expect(flatText(root)).toContain('spec.docx')
    const body = findAll(root, byClass('markdown-body'))[0]
    expect(body).toBeDefined()
    expect(body.props.innerHTML).toContain('<h1>季度报告</h1>')
    expect(body.props.innerHTML).toContain('<strong>加粗</strong>')
  })

  it('安全：mammoth 输出里的 script / 事件属性被 DOMPurify 剥掉（F1 唯一 v-html）', async () => {
    mammothState.result = {
      value:
        '<h1 onclick="alert(1)">标题</h1><p>ok</p><script>alert(2)</script>' +
        '<a href="javascript:alert(3)">坏链</a><a href="https://mao.etarch.cn">好链</a>',
      messages: [],
    }
    const root = await mountDocx(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))

    const html = findAll(root, byClass('markdown-body'))[0].props.innerHTML as string
    expect(html).toContain('<h1>标题</h1>')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('href="https://mao.etarch.cn"')
  })

  it('toArrayBuffer 视图边界：bytes 是底层 buffer 的一段时，mammoth 收到按视图裁出的完整内容', async () => {
    mammothState.result = { value: '<p>x</p>', messages: [] }
    // 底层 16 字节 buffer，视图只取中段 8 字节（byteOffset=4）
    const backing = new Uint8Array(16)
    backing.set([0x50, 0x4b, 0x03, 0x04, 0x41, 0x42, 0x43, 0x44], 4)
    const view = backing.subarray(4, 12)
    await mountDocx(view)

    const received = mammothState.args[0].arrayBuffer
    expect(received.byteLength).toBe(8)
    expect(Array.from(new Uint8Array(received))).toEqual([0x50, 0x4b, 0x03, 0x04, 0x41, 0x42, 0x43, 0x44])
  })

  it('文件超 10MB：字节上限先行，不进 mammoth，降级「文档过大」', async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1)
    const root = await mountDocx(big)
    expect(mammothState.args).toHaveLength(0)
    expect(flatText(root)).toContain('文档过大，请下载后查看')
    expect(findAll(root, byClass('markdown-body'))).toHaveLength(0)
  })

  it('LOCAL 超上限（无 downloadFile）：降级态给「在 Finder 中显示」出口，不是死路（review round1 #5）', async () => {
    const shown: string[] = []
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
      showItemInFolder: (p: string) => { shown.push(p) },
    }
    try {
      const provider = { getAbsolutePath: (p: string) => `/Users/u/work/${p}` }
      const root = await mountDocx(new Uint8Array(10 * 1024 * 1024 + 1), provider)

      expect(flatText(root)).toContain('文档过大，请下载后查看')
      const finderBtn = findAll(root, byClass('retry-btn')).find((el) => collectText(el).includes('在 Finder 中显示'))
      expect(finderBtn).toBeDefined()
      click(finderBtn!)
      await flush()
      expect(shown).toEqual(['/Users/u/work/spec.docx'])
    } finally {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI
    }
  })

  it('mammoth 解析失败：错误态展示原因，提供下载出口', async () => {
    mammothState.error = new Error('Could not find file in zip')
    const downloadCalls: string[] = []
    const provider = {
      downloadFile: async (path: string, name: string) => {
        downloadCalls.push(`${path}:${name}`)
        return { ok: true }
      },
    }
    const root = await mountDocx(new Uint8Array([1, 2, 3]), provider)
    expect(flatText(root)).toContain('Could not find file in zip')
    const dlBtn = findAll(root, byClass('retry-btn'))[0]
    expect(dlBtn).toBeDefined()
    click(dlBtn)
    await flush()
    expect(downloadCalls).toEqual(['spec.docx:spec.docx'])
  })

  it('刷新按钮：emit refresh 交回 FileViewer 重走 dispatch，不在本地重解析同一份字节（round2 #2 / §5.8）', async () => {
    mammothState.result = { value: '<p>x</p>', messages: [] }
    const refreshes: number[] = []
    const Host = defineComponent({
      emits: ['refresh'],
      render() {
        return h(ClientDocx as never, {
          filePath: 'spec.docx',
          bytes: new Uint8Array([1]),
          provider: null,
          onRefresh: () => refreshes.push(1),
        } as never)
      },
    })
    const ops = nodeOps()
    const { createApp } = createRenderer(ops)
    const root = ops.createElement('root')
    const app = createApp(Host)
    const errors: unknown[] = []
    app.config.warnHandler = () => {}
    app.config.errorHandler = (err) => { errors.push(err) }
    app.mount(root as never)
    if (errors.length) throw errors[0]
    await flush()
    expect(mammothState.args).toHaveLength(1)

    const refreshBtn = findAll(root, byClass('tool-btn')).find((el) => el.props.title === '刷新')
    expect(refreshBtn).toBeDefined()
    click(refreshBtn!)
    await flush()

    expect(refreshes).toEqual([1])
    expect(mammothState.args).toHaveLength(1)
  })

  it('过期响应守卫：旧 bytes 的迟到解析不覆盖新文件内容（A2）', async () => {
    mammothState.defer = true
    mammothState.result = { value: '<p>old</p>', messages: [] }
    const bytesRef = ref(new Uint8Array([1]))
    const root = await mountDocx(bytesRef)
    // 第一个 convertToHtml 已挂起；切到新 bytes 触发第二次
    mammothState.result = { value: '<p>new</p>', messages: [] }
    bytesRef.value = new Uint8Array([2])
    await flush()
    expect(mammothState.resolvers).toHaveLength(2)

    // 先放行新请求（后发起），再放行迟到的旧请求
    mammothState.resolvers[1]()
    await flush()
    mammothState.result = { value: '<p>stale</p>', messages: [] }
    mammothState.resolvers[0]()
    await flush()

    const body = findAll(root, byClass('markdown-body'))[0]
    expect(body.props.innerHTML).toContain('<p>new</p>')
    expect(body.props.innerHTML).not.toContain('stale')
  })
})
