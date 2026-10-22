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
import type { RunTrace, TraceRound, UnattributedGroup } from '../../types/trace'

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
    getTraceUnattributed: (): UnattributedGroup | null => null,
    isTraceLoading: () => false,
    setTraceLoading: vi.fn(),
    setTracePage: vi.fn(),
    appendTracePage: vi.fn(),
    setTraceThresholds: vi.fn(),
    getSessionPhase: () => 'IDLE',
    getLiveExecutionId: () => null,
    getLiveRound: () => null,
    getLiveTools: () => [],
    getTraceRecord: vi.fn((): unknown => null),
    setTraceRecord: vi.fn(),
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

// 条带与抽屉 stub：模板编译产物走 $setup.RunTraceTimeBand（script setup 的 import 绑定），
// 只能靠 mock 模块替换。本测试验面板的挂载点 / 传参 / 事件接线，子组件内部由各自用例覆盖。
const bandBars: Array<{ count: number; runId: number; activeRunKey: string | null }> = []
const drawerOpened: Array<{ kind: string; sessionId: string; target: unknown }> = []

vi.mock('./RunTraceTimeBand.vue', () => ({
  default: defineComponent({
    props: { run: { type: Object, required: true }, activeRunKey: { type: String, default: null } },
    emits: ['locate'],
    render() {
      const run = this.run as {
        runId: number
        segments: Array<{ rounds: Array<{ tools: unknown[] }>; unplacedTools: unknown[] }>
        sideCalls: unknown[]
      }
      // 与 runTimeNodes 同口径：轮次 + 轮内工具 + 未挂轮工具 + 旁路
      const count = run.segments.flatMap((s) => s.rounds).length
        + run.segments.flatMap((s) => s.rounds.flatMap((r) => r.tools)).length
        + run.segments.flatMap((s) => s.unplacedTools).length
        + run.sideCalls.length
      bandBars.push({ count, runId: run.runId, activeRunKey: this.activeRunKey as string | null })
      return h('button', {
        class: 'time-band-stub',
        'data-bars': String(count),
        // 与真实条带同口径的 key（round:${段}:${seq}）
        onClick: () => this.$emit('locate', 'round:current:1'),
      }, '时间条带')
    },
  }),
}))

