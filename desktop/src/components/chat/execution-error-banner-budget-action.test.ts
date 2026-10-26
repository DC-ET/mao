// P3（0.0.355）：执行异常横幅的可选行动按钮——预算 BLOCK 时 ChatPanel 传
// actionLabel="查看我的预算"，点击 emit('action') 打开用量抽屉预算 Tab。
// 覆盖：有文案才渲染按钮且点击冒泡 action；不传文案一个多余按钮都不渲染（存量横幅零变化）。
// 渲染方式与 execution-error-banner-session-id.test.ts 相同：Node 下 compiler-dom 补客户端
// render + 无 DOM 渲染器，el-button 未注册时退化为原生元素，靠 onClick prop 捕获点击。
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import * as Vue from 'vue'
import { defineComponent, h, createRenderer } from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { compile } from '@vue/compiler-dom'

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useSSRContext: () => ({ modules: new Set(), scopeId: null, styles: '' }),
  }
})

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}))
vi.mock('../../utils/clipboard', () => ({ copyText: vi.fn(async () => true) }))

import ExecutionErrorBanner from './ExecutionErrorBanner.vue'

const descriptor = parse(readFileSync(new URL('./ExecutionErrorBanner.vue', import.meta.url), 'utf8')).descriptor
const script = compileScript(descriptor, { id: 'exec-err-banner-action' })
const compiled = compile(descriptor.template!.content, {
  mode: 'function',
  prefixIdentifiers: true,
  bindingMetadata: script.bindings,
})
const clientRender = new Function('Vue', compiled.code)(Vue) as (ctx: unknown, cache: unknown) => unknown
const ClientBanner = defineComponent({ ...(ExecutionErrorBanner as object), render: clientRender } as never)

interface StubEl { tag: string; children: StubNode[]; parent: StubEl | null; props: Record<string, unknown> }
type StubNode = StubEl | { text: string; parent: StubEl | null }

const handlers = new WeakMap<StubEl, Map<string, (e?: unknown) => unknown>>()

function nodeOps() {
  const createElement = (tag: string): StubEl => ({ tag, children: [], parent: null, props: {} })
  const createText = (text: string): StubNode => ({ text, parent: null })
  return {
    createElement,
    createText,
    createComment: (t: string) => createText(t),
    setText: (n: StubNode, t: string) => { if ('text' in n) n.text = String(t) },
    setElementText: (el: StubEl, t: string) => { el.children = [{ text: String(t), parent: el }] },
    insert: (child: StubNode, parent: StubEl, anchor?: StubNode | null) => {
      child.parent = parent
      const idx = anchor ? parent.children.indexOf(anchor) : -1
      if (idx >= 0) parent.children.splice(idx, 0, child)
      else parent.children.push(child)
    },
    remove: (child: StubNode) => {
      const p = child.parent
      if (p) {
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
    insertStaticContent: (_content: string, _before: StubNode | null, _parent: StubEl): [StubEl, StubEl] => [
      createElement('static-start'),
      createElement('static-end'),
    ],
    patchProp: (el: StubEl, key: string, _prev: unknown, next: unknown) => {
      el.props[key] = next
      const m = /^on([A-Z]\w*)$/.exec(key)
      if (m && typeof next === 'function') {
        const perKey = handlers.get(el) ?? new Map<string, (e?: unknown) => unknown>()
        perKey.set(m[1]!, next as (e?: unknown) => unknown)
        handlers.set(el, perKey)
      }
    },
  }
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

function findAll(root: StubEl, pred: (el: StubEl) => boolean): StubEl[] {
  const out: StubEl[] = []
  const walk = (el: StubEl) => {
    if (pred(el)) out.push(el)
    for (const c of el.children) if (!('text' in c)) walk(c)
  }
  for (const c of root.children) if (!('text' in c)) walk(c)
  return out
}

function mountBanner(props: { actionLabel?: string; onAction?: () => void }) {
  const Host = defineComponent({
    render() {
      return h(ClientBanner, {
        message: '本月全局预算已超限：当期消耗 12 / 上限 10（成本 口径），新任务已被拒绝。请调整预算或联系管理员',
        canRetry: true,
        sessionId: '88',
        ...props,
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
  return { root }
}

/** 可点击元素里找含指定文案的（模板注释也会进 pageText，判存在性不能靠全文） */
function findClickable(root: StubEl, text: string): StubEl[] {
  return findAll(root, el => {
    if (!handlers.get(el)?.has('Click')) return false
    const elText = (() => { try { return subtreeText(el) } catch { return '' } })()
    return elText.includes(text)
  })
}

describe('ExecutionErrorBanner 预算 BLOCK 行动按钮（0.0.355 P3）', () => {
  it('传 actionLabel：渲染按钮，点击 emit action', () => {
    const onAction = vi.fn()
    const { root } = mountBanner({ actionLabel: '查看我的预算', onAction })
    const btn = findClickable(root, '查看我的预算')
    expect(btn).toHaveLength(1)
    // 与重试 / 复制 ID 按钮并存，不互相顶掉
    expect(findClickable(root, '重试')).toHaveLength(1)
    expect(findClickable(root, '复制会话 ID')).toHaveLength(1)

    handlers.get(btn[0]!)!.get('Click')!()
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('不传 actionLabel：不渲染行动按钮，重试与复制 ID 行为不变', () => {
    const { root } = mountBanner({})
    expect(findClickable(root, '查看我的预算')).toHaveLength(0)
    expect(findClickable(root, '重试')).toHaveLength(1)
    expect(findClickable(root, '复制会话 ID')).toHaveLength(1)
  })
})
