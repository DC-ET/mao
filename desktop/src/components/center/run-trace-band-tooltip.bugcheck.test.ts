// Bugcheck：RunTraceTimeBand tooltip 切换语义（2026-10-23 审查 L-4）。
//
// RunTraceTimeBand.vue:127-150：
//   function showTip(node, event) {
//     if (tipTimer != null) window.clearTimeout(tipTimer)   // 只清定时器
//     ...
//     tipTimer = window.setTimeout(() => { tip.value = {...} }, 300)
//   }
//   function hideTip() { clearTimeout; tipTimer = null; tip.value = null }
//
// 疑点：hideTip 只挂在 <svg @mouseleave>（:10）。色条 rect 之间移动不触发
// mouseleave（仍在 svg 内）。从 A（tooltip 已弹出）快速移到 B 时：
//   - showTip 清掉 A 的定时器，但没有立即清 tip.value；
//   - B 的定时器要 300ms 后才写入新内容。
// 于是 A 的 tooltip 继续显示 300ms，内容与鼠标所在的色条不符。
//
// 另验 L-1：组件无 onUnmounted，300ms 内 run 被收起时 tipTimer 不清。
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as Vue from 'vue'
import { defineComponent, h, nextTick, createRenderer } from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { compile } from '@vue/compiler-dom'
import type { RunTrace } from '../../types/trace'

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, useSSRContext: () => ({ modules: new Set(), scopeId: null, styles: '' }) }
})

vi.mock('../../utils/toolDisplay', () => ({ getToolDisplayName: (n: string) => n }))
vi.mock('../../utils/llmCallLabels', () => ({ llmCallSceneLabel: (s: string) => s }))

import RunTraceTimeBand from './RunTraceTimeBand.vue'

const descriptor = parse(readFileSync(new URL('./RunTraceTimeBand.vue', import.meta.url), 'utf8')).descriptor
const script = compileScript(descriptor, { id: 'time-band-bugcheck' })
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
      if (!p || 'text' in n) return null
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

beforeEach(() => {
  ;(globalThis as { window?: unknown }).window = {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as never),
  }
})

afterEach(() => {
  vi.useRealTimers()
})

/** 一个 run 带两条可估算的轮次 → 两个可悬停的 rect（各分首字/解码两段）。 */
function runWithTwoRounds(): RunTrace {
  const round = (seq: number, durationMs: number) => ({
    seq, modelName: `m${seq}`, scene: 'agent', createdAt: '2026-10-10 16:00:04',
    llmCallId: seq, startedAtMs: 0, provider: 'anthropic', durationMs, firstTokenMs: 800,
    retryCount: 0, success: true, interrupted: false, errorMessage: null, promptTokens: 10,
    completionTokens: 20, cachedTokens: 0, cacheCreationTokens: 0, costMicros: null,
    slow: false, expensive: false, tools: [],
  })
  return {
    runId: 1,
    userMessagePreview: 'p',
    startedAt: '2026-10-10 16:00:00',
    segments: [{
      kind: 'current',
      rounds: [round(1, 4000), round(2, 9000)],
      unplacedTools: [],
    }],
    sideCalls: [],
    subagentLinks: [],
    markers: [],
    totals: {
      wallClockMs: 9000, costMicros: null, promptTokens: 10, completionTokens: 20,
      cachedTokens: 0, cacheCreationTokens: 0, toolSuccess: 0, toolError: 0,
    },
  } as RunTrace
}

async function mountBand(r: RunTrace) {
  const Host = defineComponent({
    render: () => h(ClientBand as never, { run: r, activeRunKey: null } as never),
  })
  const ops = nodeOps()
  const { createApp } = createRenderer(ops)
  const root = ops.createElement('root')
  const app = createApp(Host)
  app.config.warnHandler = () => {}
  app.mount(root as never)
  await flush()
  return root
}

/** 与组件一致：事件派发一结束 currentTarget 归 null，宿主元素须同步期取 */
function enter(bar: StubEl) {
  ;(bar.props.onMouseenter as (e: unknown) => void)({ clientX: 40, currentTarget: bar })
}

describe('RunTraceTimeBand tooltip 切换', () => {
  it('L-4：从已弹出的色条移到另一条时，300ms 内仍显示旧节点内容', async () => {
    vi.useFakeTimers()
    const root = await mountBand(runWithTwoRounds())
    const bars = findAllByClass(root, 'band-bar')
    // 第一段是轮次 1 的首字段，轮次 2 的段在后面
    expect(bars.length).toBeGreaterThanOrEqual(3)
    const barOfRound1 = bars[0]!
    const barOfRound2 = bars[2]!

    // 悬停 A：等 tooltip 弹出（内容含轮次 1 的耗时 4.00s）
    enter(barOfRound1)
    await vi.advanceTimersByTimeAsync(350)
    let tipText = flatText(findAllByClass(root, 'band-tip')[0]!)
    expect(tipText).toContain('耗时 4.00s')

    // 快速移到 B（不离开 svg，不触发 mouseleave）
    enter(barOfRound2)
    await vi.advanceTimersByTimeAsync(100)
    // 期望：旧 tooltip 已撤下（或至少不再声称是 4.00s）
    // 实际：A 的 tooltip 原样挂着，仍显示 4.00s，直到 300ms 后才被 B 替换
    const tips = findAllByClass(root, 'band-tip')
    const stale = tips.length === 1 && flatText(tips[0]!).includes('耗时 4.00s')
    expect(stale).toBe(false)
  })

  it('正确性基线：mouseleave 后 tooltip 立即消失', async () => {
    vi.useFakeTimers()
    const root = await mountBand(runWithTwoRounds())
    const bars = findAllByClass(root, 'band-bar')
    enter(bars[0]!)
    await vi.advanceTimersByTimeAsync(350)
    expect(findAllByClass(root, 'band-tip')).toHaveLength(1)
    // 离开 svg：hideTip 立即清 tip.value
    ;(findAllByClass(root, 'band-svg')[0]!.props.onMouseleave as () => void)()
    await flush()
    expect(findAllByClass(root, 'band-tip')).toHaveLength(0)
  })
})
