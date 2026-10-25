// 记录详情抽屉（技术方案 2026-10-22-run-trace-deep-dive §5.6 与
// 2026-10-25-run-trace-content-and-prompt §5.6）的行为回归。
// 桌面 vitest 是 node 环境、无 DOM：挂载 SFC 走「vi.mock('vue' useSSRContext) +
// compileScript / compile + new Function('Vue', compiled.code) + 自绘 nodeOps」三件套
// （与 run-trace-panel-session.test.ts 同一套手法）。
//
// 覆盖：打开时发一次请求；缓存命中不重复请求；target 变化（轮次抽屉点「本轮工具」跳
// 工具抽屉 / 消息抽屉）必须重新拉取并复位 tab——抽屉实例被父组件复用，onMounted 不会再跑；
// 回复 tab 的两种空态；消息抽屉的多模态合并与不存在态。
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as Vue from 'vue'
import { defineComponent, h, nextTick, ref, createRenderer } from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { compile } from '@vue/compiler-dom'
import type { TraceCallRecord, TraceDrawerTarget, TraceLoadedRecord, TraceMessageRecord, TraceToolRecord } from '../../types/trace'

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useSSRContext: () => ({ modules: new Set(), scopeId: null, styles: '' }),
  }
})

const requests: string[] = []
const toolRecord: TraceToolRecord = {
  toolCallId: 'call_1',
  toolName: 'read_file',
  argumentsJson: '{"path":"a.txt"}',
  resultContent: '文件内容',
  resultMetadata: null,
  call: null,
}
const callRecord: TraceCallRecord = {
  call: {
    llmCallId: 101, provider: 'anthropic', protocol: 'openai', stream: true, effort: 'medium',
    scene: 'agent', modelName: 'step-5', retryCount: 0, firstTokenMs: 800, durationMs: 4200,
    errorMessage: null, promptTokens: 1000, completionTokens: 200, cachedTokens: 300,
    cacheCreationTokens: 40, costMicros: 2_500_000, createdAt: '2026-10-10 09:03:00',
    systemPrompt: '你是运维助手', toolsJson: '["read_file","shell"]',
  },
  tools: [{ toolCallId: 'call_1', name: 'read_file', target: 'a.txt' }],
  messages: [{
    messageId: 55, content: '# 标题\n\n正文内容', thinkingContent: '先看目录结构',
    tokenCount: 88, createdAt: '2026-10-10 09:03:02',
  }],
}
// 时钟缺失的轮次：created_at 为 null → 回复 tab 显示「暂无法定位」而非「未落库」
const callRecordNoClock: TraceCallRecord = {
  call: {
    llmCallId: 102, provider: null, protocol: null, stream: false, effort: null,
    scene: 'agent', modelName: null, retryCount: 0, firstTokenMs: null, durationMs: 0,
    errorMessage: null, promptTokens: 0, completionTokens: 0, cachedTokens: 0,
    cacheCreationTokens: 0, costMicros: null, createdAt: null,
    systemPrompt: null, toolsJson: null,
  },
  tools: [],
  messages: [],
}
const messageRecord: TraceMessageRecord = {
  messageId: 55, role: 'USER', tokenCount: 120,
  createdAt: '2026-10-10 09:00:00', updatedAt: '2026-10-10 09:05:00', edited: true,
  content: JSON.stringify([
    { type: 'text', text: '看看这个文件' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,y' } },
  ]),
  thinkingContent: null,
}
const messageRecordPlain: TraceMessageRecord = {
  messageId: 56, role: 'USER', content: '普通文本消息', thinkingContent: null, tokenCount: 6,
  createdAt: '2026-10-10 09:01:00', updatedAt: '2026-10-10 09:01:00', edited: false,
}
const messageRecordMissing: TraceMessageRecord = {
  messageId: 404, role: null, content: null, thinkingContent: null, tokenCount: null,
  createdAt: null, updatedAt: null, edited: false,
}

vi.mock('../../api', () => ({
  api: {
    get: async (url: string) => {
      requests.push(url)
      if (url.endsWith('/call/101')) return { data: callRecord }
      if (url.endsWith('/call/102')) return { data: callRecordNoClock }
      if (url.endsWith('/message/55')) return { data: messageRecord }
      if (url.endsWith('/message/56')) return { data: messageRecordPlain }
      if (url.endsWith('/message/404')) return { data: messageRecordMissing }
      // call_2 故意返回慢一点，让测试能在「加载中」态切换 target
      if (url.endsWith('/tool/call_2')) {
        await new Promise((r) => setTimeout(r, 20))
        return { data: { ...toolRecord, toolCallId: 'call_2' } }
      }
      return { data: toolRecord }
    },
  },
}))

/** 抽屉的缓存行为：第二参命中直接渲染，不发请求 */
const cache = new Map<string, TraceLoadedRecord>()
const store = {
  getTraceRecord: (_sessionId: string, key: string): TraceLoadedRecord | null => cache.get(key) ?? null,
  setTraceRecord: (_sessionId: string, key: string, record: TraceLoadedRecord) => { cache.set(key, record) },
}

vi.mock('../../stores/session', () => ({ useSessionStore: () => store }))
vi.mock('../../utils/toolDisplay', () => ({ getToolDisplayName: (n: string) => n }))
vi.mock('../../utils/llmCallLabels', () => ({ llmCallSceneLabel: (s: string) => s }))

// 两个子组件同样是 script setup import 绑定（$setup.JsonText），mock 模块替换。
// 这里只验抽屉自己的编排（tab / 空态 / 跳转），JSON 展示与元信息表格由各自组件覆盖。
vi.mock('./RunTraceRecordJsonText.vue', () => ({
  default: defineComponent({
    props: { raw: { type: String, default: null }, emptyText: { type: String, default: '' } },
    render() { return h('pre', { class: 'json-text-stub' }, this.raw ?? this.emptyText) },
  }),
}))
vi.mock('./RunTraceCallMetaTable.vue', () => ({
  default: defineComponent({
    props: { call: { type: Object, required: true } },
    render() {
      const call = this.call as { llmCallId: number | null }
      return h('div', { class: 'call-meta-stub' }, `meta:#${call.llmCallId}`)
    },
  }),
}))
vi.mock('./RunTraceCallPrompt.vue', () => ({
  default: defineComponent({
    props: { call: { type: Object, required: true } },
    render() {
      const call = this.call as { systemPrompt: string | null; toolsJson: string | null }
      return h('div', { class: 'call-prompt-stub' }, `prompt:${call.systemPrompt ?? 'null'}|tools:${call.toolsJson ?? 'null'}`)
    },
  }),
}))
vi.mock('./RunTraceRecordReply.vue', () => ({
  default: defineComponent({
    props: { messages: { type: Array, required: true } },
    render() {
      const messages = this.messages as Array<{ messageId: number; content: string | null; thinkingContent: string | null }>
      return h(
        'div',
        { class: 'round-reply-stub' },
        messages.map((m) => h('p', { class: 'reply-stub-msg', key: m.messageId }, `reply:${m.messageId}:${m.content ?? ''}:${m.thinkingContent ?? ''}`)),
      )
    },
  }),
}))

import RunTraceRecordDrawer from './RunTraceRecordDrawer.vue'

const descriptor = parse(readFileSync(new URL('./RunTraceRecordDrawer.vue', import.meta.url), 'utf8')).descriptor
const script = compileScript(descriptor, { id: 'record-drawer' })
const compiled = compile(descriptor.template!.content, {
  mode: 'function',
  prefixIdentifiers: true,
  bindingMetadata: script.bindings,
})
const clientRender = new Function('Vue', compiled.code)(Vue) as (ctx: unknown, cache: unknown) => unknown

// node 环境没有 window：抽屉的 onMounted 要挂 keydown，注入一个最小实现并记录监听器，
// 让 Esc 分支可测（removeEventListener 也要有，卸载时不抛）。
const keydownListeners: Array<(e: KeyboardEvent) => void> = []
;(globalThis as { window?: unknown }).window = {
  addEventListener: (_type: string, fn: (e: KeyboardEvent) => void) => { keydownListeners.push(fn) },
  removeEventListener: (_type: string, fn: (e: KeyboardEvent) => void) => {
    const i = keydownListeners.indexOf(fn)
    if (i >= 0) keydownListeners.splice(i, 1)
  },
  setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
  clearTimeout: (id: unknown) => clearTimeout(id as never),
}

const ClientDrawer = {
  ...(RunTraceRecordDrawer as object),
  components: {},
  render: clientRender,
}

interface StubEl { tag: string; children: StubNode[]; parent: StubEl | null; props: Record<string, unknown> }
type StubNode = StubEl | { text: string; parent: StubEl | null }

function nodeOps() {
  const createElement = (tag: string): StubEl => ({ tag, children: [], parent: null, props: {} })
  const createText = (text: string): StubNode => ({ text, parent: null })
  return {
    createElement,
    createText,
    createComment: () => createText(''),
    setText: (n: StubNode, t: string) => { if ('text' in n) n.text = String(t) },
    setElementText: (el: StubEl, t: string) => { el.children = [{ text: t, parent: el }] },
    insert: (child: StubNode, parent: StubEl) => { child.parent = parent; parent.children.push(child) },
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
    insertStaticContent: () => [createElement('s1'), createElement('s2')] as [StubEl, StubEl],
    patchProp: (el: StubEl, key: string, _prev: unknown, next: unknown) => { el.props[key] = next },
  }
}

async function flush(rounds = 10) {
  for (let i = 0; i < rounds; i++) { await Promise.resolve(); await nextTick() }
}

function collectText(node: StubNode | null): string {
  if (node == null) return ''
  if ('text' in node) return node.text
  return node.children.map((child) => collectText(child)).join(' ')
}

function flatText(root: StubEl): string {
  return collectText(root).replace(/\s+/g, ' ')
}

function findAllByClass(node: StubNode | null, cls: string): StubEl[] {
  if (node == null || 'text' in node) return []
  const self = typeof node.props.class === 'string' && node.props.class.split(' ').includes(cls) ? [node] : []
  return [...self, ...node.children.flatMap((child) => findAllByClass(child, cls))]
}

/** 挂抽屉：target 可变（ref）——等价于父组件 openToolRecord 切 target */
async function mountDrawer(target: { value: TraceDrawerTarget }) {
  const Host = defineComponent({
    render: () => h(ClientDrawer as never, { sessionId: '11', target: target.value } as never),
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

/** ref 版挂载：target 用真 ref，父组件改 .value 会触发子组件 props 更新 */
async function mountDrawerRef(initial: TraceDrawerTarget) {
  const target = ref(initial)
  const root = await mountDrawer(target)
  return { root, target }
}

describe('RunTraceRecordDrawer', () => {
  beforeEach(() => {
    requests.length = 0
    cache.clear()
    keydownListeners.length = 0
  })

  it('打开工具抽屉只发一次 tool 请求，展示参数 / 结果 / 计时与元信息 / 请求构成四个 tab', async () => {
    const root = await mountDrawer({ value: { kind: 'tool', toolCallId: 'call_1' } })
    expect(requests).toEqual(['/sessions/11/trace/records/tool/call_1'])
    const tabs = findAllByClass(root, 'drawer-tab').map((t) => collectText(t))
    expect(tabs).toEqual(['参数', '结果', '计时与元信息', '请求构成'])
    // 默认落在「参数」
    expect(findAllByClass(root, 'drawer-tab')[0]!.props.class).toContain('active')
  })

  it('同 key 二次打开命中缓存，不重复请求', async () => {
    const target = { value: { kind: 'tool', toolCallId: 'call_1' } as TraceDrawerTarget }
    const root = await mountDrawer(target)
    expect(requests).toHaveLength(1)
    // 关闭再打开（重新挂载）：缓存命中，不再请求
    const Host = defineComponent({
      render: () => h(ClientDrawer as never, { sessionId: '11', target: target.value } as never),
    })
    const ops = nodeOps()
    const { createApp } = createRenderer(ops)
    const root2 = ops.createElement('root')
    const app = createApp(Host)
    app.config.warnHandler = () => {}
    app.mount(root2 as never)
    await flush()
    expect(requests).toHaveLength(1)
    expect(flatText(root2)).toContain('{"path":"a.txt"}')
    expect(flatText(root)).toContain('{"path":"a.txt"}')
  })

  it('轮次抽屉默认落在「回复」tab，思考与正文都在；「工具」tab 切过去能看到清单', async () => {
    const { root } = await mountDrawerRef({ kind: 'call', llmCallId: 101 })
    expect(requests).toEqual(['/sessions/11/trace/records/call/101'])
    expect(flatText(root)).toContain('轮次详情 #101')
    // 默认回复 tab：reply stub 展示消息 id + 正文 + 思考（flatText 已折叠空白）
    expect(flatText(root)).toContain('reply:55:# 标题 正文内容:先看目录结构')
    expect(findAllByClass(root, 'drawer-tab')[0]!.props.class).toContain('active')
    // 切到工具 tab
    ;(findAllByClass(root, 'drawer-tab')[1]!.props.onClick as () => void)()
    await flush()
    expect(flatText(root)).toContain('本轮工具（1）')
  })

  it('轮次抽屉的「请求构成」tab 把系统提示词与工具清单交给共用组件', async () => {
    const { root } = await mountDrawerRef({ kind: 'call', llmCallId: 101 })
    ;(findAllByClass(root, 'drawer-tab')[3]!.props.onClick as () => void)()
    await flush()
    expect(flatText(root)).toContain('prompt:你是运维助手|tools:["read_file","shell"]')
  })

  it('回复 tab 两种空态分开：时钟缺失 vs 未落库', async () => {
    // 时钟缺失：call.created_at 为 null → 「暂无法定位」
    const { root } = await mountDrawerRef({ kind: 'call', llmCallId: 102 })
    expect(flatText(root)).toContain('该轮回复暂无法定位（本轮调用缺少时间戳）')
    expect(flatText(root)).not.toContain('未落库')

    // 有时间戳但窗口内没有落库回复 → 「未落库（崩溃恢复 / 中断）」
    cache.set('call:101', { kind: 'call', data: { ...callRecord, messages: [] } })
    const target = { value: { kind: 'call', llmCallId: 101 } as TraceDrawerTarget }
    const root2 = await mountDrawer(target)
    expect(flatText(root2)).toContain('该轮回复未落库（崩溃恢复 / 中断）')
  })

  it('target 变化时重新拉取：轮次抽屉跳工具抽屉要换成工具记录并复位 tab', async () => {
    const { root, target } = await mountDrawerRef({ kind: 'call', llmCallId: 101 })
    expect(requests).toEqual(['/sessions/11/trace/records/call/101'])
    expect(flatText(root)).toContain('轮次详情 #101')

    // 父组件只改 target（v-if 是 null → 非 null，实例复用，onMounted 不会再跑）
    target.value = { kind: 'tool', toolCallId: 'call_1' }
    await flush()
    // 必须发出 tool 请求，且内容变成工具记录（参数 tab）
    expect(requests).toEqual(['/sessions/11/trace/records/call/101', '/sessions/11/trace/records/tool/call_1'])
    const text = flatText(root)
    expect(text).toContain('工具调用详情')
    expect(text).toContain('{"path":"a.txt"}')
    // tab 复位到「参数」：不复位会让用户拿着轮次的 tab 看工具记录
    expect(findAllByClass(root, 'drawer-tab')[0]!.props.class).toContain('active')
  })

  it('tab 可切换到「结果」与「计时与元信息」', async () => {
    const root = await mountDrawer({ value: { kind: 'tool', toolCallId: 'call_1' } })
    const tabs = findAllByClass(root, 'drawer-tab')
    ;(tabs[1]!.props.onClick as () => void)()
    await flush()
    expect(findAllByClass(root, 'json-text-stub')[0]).toBeTruthy()
    expect(flatText(root)).toContain('文件内容')
    ;(tabs[2]!.props.onClick as () => void)()
    await flush()
    // 未配对到调用记录：明确提示而不是空白
    expect(flatText(root)).toContain('未配对到模型调用记录')
  })

  it('工具抽屉未配对调用时「请求构成」tab 显示未配对提示', async () => {
    const root = await mountDrawer({ value: { kind: 'tool', toolCallId: 'call_1' } })
    ;(findAllByClass(root, 'drawer-tab')[3]!.props.onClick as () => void)()
    await flush()
    expect(flatText(root)).toContain('未配对到模型调用记录')
  })

  it('消息抽屉：多模态合并文本分片、显示附件计数与编辑标注', async () => {
    const root = await mountDrawer({ value: { kind: 'message', messageId: 55 } })
    expect(requests).toEqual(['/sessions/11/trace/records/message/55'])
    const text = flatText(root)
    expect(text).toContain('消息详情')
    expect(text).toContain('用户消息')
    expect(text).toContain('已编辑')
    expect(text).toContain('图片 ×2')
    expect(text).toContain('看看这个文件')
    expect(text).toContain('多模态原文 JSON')
  })

  it('消息抽屉：普通文本走 JsonText（非 JSON 原样展示）', async () => {
    const root = await mountDrawer({ value: { kind: 'message', messageId: 56 } })
    expect(requests).toEqual(['/sessions/11/trace/records/message/56'])
    expect(flatText(root)).toContain('普通文本消息')
    expect(flatText(root)).not.toContain('多模态原文 JSON')
  })

  it('消息抽屉：不存在的消息显示「记录不存在或已删除」', async () => {
    const root = await mountDrawer({ value: { kind: 'message', messageId: 404 } })
    expect(requests).toEqual(['/sessions/11/trace/records/message/404'])
    expect(flatText(root)).toContain('记录不存在或已删除')
  })

  it('从「要发请求的 target」切到「已缓存的 target」不卡在加载中', async () => {
    // 先把 call:101 加载进缓存
    await mountDrawer({ value: { kind: 'call', llmCallId: 101 } })
    expect(requests).toEqual(['/sessions/11/trace/records/call/101'])
    requests.length = 0

    // 新挂载，初始 target 是没缓存的 tool:call_2（要走网络），随后立刻切到已缓存的 call:101
    const { root, target } = await mountDrawerRef({ kind: 'tool', toolCallId: 'call_2' })
    expect(flatText(root)).toContain('加载中')
    target.value = { kind: 'call', llmCallId: 101 }
    await flush()
    // 缓存命中是同步路径：必须把 loading 收掉，否则「加载中…」永久留在抽屉里
    expect(flatText(root)).not.toContain('加载中')
    expect(flatText(root)).toContain('轮次详情 #101')
    expect(requests).toEqual(['/sessions/11/trace/records/tool/call_2'])
  })

  it('Esc / 遮罩 / × 三种方式都触发 close', async () => {
    const closed: string[] = []
    const Host = defineComponent({
      render: () => h(ClientDrawer as never, {
        sessionId: '11',
        target: { kind: 'tool', toolCallId: 'call_1' },
        onClose: () => closed.push('close'),
      } as never),
    })
    const ops = nodeOps()
    const { createApp } = createRenderer(ops)
    const root = ops.createElement('root')
    const app = createApp(Host)
    app.config.warnHandler = () => {}
    app.mount(root as never)
    await flush()
    expect(keydownListeners).toHaveLength(1)

    // Esc
    keydownListeners[0]!({ key: 'Escape', stopPropagation: () => {} } as unknown as KeyboardEvent)
    // 遮罩
    ;(findAllByClass(root, 'record-drawer-mask')[0]!.props.onClick as () => void)()
    // ×
    ;(findAllByClass(root, 'drawer-close')[0]!.props.onClick as () => void)()
    expect(closed).toHaveLength(3)
  })

  it('非 Esc 键不触发 close', async () => {
    const closed: string[] = []
    const Host = defineComponent({
      render: () => h(ClientDrawer as never, {
        sessionId: '11',
        target: { kind: 'tool', toolCallId: 'call_1' },
        onClose: () => closed.push('close'),
      } as never),
    })
    const ops = nodeOps()
    const { createApp } = createRenderer(ops)
    const root = ops.createElement('root')
    const app = createApp(Host)
    app.config.warnHandler = () => {}
    app.mount(root as never)
    await flush()
    keydownListeners[0]!({ key: 'a', stopPropagation: () => {} } as unknown as KeyboardEvent)
    expect(closed).toHaveLength(0)
  })
})