vi.mock('./RunTraceRecordDrawer.vue', () => ({
  default: defineComponent({
    props: { sessionId: { type: String, required: true }, target: { type: Object, required: true } },
    emits: ['close', 'open-tool'],
    render() {
      const target = this.target as { kind: string }
      drawerOpened.push({ kind: target.kind, sessionId: this.sessionId as string, target })
      // 把 emit 挂到根元素上：自绘 nodeOps 只把 props / 事件存在元素 props 里，
      // 测试据此触发「抽屉内跳工具抽屉」这条链路。
      return h('div', {
        class: 'drawer-stub',
        'data-kind': target.kind,
        onOpenTool: (id: string) => this.$emit('open-tool', id),
        onClose: () => this.$emit('close'),
      }, '抽屉')
    },
  }),
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
    llmCallId: 101,
    startedAtMs: Date.parse('2026-10-10T09:03:00Z') - 4200,
    provider: 'anthropic',
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

// 时间概览条带 + 记录详情下钻 + 计时补全（技术方案 2026-10-22-run-trace-deep-dive）。
// 条带与抽屉用 stub：这里验的是面板的挂载位置、传参与事件接线——
// 条带几何 / 抽屉内容已由 trace-display.test.ts 与各组件自身覆盖。
describe('RunTracePanel 时间条带与记录下钻', () => {
  const bandRun = makeTraceRun({
    runId: 21,
    segments: [{
      kind: 'current',
      rounds: [makeTraceRound({ seq: 1, tools: [] })],
      unplacedTools: [],
    }],
  })

  beforeEach(() => {
    bandBars.length = 0
    drawerOpened.length = 0
    store = { ...makeStore(), getTraceRuns: () => [bandRun] }
  })

  it('条带挂在 run 展开区顶部，收起时不渲染', async () => {
    const root = await mountPanel()
    // 未展开：没有条带
    expect(bandBars).toHaveLength(0)
    ;(findAllByClass(root, 'run-summary')[0]!.props.onClick as () => void)()
    await flush()
    // 展开后渲染一次条带，且拿到的就是该 run
    expect(bandBars).toEqual([{ count: 1, runId: 21, activeRunKey: null }])
    const bands = findAllByClass(root, 'time-band-stub')
    expect(bands).toHaveLength(1)
    // 条带位于 run 明细内（run-detail 的第一个元素子节点）
    const detail = findAllByClass(root, 'run-detail')
    expect(detail).toHaveLength(1)
    const elementChildren = detail[0]!.children.filter((c): c is StubEl => !('text' in c))
    expect(elementChildren[0]?.props.class).toBe('time-band-stub')
  })

  it('条带节点数含轮次、工具（含未挂到轮）与旁路调用', async () => {
    store = {
      ...makeStore(),
      getTraceRuns: () => [makeTraceRun({
        runId: 22,
        segments: [{
          kind: 'current',
          rounds: [makeTraceRound({
            tools: [
              { toolCallId: 'c1', name: 'read_file', target: 'a.txt', status: 'OK', durationMs: 100, startedAtMs: 0, approvalMark: null, actor: null },
              { toolCallId: 'c2', name: 'write_file', target: 'b.txt', status: 'ERROR', durationMs: 100, startedAtMs: 0, approvalMark: null, actor: null },
            ],
          })],
          unplacedTools: [
            { toolCallId: 'c3', name: 'glob', target: null, status: 'OK', durationMs: 100, startedAtMs: 0, approvalMark: null, actor: null },
          ],
        }],
        sideCalls: [{
          scene: 'title', modelName: 'step-mini', createdAt: '2026-10-10 09:03:01', startedAtMs: 0, provider: 'anthropic',
          durationMs: 100, promptTokens: 1, completionTokens: 1, cachedTokens: 0, cacheCreationTokens: 0, costMicros: null, success: true,
        }],
      })],
    }
    const root = await mountPanel()
    ;(findAllByClass(root, 'run-summary')[0]!.props.onClick as () => void)()
    await flush()
    // 1 轮 + 2 轮内工具 + 1 未挂轮工具 + 1 旁路
    expect(bandBars).toEqual([{ count: 5, runId: 22, activeRunKey: null }])
  })

  it('点色条 emit locate 后按行锚点滚动定位（锚点 id 带 sessionId / runId / 段维度防串锚）', async () => {
    const root = await mountPanel()
    ;(findAllByClass(root, 'run-summary')[0]!.props.onClick as () => void)()
    await flush()
    const band = findAllByClass(root, 'time-band-stub')[0]!
    ;(band.props.onClick as () => void)()
    await flush()
    // 定位键必须带 runId：多 run 同时展开时只有被点那个 run 的色条高亮
    expect(bandBars.at(-1)!.activeRunKey).toBe('21|round:current:1')
    // 轮次行锚点 id = trace-${sessionId}-run${runId}-round-${段}-${seq}
    expect(findAllByClass(root, 'round-row')[0]!.props.id).toBe('trace-11-run21-round-current:1')
    // 工具行锚点 id = trace-${sessionId}-run${runId}-tool-${段}-${toolCallId ?? name}
    store = {
      ...makeStore(),
      getTraceRuns: () => [makeTraceRun({
        runId: 23,
        segments: [
          {
            kind: 'before_edit',
            rounds: [makeTraceRound({
              tools: [{ toolCallId: 'call_old', name: 'read_file', target: 'a.txt', status: 'OK', durationMs: 100, startedAtMs: 0, approvalMark: null, actor: null }],
            })],
            unplacedTools: [],
          },
          {
            kind: 'current',
            rounds: [makeTraceRound({
              tools: [{ toolCallId: 'call_new', name: 'read_file', target: 'a.txt', status: 'OK', durationMs: 100, startedAtMs: 0, approvalMark: null, actor: null }],
            })],
            unplacedTools: [],
          },
        ],
      })],
    }
    const root2 = await mountPanel()
    ;(findAllByClass(root2, 'run-summary')[0]!.props.onClick as () => void)()
    await flush()
    // 编辑重发：两段各有一行，锚点带段维度，不重复
    const toolRows = findAllByClass(root2, 'tool-row')
    expect(toolRows.map((r) => r.props.id)).toEqual([
      'trace-11-run23-tool-before_edit:call_old',
      'trace-11-run23-tool-current:call_new',
    ])
  })

  it('多个 run 同时展开时行锚点 id 不跨 run 重复', async () => {
    store = {
      ...makeStore(),
      getTraceRuns: () => [
        makeTraceRun({ runId: 31, segments: [{ kind: 'current', rounds: [makeTraceRound({ seq: 1 })], unplacedTools: [] }] }),
        makeTraceRun({ runId: 32, segments: [{ kind: 'current', rounds: [makeTraceRound({ seq: 1 })], unplacedTools: [] }] }),
      ],
    }
    const root = await mountPanel()
    const summaries = findAllByClass(root, 'run-summary')
    expect(summaries).toHaveLength(2)
    ;(summaries[0]!.props.onClick as () => void)()
    ;(summaries[1]!.props.onClick as () => void)()
    await flush()
    // 两个 run 都展开，同类行的 id 必须因 runId 而不同（getElementById 才能取到对的那一行）
    const roundIds = findAllByClass(root, 'round-row').map((r) => r.props.id)
    expect(roundIds).toEqual(['trace-11-run31-round-current:1', 'trace-11-run32-round-current:1'])
    expect(new Set(roundIds).size).toBe(roundIds.length)
  })

  it('轮次行展示 provider 徽标与解码耗时 / 吞吐量', async () => {
    const root = await mountPanel()
    ;(findAllByClass(root, 'run-summary')[0]!.props.onClick as () => void)()
    await flush()
    const text = flatText(root)
    expect(text).toContain('anthropic')
    // durationMs 4200 − firstTokenMs 800 = 3400
    expect(text).toContain('解码 3.40s')
    // completionTokens 200 ÷ 3.4s ≈ 58.8
    expect(text).toContain('58.8 tok/s')
  })

  it('首字缺失（非流式）时解码与吞吐不展示，provider 缺失时不渲染徽标', async () => {
    store = {
      ...makeStore(),
      getTraceRuns: () => [makeTraceRun({
        runId: 24,
        segments: [{
          kind: 'current',
          rounds: [makeTraceRound({ firstTokenMs: null, provider: null, completionTokens: 0 })],
          unplacedTools: [],
        }],
      })],
    }
    const root = await mountPanel()
    ;(findAllByClass(root, 'run-summary')[0]!.props.onClick as () => void)()
    await flush()
    const text = flatText(root)
    expect(text).not.toContain('解码')
    expect(text).not.toContain('tok/s')
    expect(findAllByClass(root, 'round-provider')).toHaveLength(0)
  })

  it('点轮次行「详情」开轮次抽屉（kind=call，带 sessionId）', async () => {
    const root = await mountPanel()
    ;(findAllByClass(root, 'run-summary')[0]!.props.onClick as () => void)()
    await flush()
    const detailBtns = findAllByClass(root, 'row-detail-btn')
    expect(detailBtns).toHaveLength(1)
    ;(detailBtns[0]!.props.onClick as () => void)()
    await flush()
    expect(drawerOpened).toEqual([{ kind: 'call', sessionId: '11', target: { kind: 'call', llmCallId: 101 } }])
    expect(findAllByClass(root, 'drawer-stub')).toHaveLength(1)
  })

  it('点工具行「详情」开工具抽屉（kind=tool），历史行无 toolCallId 时没有入口', async () => {
    store = {
      ...makeStore(),
      getTraceRuns: () => [makeTraceRun({
        runId: 25,
        segments: [{
          kind: 'current',
          rounds: [makeTraceRound({
            tools: [{ toolCallId: 'call_x', name: 'read_file', target: 'a.txt', status: 'OK', durationMs: 100, startedAtMs: 0, approvalMark: null, actor: null }],
          })],
          unplacedTools: [{ toolCallId: null, name: 'glob', target: null, status: 'OK', durationMs: 100, startedAtMs: 0, approvalMark: null, actor: null }],
        }],
      })],
    }
    const root = await mountPanel()
    ;(findAllByClass(root, 'run-summary')[0]!.props.onClick as () => void)()
    await flush()
    // 两条工具行：一条有 toolCallId（有详情按钮），一条没有
    const toolRows = findAllByClass(root, 'tool-row')
    expect(toolRows).toHaveLength(2)
    const withIdBtn = findAllByClass(toolRows[0]!, 'row-detail-btn')
    expect(withIdBtn).toHaveLength(1)
    expect(findAllByClass(toolRows[1]!, 'row-detail-btn')).toHaveLength(0)
    ;(withIdBtn[0]!.props.onClick as () => void)()
    await flush()
    expect(drawerOpened).toEqual([{ kind: 'tool', sessionId: '11', target: { kind: 'tool', toolCallId: 'call_x' } }])
  })

  it('未归属组不画条带（没有 run 上下文）', async () => {
    store = {
      ...makeStore(),
      getTraceRuns: () => [],
      getTraceUnattributed: (): UnattributedGroup | null => ({
        count: 1,
        startedAt: '2026-10-10 09:00:00',
        endedAt: '2026-10-10 09:00:05',
        rounds: [makeTraceRound({ seq: 1 })],
        tools: [{ toolCallId: 'c1', name: 'read_file', target: 'a.txt', status: 'OK', durationMs: 100, startedAtMs: 0, approvalMark: null, actor: null }],
      }),
    }
    const root = await mountPanel()
    expect(flatText(root)).toContain('未归属')
    expect(bandBars).toHaveLength(0)
    expect(findAllByClass(root, 'time-band-stub')).toHaveLength(0)
  })

  it('抽屉内点「本轮工具」跳转到工具抽屉：抽屉实例复用但拿到新 target', async () => {
    const root = await mountPanel()
    ;(findAllByClass(root, 'run-summary')[0]!.props.onClick as () => void)()
    await flush()
    ;(findAllByClass(root, 'row-detail-btn')[0]!.props.onClick as () => void)()
    await flush()
    expect(drawerOpened.at(-1)).toEqual({ kind: 'call', sessionId: '11', target: { kind: 'call', llmCallId: 101 } })

    // 轮次抽屉 emit open-tool → 父组件 openToolRecord 换 target。
    // 抽屉 v-if 是 null → 非 null，实例不销毁，所以抽屉必须自己 watch target 重载；
    // 这里验父组件确实把新 target 传了进去（抽屉侧重载由 watch 负责，另有针对性用例）。
    const drawerEl = findAllByClass(root, 'drawer-stub')[0]!
    ;(drawerEl.props.onOpenTool as (id: string) => void)('call_abc')
    await flush()
    expect(drawerOpened.at(-1)).toEqual({ kind: 'tool', sessionId: '11', target: { kind: 'tool', toolCallId: 'call_abc' } })
    expect(findAllByClass(root, 'drawer-stub')).toHaveLength(1)
  })
})
