// 回归（0.0.346）：执行异常横幅的「复制会话 ID」排障入口。
// 覆盖：传入 sessionId 且有报错才渲染按钮；点击走统一 copyText，成功/失败分别提示；
// 新建未落库（无 sessionId）只显示重试，不给用户一个无效 ID；无报错整条横幅不渲染。
// 渲染方式与 task-inspector-context-race.test.ts 相同：Node 下用 compiler-dom 补客户端
// render + 无 DOM 渲染器，el-button 未注册时退化为原生元素，靠 onClick prop 捕获点击。
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, beforeEach } from 'vitest'
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
import { ElMessage } from 'element-plus'
import { copyText } from '../../utils/clipboard'

const descriptor = parse(readFileSync(new URL('./ExecutionErrorBanner.vue', import.meta.url), 'utf8')).descriptor
const script = compileScript(descriptor, { id: 'exec-err-banner' })
const compiled = compile(descriptor.template!.content, {
  mode: 'function',
  prefixIdentifiers: true,
  bindingMetadata: script.bindings,
})
const clientRender = new Function('Vue', compiled.code)(Vue) as (ctx: unknown, cache: unknown) => unknown
const ClientBanner = defineComponent({ ...(ExecutionErrorBanner as object), render: clientRender } as never)

interface StubEl { tag: string; children: StubNode[]; parent: StubEl | null; props: Record<string, unknown> }
type StubNode = StubEl | { text: string; parent: StubEl | null }

const handlers = new WeakMap<StubEl, Array<(e?: unknown) => unknown>>()

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
      if (/^onClick/.test(key) && typeof next === 'function') {
        const arr = handlers.get(el) ?? []
        arr.push(next as (e?: unknown) => unknown)
        handlers.set(el, arr)
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

function mountBanner(props: { message?: string | null; canRetry?: boolean; sessionId?: string }) {
  const Host = defineComponent({
    render: () => h(ClientBanner, {
      message: 'boom：上游 500',
      canRetry: true,
      ...props,
    } as never),
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

function findAll(root: StubEl, pred: (el: StubEl) => boolean): StubEl[] {
  const out: StubEl[] = []
  const walk = (el: StubEl) => {
    if (pred(el)) out.push(el)
    for (const c of el.children) if (!('text' in c)) walk(c)
  }
  for (const c of root.children) if (!('text' in c)) walk(c)
  return out
}

function pageText(root: StubEl): string {
  return findAll(root, () => true).map(subtreeText).join('')
}

function clickWhere(root: StubEl, text: string) {
  const hit = findAllClickable(root, text)[0]
  if (!hit) throw new Error(`clickable with text not found: ${text}; page=${pageText(root)}`)
  const arr = handlers.get(hit)!
  return arr[arr.length - 1]!()
}

/** 模板注释也会被桩渲染器收进 pageText，判存在性必须只看可点击元素 */
function findAllClickable(root: StubEl, text: string): StubEl[] {
  return findAll(root, el => {
    if (!handlers.has(el)) return false
    const elText = (() => { try { return subtreeText(el) } catch { return '' } })()
    return elText.includes(text)
  })
}

async function flush(rounds = 6) {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.mocked(copyText).mockClear()
  vi.mocked(ElMessage.success).mockClear()
  vi.mocked(ElMessage.error).mockClear()
})

describe('ExecutionErrorBanner 复制会话 ID（0.0.346）', () => {
  it('有报错 + 有 sessionId：渲染按钮，点击复制并提示成功', async () => {
    const { root } = mountBanner({ sessionId: '345' })
    expect(pageText(root)).toContain('boom：上游 500')
    expect(findAllClickable(root, '复制会话 ID')).toHaveLength(1)

    clickWhere(root, '复制会话 ID')
    await flush()
    expect(copyText).toHaveBeenCalledWith('345')
    expect(ElMessage.success).toHaveBeenCalledWith('会话 ID 已复制')
  })

  it('复制失败：提示错误且不弹成功', async () => {
    vi.mocked(copyText).mockResolvedValueOnce(false)
    const { root } = mountBanner({ sessionId: '345' })
    clickWhere(root, '复制会话 ID')
    await flush()
    expect(ElMessage.error).toHaveBeenCalledWith('复制失败，请手动记录会话 ID')
    expect(ElMessage.success).not.toHaveBeenCalled()
  })

  it('无 sessionId（新建未落库）：不渲染复制按钮，重试不受影响', () => {
    const { root } = mountBanner({ sessionId: undefined })
    expect(pageText(root)).toContain('重试')
    expect(findAllClickable(root, '复制会话 ID')).toHaveLength(0)
  })

  it('无报错：整条横幅不渲染', () => {
    const { root } = mountBanner({ message: null, sessionId: '345' })
    expect(pageText(root)).toBe('')
  })
})
