// Node 环境无 DOM：手动编译模板补客户端 render（同 UsageDetailTab.test.ts 套路）。
// 覆盖 UsageBell 对 open_usage_drawer 事件 detail 的消费：
// 带 { tab } → openRequest 带 nonce 自增（连续两次同 Tab 也触发，C8）；
// 不带 detail 的存量派发（摘要「查看用量」）只开抽屉、不改 Tab（存量行为逐字节不变）。
import { describe, expect, it, vi } from 'vitest'
import * as Vue from 'vue'
import { h, nextTick, defineComponent, createRenderer } from 'vue'

const captured = vi.hoisted(() => ({
  drawerProps: [] as Array<{ modelValue?: boolean; openRequest?: { tab: string; nonce: number } | null }>,
}))

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useSSRContext: () => ({ modules: new Set(), scopeId: null, styles: '' }),
  }
})

// window 在 node 环境不存在：用 EventTarget 顶替（组件挂载时 addEventListener）
const windowTarget = new EventTarget()
vi.stubGlobal('window', windowTarget)

vi.mock('../../composables/usePanelLayout', () => ({
  isMobileDevice: () => false,
}))

vi.mock('./UsageDrawer.vue', () => ({
  default: {
    name: 'UsageDrawerStub',
    props: { modelValue: Boolean, openRequest: Object },
    render(this: { modelValue?: boolean; openRequest?: { tab: string; nonce: number } | null }) {
      captured.drawerProps.push({ modelValue: this.modelValue, openRequest: this.openRequest })
      return h('div', { class: 'drawer-stub' })
    },
  },
}))

import UsageBell from './UsageBell.vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { compile } from '@vue/compiler-dom'
import { readFileSync } from 'node:fs'

const descriptor = parse(readFileSync(new URL('./UsageBell.vue', import.meta.url), 'utf8')).descriptor
const compiledScript = compileScript(descriptor, { id: 'usage-bell' })
const compiledTemplate = compile(descriptor.template!.content, {
  mode: 'function',
  prefixIdentifiers: true,
  bindingMetadata: compiledScript.bindings,
})
const clientRender = new Function('Vue', compiledTemplate.code)(Vue) as (ctx: unknown, cache: unknown) => unknown
const BellComponent = {
  ...(UsageBell as object),
  render: clientRender,
}

const TooltipStub = defineComponent({
  name: 'TooltipStub',
  render() { return h('div', {}, this.$slots.default?.()) },
})

interface StubEl { tag: string; children: StubNode[]; parent: StubEl | null; props: Record<string, unknown> }
type StubNode = StubEl | { text: string; parent: StubEl | null }

function nodeOps() {
  const createElement = (tag: string): StubEl => ({ tag, children: [], parent: null, props: {} })
  const createText = (text: string): StubNode => ({ text, parent: null })
  return {
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
      nextSibling: () => null,
      querySelector: () => null,
      setScopeId: () => {},
      cloneNode: (el: StubEl) => el,
      insertStaticContent: () => [createElement('static-start'), createElement('static-end')] as [StubEl, StubEl],
      patchProp: () => {},
    },
  }
}

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) { await Promise.resolve(); await nextTick() }
}

function mount() {
  const { ops } = nodeOps()
  const { createApp } = createRenderer(ops as never)
  const root = ops.createElement('root')
  const app = createApp(BellComponent as never)
  app.component('el-tooltip', TooltipStub)
  const errors: unknown[] = []
  app.config.warnHandler = () => {}
  app.config.errorHandler = (err) => { errors.push(err) }
  app.mount(root as never)
  if (errors.length) throw errors[0]
}

function dispatch(detail?: { tab?: string }) {
  windowTarget.dispatchEvent(new CustomEvent('open_usage_drawer', { detail }))
}

describe('UsageBell open_usage_drawer 事件', () => {
  it('带 detail.tab → 开抽屉且 openRequest 带 tab + nonce；连续同 Tab nonce 自增（C8）', async () => {
    captured.drawerProps.length = 0
    mount()
    await flush()
    dispatch({ tab: 'budget' })
    await flush()
    const first = captured.drawerProps[captured.drawerProps.length - 1]
    expect(first.modelValue).toBe(true)
    expect(first.openRequest).toEqual({ tab: 'budget', nonce: 1 })

    dispatch({ tab: 'budget' })
    await flush()
    const second = captured.drawerProps[captured.drawerProps.length - 1]
    // 同 Tab 第二次：nonce 递增，watch 浅比较也能触发
    expect(second.openRequest).toEqual({ tab: 'budget', nonce: 2 })
  })

  it('不带 detail 的存量派发 → 开抽屉但不改 openRequest（存量行为不变）', async () => {
    captured.drawerProps.length = 0
    mount()
    await flush()
    dispatch()
    await flush()
    const last = captured.drawerProps[captured.drawerProps.length - 1]
    expect(last.modelValue).toBe(true)
    expect(last.openRequest).toBeNull()
  })
})
