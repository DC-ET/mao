// Node 环境无 DOM：.vue 在 vitest 下只编译出 ssrRender，手动编译模板补客户端 render，
// 再用无 DOM 渲染器点按钮（同 UsageDetailTab.test.ts 套路）。
// 覆盖预算 Tab：挂载即拉、空态、错误态重试、卡片内容、刷新令牌重拉、
// P3 Agent 归因（失败静默不扰主视图）。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as Vue from 'vue'
import { h, nextTick, ref, defineComponent, createRenderer } from 'vue'

const captured = vi.hoisted(() => ({
  budgetsCalls: 0,
  summaryCalls: 0,
  summaryRanges: [] as string[],
  budgetsShouldFail: false,
  summaryShouldFail: false,
  budgetsResult: { items: [] as unknown[] },
  byAgent: [] as Array<{ agentId: number | null; agentName: string | null; cost: number }>,
  progress: [] as Array<{ percentage: number; color: string }>,
}))

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useSSRContext: () => ({ modules: new Set(), scopeId: null, styles: '' }),
  }
})

vi.mock('../../api', () => ({
  fetchMyBudgets: async () => {
    captured.budgetsCalls += 1
    if (captured.budgetsShouldFail) throw new Error('budget down')
    return captured.budgetsResult
  },
  fetchMyUsageSummary: async (range: string) => {
    captured.summaryCalls += 1
    captured.summaryRanges.push(range)
    if (captured.summaryShouldFail) throw new Error('summary down')
    return { range, totals: {}, byModel: [], byScene: [], byAgent: captured.byAgent }
  },
}))

import UsageBudgetTab from './UsageBudgetTab.vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { compile } from '@vue/compiler-dom'
import { readFileSync } from 'node:fs'

const descriptor = parse(readFileSync(new URL('./UsageBudgetTab.vue', import.meta.url), 'utf8')).descriptor
const compiledScript = compileScript(descriptor, { id: 'usage-budget-tab' })
const compiledTemplate = compile(descriptor.template!.content, {
  mode: 'function',
  prefixIdentifiers: true,
  bindingMetadata: compiledScript.bindings,
})
const clientRender = new Function('Vue', compiledTemplate.code)(Vue) as (ctx: unknown, cache: unknown) => unknown
const BudgetComponent = {
  ...(UsageBudgetTab as object),
  render: clientRender,
}

const EmptyStub = defineComponent({
  name: 'EmptyStub',
  render() { return h('div', { class: 'stub-empty' }, this.$slots.description ? this.$slots.description() : undefined) },
})

const ButtonStub = defineComponent({
  name: 'ButtonStub',
  render() {
    const onClick = (this.$attrs as { onClick?: () => void }).onClick
    return h('button', { class: 'stub-button', onClick: () => onClick?.() }, this.$slots.default?.())
  },
})

const TagStub = defineComponent({
  name: 'TagStub',
  render() { return h('span', { class: 'stub-tag' }, this.$slots.default?.()) },
})

const ProgressStub = defineComponent({
  name: 'ProgressStub',
  props: { percentage: Number, color: String },
  render() {
    captured.progress.push({ percentage: this.percentage ?? 0, color: this.color ?? '' })
    return h('div', { class: 'stub-progress' })
  },
})

interface StubEl { tag: string; children: StubNode[]; parent: StubEl | null; props: Record<string, unknown> }
type StubNode = StubEl | { text: string; parent: StubEl | null }

