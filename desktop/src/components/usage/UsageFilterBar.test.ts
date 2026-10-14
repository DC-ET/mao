// Node 环境无 DOM，用 compiler-dom 补客户端 render + 无 DOM 渲染器点按钮。
// 覆盖（设置页与抽屉明细 Tab 共用的筛选栏）：模型选项来自 /models/active；
// 选中模型后合并出新 filters（modelId）并触发查询；重置回落空筛选。
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as Vue from 'vue'
import { h, nextTick, ref, defineComponent, createRenderer } from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { compile } from '@vue/compiler-dom'

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useSSRContext: () => ({ modules: new Set(), scopeId: null, styles: '' }),
  }
})

const apiCalls: string[] = []
vi.mock('../../api', () => ({
  api: {
    get: async (url: string) => {
      apiCalls.push(url)
      return {
        data: [
          { id: 3, name: 'GPT-4', modelId: 'gpt-4' },
          { id: 5, name: 'Claude', modelId: 'claude-sonnet' },
        ],
      }
    },
  },
}))

import UsageFilterBar from './UsageFilterBar.vue'
import { EMPTY_USAGE_FILTERS, type UsageFilters } from './types'

const descriptor = parse(readFileSync(new URL('./UsageFilterBar.vue', import.meta.url), 'utf8')).descriptor
const script = compileScript(descriptor, { id: 'usage-filter-bar' })
const compiled = compile(descriptor.template!.content, {
  mode: 'function',
  prefixIdentifiers: true,
  bindingMetadata: script.bindings,
})
const clientRender = new Function('Vue', compiled.code)(Vue) as (ctx: unknown, cache: unknown) => unknown

const ElForm = defineComponent({ render() { return h('form', this.$slots.default?.() ?? []) } })
const ElFormItem = defineComponent({ render() { return h('div', this.$slots.default?.() ?? []) } })
/** v-for 选项被包在 Fragment 里（type 为 symbol），注释 vnode 同类；递归展平后只留带 props 的选项。 */
function collectOptionVnodes(nodes: unknown[]): Array<{ props: Record<string, unknown> }> {
  const out: Array<{ props: Record<string, unknown> }> = []
  for (const n of nodes) {
    const v = n as { type?: unknown; props?: Record<string, unknown> | null; children?: unknown } | null | undefined
    if (v == null) continue
    if (typeof v.type === 'symbol') {
      if (Array.isArray(v.children)) out.push(...collectOptionVnodes(v.children))
      continue
    }
    if (v.props != null) out.push({ props: v.props })
  }
  return out
}

const ElSelect = defineComponent({
  props: { modelValue: { type: [String, Number, Boolean], default: undefined } },
  render() {
    const options = collectOptionVnodes(this.$slots.default?.() ?? [])
    const attrs = this.$attrs as Record<string, unknown>
    return h('div', { class: 'el-select-stub' }, options.map((opt, i) =>
      h('button', {
        key: i,
        class: 'el-option-stub',
        'data-label': String(opt.props.label),
        onClick: () => {
          const handler = attrs['onUpdate:modelValue']
          if (typeof handler === 'function') (handler as (v: unknown) => void)(opt.props.value)
        },
      }, String(opt.props.label)),
    ))
  },
})
const ElOption = { props: ['value', 'label'], render() { return h('option') } }
const ElButton = defineComponent({
  props: { type: String, size: String, text: Boolean },
  render() {
    const attrs = this.$attrs as Record<string, unknown>
    return h('button', {
      class: 'el-button-stub',
      onClick: () => {
        if (typeof attrs.onClick === 'function') (attrs.onClick as () => void)()
      },
    }, this.$slots.default?.() ?? [])
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
        if (/^onClick/.test(key)) {
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

const FilterBarPanel = {
  ...(UsageFilterBar as object),
  components: { 'el-form': ElForm, ElForm, 'el-form-item': ElFormItem, ElFormItem, 'el-select': ElSelect, ElSelect, 'el-option': ElOption, ElOption, 'el-button': ElButton, ElButton },
  render: clientRender,
}

interface Emission {
  type: 'update' | 'search'
  value?: UsageFilters
}

function mount() {
  const emissions: Emission[] = []
  const filters = ref<UsageFilters>({ ...EMPTY_USAGE_FILTERS })
  const Host = defineComponent({
    render: () => h(FilterBarPanel as never, {
      modelValue: filters.value,
      'onUpdate:modelValue': (v: UsageFilters) => { emissions.push({ type: 'update', value: v }); filters.value = v },
      onSearch: () => { emissions.push({ type: 'search' }) },
    } as never),
  })
  const { ops, handlers } = nodeOps()
  const { createApp } = createRenderer(ops as never)
  const root = ops.createElement('root')
  const app = createApp(Host)
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
  const clickButton = (pred: (el: StubEl) => boolean, label: string) => {
    const hit = findAll(el => el.tag === 'button' && pred(el))[0]
    if (!hit) {
      const buttons = findAll(el => el.tag === 'button').map(el => subtreeText(el)).join(' | ')
      throw new Error(`button not found: ${label}; buttons=${buttons || '(none)'}`)
    }
    const arr = handlers.get(hit)
    if (!arr || !arr.length) throw new Error(`no click handler on: ${label}`)
    return arr[arr.length - 1]!()
  }
  return {
    emissions,
    filters,
    optionTexts: () => findAll(el => String(el.props.class ?? '').includes('el-option-stub')).map(el => subtreeText(el)),
    clickOption: (label: string) => clickButton(el => subtreeText(el) === label, `option ${label}`),
    clickReset: () => clickButton(el => subtreeText(el).includes('重置'), '重置'),
  }
}

beforeEach(() => {
  apiCalls.length = 0
})

describe('UsageFilterBar 模型筛选', () => {
  it('挂载即拉 /models/active，模型下拉渲染模型名选项', async () => {
    const m = mount()
    await flush()
    expect(apiCalls).toContain('/models/active')
    expect(m.optionTexts()).toContain('GPT-4')
    expect(m.optionTexts()).toContain('Claude')
  })

  it('选中模型 → 合并出 modelId 并触发查询', async () => {
    const m = mount()
    await flush()
    m.clickOption('GPT-4')
    await flush()
    expect(m.emissions).toEqual([
      { type: 'update', value: { scene: '', modelId: 3, success: undefined } },
      { type: 'search' },
    ])
  })

  it('选中「取消」→ 合并出 cancelled=true 并清空成败（取消单列一档，不是失败）', async () => {
    const m = mount()
    await flush()
    m.clickOption('取消')
    await flush()
    expect(m.emissions).toEqual([
      { type: 'update', value: { scene: '', modelId: undefined, success: undefined, cancelled: true } },
      { type: 'search' },
    ])
  })

  it('选中「失败」→ 纯失败（cancelled 清空，不再混入用户取消）', async () => {
    const m = mount()
    await flush()
    m.clickOption('失败')
    await flush()
    expect(m.emissions).toEqual([
      { type: 'update', value: { scene: '', modelId: undefined, success: false, cancelled: undefined } },
      { type: 'search' },
    ])
  })

  it('重置 → 回落空筛选并触发查询', async () => {
    const m = mount()
    await flush()
    m.clickOption('Claude')
    await flush()
    m.clickReset()
    await flush()
    const last = m.emissions[m.emissions.length - 2]
    expect(last).toEqual({ type: 'update', value: { ...EMPTY_USAGE_FILTERS } })
    expect(m.emissions[m.emissions.length - 1]).toEqual({ type: 'search' })
  })
})
