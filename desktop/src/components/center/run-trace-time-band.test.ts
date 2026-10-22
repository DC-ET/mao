// run 内时间概览条带（技术方案 2026-10-22-run-trace-deep-dive §5.5）行为回归。
// node 环境无 DOM：挂 SFC 走「vi.mock('vue' useSSRContext) + compileScript / compile +
// new Function('Vue', compiled.code) + 自绘 nodeOps」三件套。
//
// 覆盖：全 null 不渲染；可估算节点画色条、起止不可估算不画；悬停 300ms 后 tooltip
// 显示「估算」起止与耗时（事件派发结束后 currentTarget 会被规范重置为 null，
// 宿主元素必须在同步期取，否则回调抛 TypeError、tooltip 全程不显示）；点击 emit locate。
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as Vue from 'vue'
import { defineComponent, h, nextTick, createRenderer } from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { compile } from '@vue/compiler-dom'
import type { RunTrace } from '../../types/trace'

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useSSRContext: () => ({ modules: new Set(), scopeId: null, styles: '' }),
  }
})

vi.mock('../../utils/toolDisplay', () => ({ getToolDisplayName: (n: string) => n }))
vi.mock('../../utils/llmCallLabels', () => ({ llmCallSceneLabel: (s: string) => s }))

import RunTraceTimeBand from './RunTraceTimeBand.vue'

const descriptor = parse(readFileSync(new URL('./RunTraceTimeBand.vue', import.meta.url), 'utf8')).descriptor
const script = compileScript(descriptor, { id: 'time-band' })
const compiled = compile(descriptor.template!.content, {
  mode: 'function',
  prefixIdentifiers: true,
  bindingMetadata: script.bindings,
})
const clientRender = new Function('Vue', compiled.code)(Vue) as (ctx: unknown, cache: unknown) => unknown

const ClientBand = { ...(RunTraceTimeBand as object), components: {}, render: clientRender }

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

/** node 环境无 window：组件用 window.setTimeout / clearTimeout 做 300ms 延迟 */
beforeEach(() => {
  ;(globalThis as { window?: unknown }).window = {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as never),
  }
})

afterEach(() => {
  vi.useRealTimers()
})

function run(overrides: Partial<RunTrace> = {}): RunTrace {
  return {
    runId: 1,
    userMessagePreview: 'p',
    startedAt: '2026-10-10 16:00:00',
    segments: [{
      kind: 'current',
      rounds: [{
        seq: 1, modelName: 'step-5', scene: 'agent', createdAt: '2026-10-10 16:00:04',
        llmCallId: 1, startedAtMs: 0, provider: 'anthropic', durationMs: 4000, firstTokenMs: 800,
        retryCount: 0, success: true, interrupted: false, errorMessage: null, promptTokens: 10,
        completionTokens: 20, cachedTokens: 0, cacheCreationTokens: 0, costMicros: null,
        slow: false, expensive: false, tools: [],
      }],
      unplacedTools: [],
    }],
    sideCalls: [],
    subagentLinks: [],
    markers: [],
    totals: {
      wallClockMs: 4000, costMicros: null, promptTokens: 10, completionTokens: 20,
      cachedTokens: 0, cacheCreationTokens: 0, toolSuccess: 0, toolError: 0,
    },
    ...overrides,
  }
}