function nodeOps() {
  const handlers = new Map<StubEl, Array<(e?: unknown) => unknown>>()
  const createElement = (tag: string): StubEl => ({ tag, children: [], parent: null, props: {} })
  const createText = (text: string): StubNode => ({ text, parent: null })
  return {
    handlers,
    ops: {
      createElement,
      createText,
      createComment: (t: string) => createText(t),
      setText: (n: StubNode, t: string) => { if ('text' in n) n.text = String(t) },
      setElementText: (el: StubEl, t: string) => { el.children = [{ text: String(t), parent: el }] },
      insert: (child: StubNode, parent: StubEl) => { child.parent = parent; parent.children.push(child) },
      remove: (child: StubNode) => {
        const p = child.parent
        if (p && !('text' in p)) {
          const i = p.children.indexOf(child)
          if (i >= 0) p.children.splice(i, 1)
          child.parent = null
        }
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
      patchProp: (el: StubEl, key: string, _prev: unknown, next: unknown) => {
        el.props[key] = next
        if (/^on[A-Z]/.test(key)) {
          const fns = Array.isArray(next) ? next : [next]
          for (const fn of fns) {
            if (typeof fn === 'function') {
              const arr = handlers.get(el) ?? []
              arr.push(fn as (e?: unknown) => unknown)
              handlers.set(el, arr)
            }
          }
        }
      },
    },
  }
}

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) { await Promise.resolve(); await nextTick() }
}

function subtreeText(el: StubEl): string {
  const acc: string[] = []
  const walk = (n: StubNode) => {
    if ('text' in n) { acc.push(n.text); return }
    for (const c of n.children) walk(c)
  }
  for (const c of el.children) walk(c)
  return acc.join('')
}

function mount() {
  const key = ref(0)
  const Host = defineComponent({
    render: () => h(BudgetComponent as never, { refreshKey: key.value } as never),
  })
  const { ops, handlers } = nodeOps()
  const { createApp } = createRenderer(ops as never)
  const root = ops.createElement('root')
  const app = createApp(Host)
  app.component('el-empty', EmptyStub)
  app.component('el-button', ButtonStub)
  app.component('el-tag', TagStub)
  app.component('el-progress', ProgressStub)
  app.directive('loading', {})
  const errors: unknown[] = []
  app.config.warnHandler = () => {}
  app.config.errorHandler = (err) => { errors.push(err) }
  app.mount(root as never)
  if (errors.length) throw errors[0]

  const click = (label: string) => {
    const hit: StubEl[] = []
    const walk = (el: StubEl) => {
      if (el.tag === 'button' && subtreeText(el).includes(label)) hit.push(el)
      for (const c of el.children) if (!('text' in c)) walk(c)
    }
    for (const c of root.children) if (!('text' in c)) walk(c)
    const el = hit[0]
    if (!el) throw new Error(`button not found: ${label}`)
    const arr = handlers.get(el)
    if (!arr || !arr.length) throw new Error(`no click handler on: ${label}`)
    return arr[arr.length - 1]!()
  }
  return { click, setKey: (v: number) => { key.value = v }, text: () => subtreeText(root) }
}

beforeEach(() => {
  captured.budgetsCalls = 0
  captured.summaryCalls = 0
  captured.summaryRanges.length = 0
  captured.budgetsShouldFail = false
  captured.summaryShouldFail = false
  captured.budgetsResult = { items: [] }
  captured.byAgent = []
  captured.progress.length = 0
})

