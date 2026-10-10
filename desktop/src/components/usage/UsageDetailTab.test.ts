// Node 环境无 DOM，用 compiler-dom 补客户端 render + 无 DOM 渲染器点按钮。
// Node 环境无 DOM：.vue 在 vitest 下只编译出 ssrRender，手动编译模板补客户端 render，
// 再用无 DOM 渲染器点按钮（同 UsageFilterBar.test.ts 套路）。
// 覆盖抽屉「明细」Tab 的分页口径：改筛选条件 / 每页条数都要回到第 1 页再拉，
// 否则停在第 3 页时改筛选会落在越界页上，只看到一张空表；刷新令牌只重拉当前页。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as Vue from 'vue'
import { h, nextTick, ref, defineComponent, createRenderer } from 'vue'

// 模板编译产物走 $setup.UsageFilterBar / $setup.UsageRecordTable（script setup 的组件绑定），
// 挂在 components 上不生效，因此 mock 两个子组件模块；替身用 hoisted 持有以避开提升顺序，
// 且工厂里必须惰性读取（工厂只在模块加载时求值一次，直接取会拿到 null）。
const stubs = vi.hoisted(() => ({
  filterBar: null as unknown,
  recordTable: null as unknown,
}))

// vitest 下 .vue 只编译出 ssrRender，挂载时仍会走到它，需给 useSSRContext 兜底。
vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useSSRContext: () => ({ modules: new Set(), scopeId: null, styles: '' }),
  }
})

const fetchCalls: Array<{ page?: number; size?: number; scene?: string; modelId?: number; success?: boolean }> = []
const pushed: string[] = []
vi.mock('../../api', () => ({
  fetchMyLlmCalls: async (params: Record<string, unknown>) => {
    fetchCalls.push(params as never)
    return { records: [], total: 35, page: 1, size: 10 }
  },
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: (p: string) => pushed.push(p) }),
  RouterLink: {
    render(this: { $slots: { default?: () => unknown[] } }) {
      return h('a', {}, this.$slots.default?.() as never)
    },
  },
}))
vi.mock('./UsageFilterBar.vue', () => ({
  get default() { return stubs.filterBar },
}))
vi.mock('./UsageRecordTable.vue', () => ({
  get default() { return stubs.recordTable },
}))

import UsageDetailTab from './UsageDetailTab.vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { compile } from '@vue/compiler-dom'
import { readFileSync } from 'node:fs'

// vitest 下 .vue 只编译出 ssrRender（无客户端 render），这里手动编译模板补上，
// 与 UsageFilterBar.test.ts 同一套路。
const descriptor = parse(readFileSync(new URL('./UsageDetailTab.vue', import.meta.url), 'utf8')).descriptor
const compiledScript = compileScript(descriptor, { id: 'usage-detail-tab' })
const compiledTemplate = compile(descriptor.template!.content, {
  mode: 'function',
  prefixIdentifiers: true,
  bindingMetadata: compiledScript.bindings,
})
const clientRender = new Function('Vue', compiledTemplate.code)(Vue) as (ctx: unknown, cache: unknown) => unknown
const DetailComponent = {
  ...(UsageDetailTab as object),
  render: clientRender,
}

const FilterBarStub = defineComponent({
  name: 'FilterBarStub',
  props: { modelValue: { type: Object, required: true } },
  emits: ['update:modelValue', 'search'],
  render() {
    return h('button', { class: 'fb-search', onClick: () => this.$emit('search') }, '查询')
  },
})
stubs.filterBar = FilterBarStub
const RecordTableStub = defineComponent({
  name: 'RecordTableStub',
  props: { records: { type: Array, default: () => [] } },
  emits: ['go-session'],
  render() {
    return h('button', { class: 'rt-go', onClick: () => this.$emit('go-session', 42) }, '跳会话')
  },
})
stubs.recordTable = RecordTableStub
/** 分页替身：翻页按钮同时改 currentPage 并发 current-change（对齐 el-pagination 行为）。 */
const PaginationStub = defineComponent({
  name: 'PaginationStub',
  props: { currentPage: Number, pageSize: Number },
  emits: ['update:currentPage', 'update:pageSize', 'current-change', 'size-change'],
  render() {
    return h('button', { class: 'pg-next', onClick: () => {
      this.$emit('update:currentPage', 2)
      this.$emit('current-change', 2)
    } }, '下一页')
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
        // attrs 回退与显式 prop 同名时 Vue 会把 onClick 合并成函数数组，两种形态都要收
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

function mount(refreshKey = 0) {
  const closed = ref(0)
  // el-pagination 编译成 _component_el_pagination，在应用级解析；筛选栏/表格已按模块 mock，
  // 这里把分页替身注册成全局组件即可（不覆写 UsageDetailTab 组件对象本身）。
  const Host = defineComponent({
    render: () => h(DetailComponent as never, {
      refreshKey,
      onClose: () => { closed.value += 1 },
    } as never),
  })
  const { ops, handlers } = nodeOps()
  const { createApp } = createRenderer(ops as never)
  const root = ops.createElement('root')
  const app = createApp(Host)
  app.component('el-pagination', PaginationStub)
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
  return { click, closed }
}

beforeEach(() => {
  fetchCalls.length = 0
  pushed.length = 0
})

describe('UsageDetailTab 分页与筛选', () => {
  it('挂载即拉第 1 页', async () => {
    mount()
    await flush()
    expect(fetchCalls).toEqual([{ page: 1, size: 10, scene: undefined, modelId: undefined, success: undefined }])
  })

  it('翻到第 2 页后改筛选 → 回第 1 页重拉', async () => {
    const m = mount()
    await flush()
    m.click('下一页')
    await flush()
    expect(fetchCalls[fetchCalls.length - 1]).toMatchObject({ page: 2 })

    m.click('查询')
    await flush()
    // 整条请求序列的页码：挂载 1 → 翻页 2 → 改筛选回落 1
    expect(fetchCalls.map((c) => c.page)).toEqual([1, 2, 1])
    expect(fetchCalls[fetchCalls.length - 1]).toMatchObject({ size: 10 })
  })

  it('刷新令牌变化 → 重拉当前页（不回落第 1 页）', async () => {
    const m = mount(1)
    await flush()
    m.click('下一页')
    await flush()
    expect(fetchCalls.map((c) => c.page)).toEqual([1, 2])
  })

  it('点会话号 → 关闭抽屉并跳转任务', async () => {
    const m = mount()
    await flush()
    m.click('跳会话')
    await flush()
    expect(pushed).toEqual(['/tasks/42'])
    expect(m.closed.value).toBe(1)
  })
})
