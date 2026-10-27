// Node 环境无 DOM：手动编译模板补客户端 render，用无 DOM 渲染器挂载。
// 覆盖「吞吐」列（技术方案 2026-10-27-llm-output-speed §4.1）：流式行按
// 输出 tokens ÷ 解码耗时显示 tok/s，非流式行（firstTokenMs 缺失）显示「—」。
// el-table 桩按 data 逐行调用各列 default 插槽（scope.row），绕过真实表格实现。
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import * as Vue from 'vue'
import { h, nextTick, defineComponent, createRenderer } from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { compile } from '@vue/compiler-dom'

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useSSRContext: () => ({ modules: new Set(), scopeId: null, styles: '' }),
  }
})

import UsageRecordTable from './UsageRecordTable.vue'
import type { MyLlmCallRecord } from '../../api'

const descriptor = parse(readFileSync(new URL('./UsageRecordTable.vue', import.meta.url), 'utf8')).descriptor
const compiledScript = compileScript(descriptor, { id: 'usage-record-table' })
const compiledTemplate = compile(descriptor.template!.content, {
  mode: 'function',
  prefixIdentifiers: true,
  bindingMetadata: compiledScript.bindings,
})
const clientRender = new Function('Vue', compiledTemplate.code)(Vue) as (ctx: unknown, cache: unknown) => unknown
const RecordTableComponent = {
  ...(UsageRecordTable as object),
  render: clientRender,
}

/** el-table 桩：按 data 逐行渲染，每格调用对应列 default 插槽并传入 { row }。 */
const ElTable = defineComponent({
  name: 'ElTableStub',
  props: { data: { type: Array, default: () => [] }, loading: Boolean },
  render() {
    const cols = (this.$slots.default?.() ?? []) as Array<{ children?: { default?: (scope: unknown) => unknown } }>
    return h('table', {}, this.data.map((row: unknown, ri: number) =>
      h('tr', { key: ri }, cols.map((col, ci) =>
        h('td', { key: ci }, (col.children?.default?.({ row }) as never) ?? null),
      )),
    ))
  },
})
const ElTableColumn = defineComponent({ name: 'ElTableColumnStub', props: { label: String }, render() { return h('th') } })
const ElEmpty = defineComponent({ name: 'ElEmptyStub', render() { return h('div') } })
const ElTag = defineComponent({ name: 'ElTagStub', props: { type: String, size: String }, render() { return h('span', this.$slots.default?.()) } })
const ElButton = defineComponent({ name: 'ElButtonStub', render() { return h('button', this.$slots.default?.()) } })

function record(overrides: Partial<MyLlmCallRecord>): MyLlmCallRecord {
  return {
    id: 1,
    createdAt: '2026-10-10 16:00:00',
    scene: 'agent',
    modelName: 'step-5',
    providerModelId: 'step-5',
    promptTokens: 1000,
    completionTokens: 170,
    cachedTokens: 0,
    totalTokens: 1170,
    firstTokenMs: null,
    durationMs: 4200,
    success: 1,
    cancelled: 0,
    sessionId: 42,
    ...overrides,
  }
}

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
      patchProp: () => {},
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

/** 挂载并返回各行（tr）的文本，按 records 顺序。 */
async function mountRows(records: MyLlmCallRecord[]): Promise<string[]> {
  const Host = defineComponent({
    render: () => h(RecordTableComponent as never, { records } as never),
  })
  const { ops } = nodeOps()
  const { createApp } = createRenderer(ops as never)
  const root = ops.createElement('root')
  const app = createApp(Host)
  // el-table 上的 v-loading：测试环境未装 Element Plus，注册同名的空指令占位
  app.directive('loading', {})
  app.component('el-table', ElTable)
  app.component('el-table-column', ElTableColumn)
  app.component('el-empty', ElEmpty)
  app.component('el-tag', ElTag)
  app.component('el-button', ElButton)
  const errors: unknown[] = []
  app.config.warnHandler = () => {}
  app.config.errorHandler = (err) => { errors.push(err) }
  app.mount(root as never)
  if (errors.length) throw errors[0]
  await flush()
  const rows: StubEl[] = []
  const walk = (el: StubEl) => {
    if (el.tag === 'tr') rows.push(el)
    for (const c of el.children) if (!('text' in c)) walk(c)
  }
  walk(root)
  return rows.map(subtreeText)
}

describe('UsageRecordTable 吞吐列', () => {
  it('流式行显示 tok/s（输出 tokens ÷ 解码耗时）', async () => {
    // 解码 3400ms、输出 170 tokens → 50.0 tok/s
    const [row] = await mountRows([record({ firstTokenMs: 800 })])
    expect(row).toContain('50.0 tok/s')
  })

  it('非流式行（firstTokenMs 缺失）显示「—」，不用总耗时兜底', async () => {
    const [row] = await mountRows([record({ firstTokenMs: null })])
    expect(row).toContain('—')
    expect(row).not.toContain('tok/s')
  })

  it('输出为 0 的失败行显示「—」，不显示 0 tok/s 误导', async () => {
    const [row] = await mountRows([record({ firstTokenMs: 800, completionTokens: 0, success: 0 })])
    expect(row).toContain('—')
    expect(row).not.toContain('tok/s')
  })
})