async function mountBand(r: RunTrace, activeRunKey: string | null = null) {
  const Host = defineComponent({
    render: () => h(ClientBand as never, { run: r, activeRunKey } as never),
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

describe('RunTraceTimeBand', () => {
  it('全部节点起止不可估算时整体不渲染（不画空条）', async () => {
    const root = await mountBand(run({
      segments: [{
        kind: 'current',
        rounds: [{
          seq: 1, modelName: 'step-5', scene: 'agent', createdAt: null, llmCallId: 1,
          startedAtMs: null, provider: null, durationMs: 4000, firstTokenMs: null, retryCount: 0,
          success: true, interrupted: false, errorMessage: null, promptTokens: 0, completionTokens: 0,
          cachedTokens: 0, cacheCreationTokens: 0, costMicros: null, slow: false, expensive: false, tools: [],
        }],
        unplacedTools: [],
      }],
    }))
    expect(findAllByClass(root, 'trace-time-band')).toHaveLength(0)
    expect(findAllByClass(root, 'band-bar')).toHaveLength(0)
  })

  it('可估算的轮次画色条，助手轮次分首字 / 解码两段', async () => {
    const root = await mountBand(run())
    const bars = findAllByClass(root, 'band-bar')
    // firstTokenMs 800 / durationMs 4000 → 两段
    expect(bars).toHaveLength(2)
    expect(bars[0]!.props.class).toContain('bar-round')
    expect(bars[1]!.props.class).toContain('bar-decode')
    // 图例三项都在
    const legend = flatText(root)
    expect(legend).toContain('轮次')
    expect(legend).toContain('工具')
    expect(legend).toContain('旁路')
  })

  it('起止不可估算的节点不画色条，图例报「N 项起止不可估算未画」', async () => {
    const root = await mountBand(run({
      segments: [
        {
          kind: 'current',
          rounds: [{
            seq: 1, modelName: 'step-5', scene: 'agent', createdAt: '2026-10-10 16:00:04',
            llmCallId: 1, startedAtMs: 0, provider: null, durationMs: 4000, firstTokenMs: null,
            retryCount: 0, success: true, interrupted: false, errorMessage: null, promptTokens: 0,
            completionTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, costMicros: null,
            slow: false, expensive: false, tools: [],
          }],
          unplacedTools: [{
            toolCallId: null, name: 'glob', target: null, status: 'OK',
            durationMs: 100, startedAtMs: null, approvalMark: null, actor: null,
          }],
        },
      ],
    }))
    // 只有轮次可画；未挂轮工具 startedAtMs 为 null 不画
    expect(findAllByClass(root, 'band-bar')).toHaveLength(1)
    expect(flatText(root)).toContain('1 项起止不可估算未画')
  })

  it('悬停 300ms 后 tooltip 显示估算起止与耗时（currentTarget 异步为 null，不得在回调里读）', async () => {
    vi.useFakeTimers()
    const root = await mountBand(run())
    const bars = findAllByClass(root, 'band-bar')
    expect(bars.length).toBeGreaterThan(0)
    // 真实浏览器语义：事件派发一结束 currentTarget 就被重置为 null
    const event = { clientX: 40, currentTarget: null as unknown }
    ;(bars[0]!.props.onMouseenter as (e: unknown) => void)(event)
    // 300ms 内不弹（延迟是为了色条密集时鼠标划过不弹一串）
    await vi.advanceTimersByTimeAsync(200)
    expect(findAllByClass(root, 'band-tip')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(150)
    const tips = findAllByClass(root, 'band-tip')
    expect(tips).toHaveLength(1)
    const text = flatText(tips[0]!)
    expect(text).toContain('起 估算')
    expect(text).toContain('止 估算')
    expect(text).toContain('耗时 4.00s')
    expect(text).toContain('首字')
  })

  it('点击色条 emit locate，带节点 key', async () => {
    const located: string[] = []
    const Host = defineComponent({
      render: () => h(ClientBand as never, { run: run(), activeRunKey: null, onLocate: (k: string) => located.push(k) } as never),
    })
    const ops = nodeOps()
    const { createApp } = createRenderer(ops)
    const root = ops.createElement('root')
    const app = createApp(Host)
    app.config.warnHandler = () => {}
    app.mount(root as never)
    await flush()
    const bars = findAllByClass(root, 'band-bar')
    ;(bars[0]!.props.onClick as () => void)()
    await flush()
    expect(located).toEqual(['round:current:1'])
  })

  it('activeRunKey 命中本 run 的节点才高亮（多 run 同时展开不串高亮）', async () => {
    // 定位的是 run 1 的 round:current:1
    const hit = await mountBand(run(), '1|round:current:1')
    const hitBars = findAllByClass(hit, 'band-bar')
    expect(hitBars.every((b) => String(b.props.class).includes('bar-active'))).toBe(true)

    // 同一条 key 但属于另一个 run（run 2）：本 run 的条带一条都不该亮
    const other = await mountBand(run({ runId: 2 }), '1|round:current:1')
    const otherBars = findAllByClass(other, 'band-bar')
    expect(otherBars).toHaveLength(2)
    expect(otherBars.some((b) => String(b.props.class).includes('bar-active'))).toBe(false)

    // key 不同也不亮
    const miss = await mountBand(run(), '1|round:current:2')
    expect(findAllByClass(miss, 'band-bar').some((b) => String(b.props.class).includes('bar-active'))).toBe(false)
  })
})
