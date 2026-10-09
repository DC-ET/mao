// 跨会话打开轨迹 Tab 必须按新会话重新拉取：轨迹 Tab 每会话同 id（'trace'），
// CenterTabContainer 的 key 若不含会话维度，KeepAlive 会复用同一实例（只触发
// props 变化 / onActivated），界面留着上一个会话的数据或显示误导性的「暂无轨迹」。
// 覆盖：key 带会话维度（防复用）+ props.sessionId 变化时自己重拉（双保险）。
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as Vue from 'vue'
import { h, nextTick, ref, defineComponent, createRenderer } from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { compile } from '@vue/compiler-dom'

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useSSRContext: () => ({ modules: new Set(), scopeId: null, styles: '' }),
  }
})

const traceCalls: string[] = []

vi.mock('../../api', () => ({
  api: {
    get: async (url: string) => {
      traceCalls.push(url)
      return { data: { runs: [], hasMore: false, unattributed: null } }
    },
  },
}))

function makeStore() {
  return {
    traceThresholds: { slowMs: 60_000, expensiveTokens: 50_000 },
    getTraceRuns: () => [],
    getTraceHasMore: () => false,
    getTraceUnattributed: () => null,
    isTraceLoading: () => false,
    setTraceLoading: vi.fn(),
    setTracePage: vi.fn(),
    appendTracePage: vi.fn(),
    setTraceThresholds: vi.fn(),
    getSessionPhase: () => 'IDLE',
    getLiveExecutionId: () => null,
    getLiveRound: () => null,
    getLiveTools: () => [],
  }
}

let store = makeStore()

vi.mock('../../stores/session', () => ({
  useSessionStore: () => store,
}))

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
  ElTooltip: defineComponent({ render() { return h('div', this.$slots.default?.() ?? []) } }),
  ElInputNumber: defineComponent({
    props: { modelValue: { type: Number, default: 0 } },
    emits: ['update:modelValue', 'change'],
    render() { return h('input', { type: 'number', value: this.modelValue }) },
  }),
}))

vi.mock('@element-plus/icons-vue', () => ({
  ArrowDown: { render: () => null },
  ArrowRight: { render: () => null },
  InfoFilled: { render: () => null },
  TrendCharts: { render: () => null },
}))

vi.mock('../../utils/toolDisplay', () => ({ getToolDisplayName: (n: string) => n }))
vi.mock('../../utils/llmCallLabels', () => ({ llmCallSceneLabel: (s: string) => s }))
vi.mock('../../utils/trace-export', () => ({
  downloadTraceCsv: vi.fn(),
  downloadTraceJson: vi.fn(),
}))

import RunTracePanel from './RunTracePanel.vue'

const descriptor = parse(readFileSync(new URL('./RunTracePanel.vue', import.meta.url), 'utf8')).descriptor
const script = compileScript(descriptor, { id: 'trace-panel-session' })
const compiled = compile(descriptor.template!.content, {
  mode: 'function',
  prefixIdentifiers: true,
  bindingMetadata: script.bindings,
})
const clientRender = new Function('Vue', compiled.code)(Vue) as (ctx: unknown, cache: unknown) => unknown

const ElIconStub = defineComponent({ render() { return h('i', this.$slots.default?.() ?? []) } })
const ClientPanel = {
  ...(RunTracePanel as object),
  components: { 'el-icon': ElIconStub, ElIcon: ElIconStub },
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
    insertStaticContent: () => [createElement('static-start'), createElement('static-end')] as [StubEl, StubEl],
    patchProp: () => {},
  }
}

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) { await Promise.resolve(); await nextTick() }
}

describe('RunTracePanel 跨会话重拉', () => {
  beforeEach(() => {
    traceCalls.length = 0
    store = makeStore()
  })

  it('props.sessionId 变化后按新会话重新拉取（实例被跨会话复用时不留旧数据）', async () => {
    const sessionId = ref('11')
    const Host = defineComponent({
      render: () => h(ClientPanel as never, { sessionId: sessionId.value } as never),
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
    expect(traceCalls).toEqual(['/sessions/11/trace'])

    // 会话 A → B：KeepAlive 复用同一实例（不重挂载），面板必须自己重拉
    sessionId.value = '12'
    await flush()
    expect(traceCalls).toEqual(['/sessions/11/trace', '/sessions/12/trace'])
  })

  it('CenterTabContainer 给 RunTracePanel 的 key 含会话维度', () => {
    const source = readFileSync(new URL('./CenterTabContainer.vue', import.meta.url), 'utf8')
    const block = source.slice(source.indexOf('<RunTracePanel'), source.indexOf('</KeepAlive>'))
    // key 必须由会话 id 决定，不能是每个会话都一样的 activeTabId（'trace'）
    expect(block).toContain('props.sessionId')
    expect(block).not.toMatch(/:key="activeTabId"/)
  })
})