describe('UsageBudgetTab', () => {
  it('挂载即拉预算（一次）与 Agent 归因（range=month，与预算周期同口径）', async () => {
    mount()
    await flush()
    expect(captured.budgetsCalls).toBe(1)
    expect(captured.summaryCalls).toBe(1)
    expect(captured.summaryRanges).toEqual(['month'])
  })

  it('空态：无生效预算显示引导文案，不报错', async () => {
    const m = mount()
    await flush()
    expect(m.text()).toContain('当前没有生效的预算限制')
    expect(m.text()).toContain('团队预算由管理员配置')
  })

  it('错误态：显示重试；点重试重新拉取（恢复后出卡片）', async () => {
    captured.budgetsShouldFail = true
    const m = mount()
    await flush()
    expect(m.text()).toContain('预算信息加载失败')
    expect(captured.budgetsCalls).toBe(1)

    captured.budgetsShouldFail = false
    captured.budgetsResult = {
      items: [{
        id: 1, scope: 'GLOBAL', periodSpend: 42.5, limitValue: 100, limitType: 'COST',
        action: 'BLOCK', status: 'NORMAL', period: '2026-10', resetAt: '2026-11-01 00:00:00',
      }],
    }
    m.click('重试')
    await flush()
    expect(captured.budgetsCalls).toBe(2)
    expect(m.text()).toContain('全局预算')
    expect(m.text()).toContain('正常')
  })

  it('卡片：作用域 / 状态 / 消耗-上限 / 周期 / 重置时间；进度条百分比与配色取自 VO', async () => {
    captured.budgetsResult = {
      items: [
        { id: 1, scope: 'GLOBAL', periodSpend: 120, limitValue: 100, limitType: 'COST', action: 'BLOCK', status: 'BLOCKED', period: '2026-10', resetAt: '2026-11-01 00:00:00' },
        { id: 2, scope: 'USER', periodSpend: 250_000, limitValue: 1_000_000, limitType: 'TOKENS', action: 'WARN', status: 'NORMAL', period: '2026-10', resetAt: '2026-11-01 00:00:00' },
      ],
    }
    const m = mount()
    await flush()
    const text = m.text()
    expect(text).toContain('全局预算')
    expect(text).toContain('我的预算')
    expect(text).toContain('已拦截') // BLOCKED 置顶
    expect(text).toContain('当期消耗')
    expect(text).toContain('上限')
    expect(text).toContain('成本口径')
    expect(text).toContain('Token口径')
    expect(text).toContain('月度周期 · 2026-10 · 服务器本地时区')
    expect(text).toContain('重置时间：2026-11-01 00:00:00')
    // 展示序：BLOCKED 在前、NORMAL 收尾
    expect(text.indexOf('全局预算')).toBeLessThan(text.indexOf('我的预算'))
    // 进度：COST 卡 100 封顶红；TOKENS 卡 25 绿
    expect(captured.progress).toEqual([
      { percentage: 100, color: '#f56c6c' },
      { percentage: 25, color: '#67c23a' },
    ])
  })

  it('刷新令牌变化 → 重拉预算', async () => {
    const m = mount()
    await flush()
    expect(captured.budgetsCalls).toBe(1)
    m.setKey(1)
    await flush()
    expect(captured.budgetsCalls).toBe(2)
    // 归因只在挂载时拉一次，不随预算刷新令牌重拉
    expect(captured.summaryCalls).toBe(1)
  })

  it('Agent 归因：按成本降序渲染，无归属兜底名', async () => {
    captured.budgetsResult = {
      items: [{ id: 1, scope: 'GLOBAL', periodSpend: 10, limitValue: 100, limitType: 'COST', action: 'BLOCK', status: 'NORMAL', period: '2026-10', resetAt: '2026-11-01 00:00:00' }],
    }
    captured.byAgent = [
      { agentId: 9, agentName: null, cost: 1 },
      { agentId: 3, agentName: '调研助手', cost: 30 },
      { agentId: null, agentName: null, cost: 5 },
    ]
    const m = mount()
    await flush()
    const text = m.text()
    expect(text).toContain('本期消耗按 Agent')
    expect(text).toContain('调研助手')
    expect(text).toContain('Agent #9')
    expect(text).toContain('无 Agent')
    // 降序：调研助手(30) → 无 Agent(5) → Agent #9(1)
    expect(text.indexOf('调研助手')).toBeLessThan(text.indexOf('无 Agent'))
    expect(text.indexOf('无 Agent')).toBeLessThan(text.indexOf('Agent #9'))
  })

  it('归因请求失败 → 静默：预算卡片照常，无归因区块', async () => {
    captured.budgetsResult = {
      items: [{ id: 1, scope: 'GLOBAL', periodSpend: 10, limitValue: 100, limitType: 'COST', action: 'BLOCK', status: 'NORMAL', period: '2026-10', resetAt: '2026-11-01 00:00:00' }],
    }
    captured.summaryShouldFail = true
    const m = mount()
    await flush()
    expect(m.text()).toContain('全局预算')
    // 归因区块的小标题只在有行时渲染（模板注释不含这段文案）
    expect(m.text()).not.toContain('与预算同为月度周期')
  })
})
