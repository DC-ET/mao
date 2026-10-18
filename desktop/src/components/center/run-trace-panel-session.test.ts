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
import type { RunTrace, TraceRound } from '../../types/trace'

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
    traceThresholds: { slowMs: 60_000, expensiveCost: 0.5 },
    getTraceRuns: (): RunTrace[] => [],
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
  CircleCheck: { render: () => null },
  CircleClose: { render: () => null },
  WarningFilled: { render: () => null },
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
    // 事件（onClick 等）与 class 存进 props：测试按 class 找元素、再触发点击
    patchProp: (el: StubEl, key: string, _prev: unknown, next: unknown) => { el.props[key] = next },
  }
}

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) { await Promise.resolve(); await nextTick() }
}

function collectText(node: StubNode | null): string {
  if (node == null) return ''
  if ('text' in node) return node.text
  return node.children.map((child) => collectText(child)).join(' ')
}

/** 压平空白：插值的静态段与动态段是相邻文本节点，join 后有多余空格 */
function flatText(root: StubEl): string {
  return collectText(root).replace(/\s+/g, ' ')
}

function findAllByClass(node: StubNode | null, cls: string): StubEl[] {
  if (node == null || 'text' in node) return []
  const self = typeof node.props.class === 'string' && node.props.class.split(' ').includes(cls) ? [node] : []
  return [...self, ...node.children.flatMap((child) => findAllByClass(child, cls))]
}

async function mountPanel(sessionId = '11'): Promise<StubEl> {
  const Host = defineComponent({
    render: () => h(ClientPanel as never, { sessionId } as never),
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

function makeTraceRound(overrides: Partial<TraceRound> = {}): TraceRound {
  return {
    seq: 1,
    modelName: 'step-5',
    scene: 'agent',
    createdAt: '2026-10-10 09:03:00',
    durationMs: 4200,
    firstTokenMs: 800,
    retryCount: 0,
    success: true,
    interrupted: false,
    errorMessage: null,
    promptTokens: 1000,
    completionTokens: 200,
    cachedTokens: 300,
    cacheCreationTokens: 40,
    costMicros: 2_500_000,
    slow: false,
    expensive: false,
    tools: [],
    ...overrides,
  }
}

function makeTraceRun(overrides: Partial<RunTrace> = {}): RunTrace {
  return {
    runId: 11,
    userMessagePreview: '提交推送',
    startedAt: '2026-10-10 16:25:00',
    segments: [{ kind: 'current', rounds: [makeTraceRound()], unplacedTools: [] }],
    sideCalls: [],
    subagentLinks: [],
    markers: [],
    totals: {
      wallClockMs: 60_000,
      costMicros: 2_500_000,
      promptTokens: 1000,
      completionTokens: 200,
      cachedTokens: 300,
      cacheCreationTokens: 40,
      toolSuccess: 3,
      toolError: 0,
    },
    ...overrides,
  }
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

// 轨迹展示回归：L0 总览先回答「整体怎么样」；关注点徽标平铺不收起；
// 轮级重试是彩色徽标——run 徽标与轮次读同一份 retryCount，出现「重试」徽标
// 就必须能在展开后指到具体哪一轮（曾只有指标行里一行灰色小字，用户找不到）。
describe('RunTracePanel 轨迹展示', () => {
  const runs: RunTrace[] = [
    makeTraceRun(),
    makeTraceRun({
      runId: 12,
      userMessagePreview: '那为什么我的微信收到了你的测试消息',
      startedAt: '2026-10-10 09:03:00',
      segments: [
        {
          kind: 'current',
          rounds: [
            makeTraceRound({ seq: 1, retryCount: 2, slow: true, durationMs: 90_000 }),
            makeTraceRound({ seq: 2, success: false, errorMessage: 'boom' }),
          ],
          unplacedTools: [],
        },
      ],
      totals: {
        wallClockMs: 30_000,
        costMicros: 1_500_000,
        promptTokens: 500,
        completionTokens: 100,
        cachedTokens: 0,
        cacheCreationTokens: 0,
        toolSuccess: 1,
        toolError: 1,
      },
    }),
  ]

  beforeEach(() => {
    store = { ...makeStore(), getTraceRuns: () => runs }
  })

  it('L0 总览渲染任务数、成败分布、总耗时 / token / 成本与工具成功率', async () => {
    const text = flatText(await mountPanel())
    expect(text).toContain('最近 2 次任务')
    expect(text).toContain('1 成功')
    expect(text).toContain('1 失败')
    expect(text).toContain('总耗时 1m 30s')
    expect(text).toContain('1,800 tokens')
    expect(text).toContain('总成本 4')
    expect(text).toContain('工具成功率 80%')
  })

  it('run 行展示开始时间，关注点徽标平铺、不做 +N 收拢', async () => {
    const text = flatText(await mountPanel())
    expect(text).toContain('16:25')
    expect(text).toContain('09:03')
    expect(text).toContain('重试')
    expect(text).toContain('慢')
    expect(text).not.toContain('收起')
    expect(text).not.toContain('+2')
  })

  it('展开后轮级重试是彩色徽标，能指到具体是哪一轮', async () => {
    const root = await mountPanel()
    // 第二条 run（失败的）展开明细
    const summaries = findAllByClass(root, 'run-summary')
    expect(summaries).toHaveLength(2)
    const onClick = summaries[1]!.props.onClick
    expect(typeof onClick).toBe('function')
    ;(onClick as () => void)()
    await flush()
    const text = flatText(root)
    expect(text).toContain('重试 2')
    expect(text).toContain('失败')
    expect(text).toContain('boom')
  })
})
