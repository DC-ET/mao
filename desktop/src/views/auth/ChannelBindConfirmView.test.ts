// ChannelBindConfirmView 通用确认页：确认前不发 complete、取消不消费 state、
// 三档结果渲染、预览失败短路、senderName 缺失兜底（技术方案 §8）。
// Node 环境无 DOM：同 LoginView.test.ts 套路（compileScript + function 模板 + 无 DOM 渲染器）。
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as Vue from 'vue'
import { h, nextTick, defineComponent, createRenderer } from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { compile } from '@vue/compiler-dom'

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useSSRContext: () => ({ modules: new Set(), scopeId: null, styles: null }),
  }
})

const captured = vi.hoisted(() => ({
  route: { params: { state: 'st-1' }, meta: { channel: 'feishu' } },
  get: vi.fn(),
  post: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRoute: () => captured.route,
}))

vi.mock('../../api', () => ({ api: { get: captured.get, post: captured.post } }))

import ChannelBindConfirmView from './ChannelBindConfirmView.vue'

const descriptor = parse(readFileSync(new URL('./ChannelBindConfirmView.vue', import.meta.url), 'utf8')).descriptor
const script = compileScript(descriptor, { id: 'channel-bind-confirm' })
const compiled = compile(descriptor.template!.content, {
  mode: 'function',
  prefixIdentifiers: true,
  bindingMetadata: script.bindings,
})
const clientRender = new Function('Vue', compiled.code)(Vue) as (ctx: unknown, cache: unknown) => unknown

const ElButton = defineComponent({
  props: { type: String, loading: Boolean },
  render() { return h('button', {}, this.$slots.default?.() ?? []) },
})

const ConfirmPanel = {
  ...(ChannelBindConfirmView as object),
  components: { 'el-button': ElButton, ElButton },
  render: clientRender,
}

interface StubEl { tag: string; children: StubNode[]; parent: StubEl | null; props: Record<string, unknown> }
type StubNode = StubEl | { text: string; parent: StubEl | null }

function nodeOps() {
  const handlers = new Map<StubEl, Record<string, Array<(e?: unknown) => unknown>>>()
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
      patchProp: (el: StubEl, key: string, _prev: unknown, next: unknown) => {
        el.props[key] = next
        if (!/^on[A-Z]/.test(key)) return
        const name = key.slice(2).toLowerCase()
        const fns = Array.isArray(next) ? next : [next]
        for (const fn of fns) {
          if (typeof fn !== 'function') continue
          const rec = handlers.get(el) ?? {}
          const arr = rec[name] ?? []
          arr.push(fn as (e?: unknown) => unknown)
          rec[name] = arr
          handlers.set(el, rec)
        }
      },
    },
  }
}

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) { await Promise.resolve(); await nextTick() }
}

function mount() {
  const { ops, handlers } = nodeOps()
  const { createApp } = createRenderer(ops as never)
  const root = ops.createElement('root')
  const app = createApp(ConfirmPanel as never)
  const errors: unknown[] = []
  app.config.warnHandler = () => {}
  app.config.errorHandler = (err) => { errors.push(err) }
  app.mount(root as never)
  if (errors.length) throw errors[0]

  const findAll = (pred: (el: StubEl) => boolean): StubEl[] => {
    const out: StubEl[] = []
    const walk = (el: StubEl) => {
      if (pred(el)) out.push(el)
      for (const c of el.children) if (!('text' in c)) walk(c)
    }
    for (const c of root.children) if (!('text' in c)) walk(c)
    return out
  }
  const textAll = (): string => {
    const parts: string[] = []
    const walk = (el: StubEl) => {
      for (const c of el.children) {
        if ('text' in c) parts.push(c.text)
        else walk(c)
      }
    }
    for (const c of root.children) if (!('text' in c)) walk(c)
    return parts.join('|')
  }
  const clickButton = (label: string): void => {
    const btn = findAll((el) => el.tag === 'button' && JSON.stringify(collectText(el)).includes(label))[0]
    if (!btn) throw new Error(`button not found: ${label}`)
    const fn = handlers.get(btn)?.click?.slice(-1)[0]
    if (!fn) throw new Error(`no click handler: ${label}`)
    fn()
  }
  function collectText(el: StubEl): string {
    const parts: string[] = []
    const walk = (n: StubNode) => {
      if ('text' in n) parts.push(n.text)
      else for (const c of n.children) walk(c)
    }
    walk(el)
    return parts.join('')
  }
  return { findAll, textAll, clickButton }
}

function previewPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    senderName: '张三',
    chatType: 'p2p',
    expiresAt: '2026-11-19T10:00:00.000Z',
    currentUser: { id: 8, username: 'bob' },
    willRebind: false,
    ...overrides,
  }
}

describe('ChannelBindConfirmView', () => {
  beforeEach(() => {
    captured.route = { params: { state: 'st-1' }, meta: { channel: 'feishu' } }
    captured.get.mockReset()
    captured.post.mockReset()
  })

  it('预览成功渲染双方身份；确认后才调 complete', async () => {
    captured.get.mockResolvedValue({ data: { code: 0, data: previewPayload() } })
    const m = mount()
    await flush()
    expect(captured.get).toHaveBeenCalledWith('/feishu/binding/pending', { params: { state: 'st-1' } })
    expect(captured.post).not.toHaveBeenCalled()
    const text = m.textAll()
    expect(text).toContain('张三')
    expect(text).toContain('bob')
    expect(text).toContain('确认绑定')
    expect(text).not.toContain('将替换现有绑定')

    captured.post.mockResolvedValue({ data: { code: 0, data: { status: 'success', message: '绑定成功，已开始处理你刚才的消息', senderName: '张三' } } })
    m.clickButton('确认绑定')
    await flush()
    expect(captured.post).toHaveBeenCalledWith('/feishu/binding/complete', { state: 'st-1' })
    expect(m.textAll()).toContain('绑定成功')
  })

  it('willRebind 时明示替换现有绑定；钉钉通道走钉钉接口', async () => {
    captured.route = { params: { state: 'st-2' }, meta: { channel: 'dingtalk' } }
    captured.get.mockResolvedValue({ data: { code: 0, data: previewPayload({ willRebind: true }) } })
    const m = mount()
    await flush()
    expect(captured.get).toHaveBeenCalledWith('/dingtalk/binding/pending', { params: { state: 'st-2' } })
    expect(m.textAll()).toContain('将替换现有绑定')
    expect(m.textAll()).toContain('钉钉')
  })

  it('senderName 缺失时兜底显示「飞书用户」，不渲染空', async () => {
    captured.get.mockResolvedValue({ data: { code: 0, data: previewPayload({ senderName: null }) } })
    const m = mount()
    await flush()
    expect(m.textAll()).toContain('飞书用户')
  })

  it('取消不调 complete、不消费 state', async () => {
    captured.get.mockResolvedValue({ data: { code: 0, data: previewPayload() } })
    const m = mount()
    await flush()
    m.clickButton('取消')
    await flush()
    expect(captured.post).not.toHaveBeenCalled()
    expect(m.textAll()).toContain('已取消绑定')
  })

  it('complete 在途期间渲染「正在绑定…」态，响应返回后切换结果', async () => {
    captured.get.mockResolvedValue({ data: { code: 0, data: previewPayload() } })
    const m = mount()
    await flush()
    let resolvePost: (v: { data: { code: number; data: unknown } }) => void = () => {}
    captured.post.mockImplementation(() => new Promise((resolve) => { resolvePost = resolve }))
    m.clickButton('确认绑定')
    await flush()
    expect(captured.post).toHaveBeenCalledWith('/feishu/binding/complete', { state: 'st-1' })
    expect(m.textAll()).toContain('正在绑定…')
    resolvePost({ data: { code: 0, data: { status: 'success', message: '绑定成功，已开始处理你刚才的消息', senderName: '张三' } } })
    await flush()
    expect(m.textAll()).toContain('绑定成功')
    expect(m.textAll()).not.toContain('正在绑定…')
  })

  it('业务失败（HTTP 200 + code≠0，拦截器转裸 Error）也渲染后端 message', async () => {
    captured.get.mockResolvedValue({ data: { code: 0, data: previewPayload() } })
    const m = mount()
    await flush()
    captured.post.mockRejectedValue(Object.assign(new Error('该飞书身份已绑定其它 Mao 账号，未改绑'), { toastShown: true, code: 2001 }))
    m.clickButton('确认绑定')
    await flush()
    expect(m.textAll()).toContain('绑定未完成')
    expect(m.textAll()).toContain('该飞书身份已绑定其它 Mao 账号')
  })

  it('三档结果渲染：partial 与 failed', async () => {
    captured.get.mockResolvedValue({ data: { code: 0, data: previewPayload() } })
    const m = mount()
    await flush()
    captured.post.mockResolvedValue({ data: { code: 0, data: { status: 'partial', message: '绑定已生效，原消息未恢复，请回 IM 重新发送一条消息', senderName: '张三' } } })
    m.clickButton('确认绑定')
    await flush()
    expect(m.textAll()).toContain('绑定未完全成功')

    captured.get.mockResolvedValue({ data: { code: 0, data: previewPayload() } })
    const m2 = mount()
    await flush()
    captured.post.mockRejectedValue({ response: { data: { message: '该飞书身份已绑定其它 Mao 账号，未改绑' } } })
    m2.clickButton('确认绑定')
    await flush()
    expect(m2.textAll()).toContain('绑定未完成')
    expect(m2.textAll()).toContain('该飞书身份已绑定其它 Mao 账号')
  })

  it('预览失败短路：直接失败结果，不出现确认按钮，不发 complete', async () => {
    captured.get.mockRejectedValue({ response: { data: { message: '链接已过期或已使用，请回 IM 重新发送一条消息' } } })
    const m = mount()
    await flush()
    expect(m.textAll()).toContain('链接已过期或已使用')
    expect(() => m.clickButton('确认绑定')).toThrow()
    expect(captured.post).not.toHaveBeenCalled()
  })
})
