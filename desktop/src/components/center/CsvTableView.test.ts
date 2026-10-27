// CsvTableView 接线回归（技术方案 §5.3 / §9）：解析结果交给 TableGrid、hover 复制
// 工具条序列化口径（tableToCsv / rowsToMarkdown 复用）、截断提示（readFile 截断与
// 解析器触顶两条来源）。表格自身渲染 / 数值列 / 虚拟滚动由 TableGrid.test.ts 覆盖。
// 手法同 FileViewer.dispatch.test.ts。
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
    useSSRContext: () => ({ modules: new Set(), scopeId: null, styles: '' }),
  }
})

// clipboard 在 node 环境不可用：mock 掉 copyWithFallback 只断言序列化文本
const copiedTexts: string[] = []
vi.mock('../../utils/codeCopy', () => ({
  copyWithFallback: (text: string) => {
    copiedTexts.push(text)
  },
}))

vi.mock('@element-plus/icons-vue', () => ({
  Refresh: { render: () => null },
  Download: { render: () => null },
}))

// vitest 的 SSR 模式不编译子组件模板（plugin-vue 只转 script）：TableGrid 必须
// mock 成 stub 并记录 props，表格自身渲染由 TableGrid.test.ts 覆盖（同 RunTracePanel 范式）
const gridRows: string[][][] = []
vi.mock('./TableGrid.vue', () => ({
  default: defineComponent({
    props: { rows: { type: Array, required: true } },
    render() {
      gridRows.push(this.rows as string[][])
      const rows = this.rows as string[][]
      const header = rows[0] ?? []
      return h('table', { class: 'grid-stub' }, [
        h('thead', {}, [
          h('tr', {}, header.map((cell, col) => h('th', { key: col }, cell))),
        ]),
        h('tbody', {}, rows.slice(1).map((row, i) =>
          h('tr', { key: i }, row.map((cell, col) => h('td', { key: col }, cell))),
        )),
      ])
    },
  }),
}))

// csv-parse / tableCopy 用真实模块——被接线的正是它们
import CsvTableView from './CsvTableView.vue'

const descriptor = parse(readFileSync(new URL('./CsvTableView.vue', import.meta.url), 'utf8')).descriptor
const script = compileScript(descriptor, { id: 'csv-table-view' })
const compiled = compile(descriptor.template!.content, {
  mode: 'function',
  prefixIdentifiers: true,
  bindingMetadata: script.bindings,
})
const clientRender = new Function('Vue', compiled.code)(Vue) as (ctx: unknown, cache: unknown) => unknown

const ClientTable = {
  ...(CsvTableView as object),
  render: clientRender,
}

interface StubEl { tag: string; children: StubNode[]; parent: StubEl | null; props: Record<string, unknown>; style: Record<string, string> }
type StubNode = StubEl | { text: string; parent: StubEl | null }

function nodeOps() {
  const createElement = (tag: string): StubEl => ({ tag, children: [], parent: null, props: {}, style: {} })
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
    insertStaticContent: () => [createElement('static-start'), createElement('static-end')] as [StubEl, StubEl],
    patchProp: (el: StubEl, key: string, _prev: unknown, next: unknown) => { el.props[key] = next },
  }
}

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) { await Promise.resolve(); await nextTick() }
}

function collectText(node: StubNode | null): string {
  if (node == null) return ''
  if ('text' in node) return node.text
  return node.children.map((child) => collectText(child)).join(' ')
}

function findAll(node: StubNode | null, pred: (el: StubEl) => boolean): StubEl[] {
  if (node == null || 'text' in node) return []
  const self = pred(node) ? [node] : []
  return [...self, ...node.children.flatMap((child) => findAll(child, pred))]
}

function byTag(tag: string) {
  return (el: StubEl) => el.tag === tag
}

function byClass(cls: string) {
  return (el: StubEl) => typeof el.props.class === 'string' && el.props.class.split(' ').includes(cls)
}

async function mountTable(content: string, truncated = false): Promise<StubEl> {
  const Host = defineComponent({
    render: () =>
      h(ClientTable as never, { filePath: 'data.csv', content, truncated, provider: null } as never),
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

/** stub DOM 的 click 处理器存在元素 props 里（patchProp 落盘），取出即触发 */
function click(el: StubEl) {
  ;(el.props.onClick as (() => void) | undefined)?.()
}

describe('CsvTableView 渲染接线', () => {
  beforeEach(() => {
    copiedTexts.length = 0
    gridRows.length = 0
  })

  it('解析结果交给 TableGrid：首行表头 + 数据行，元信息显示行列数', async () => {
    const root = await mountTable('name,age\nada,36\ngrace,45')
    // stub 记录收到的 rows（真实表格渲染 / 数值列对齐由 TableGrid.test.ts 覆盖）
    expect(gridRows).toEqual([[['name', 'age'], ['ada', '36'], ['grace', '45']]])
    // stub 自身渲染的表头 / 数据行
    const headers = findAll(root, byTag('th')).map((el) => collectText(el))
    expect(headers).toEqual(['name', 'age'])
    expect(collectText(root)).toContain('3 行 × 2 列')
  })

  it('解析触顶（行数超上限）时交给 TableGrid 的已是截断后的行集', async () => {
    const content = Array.from({ length: 5001 }, (_, i) => `r${i}`).join('\n')
    await mountTable(content, false)
    expect(gridRows[0]).toHaveLength(5000)
    expect(gridRows[0][0]).toEqual(['r0'])
  })

  it('空内容：TableGrid 收到空行集', async () => {
    await mountTable('')
    expect(gridRows).toEqual([[]])
  })

  it('readFile 截断（total_lines > 5000）→ 展示截断提示', async () => {
    const root = await mountTable('a,b\n1,2', true)
    expect(findAll(root, byClass('truncation-notice')).length).toBeGreaterThan(0)
    expect(collectText(root)).toContain('仅显示前 5000 行')
  })

  it('解析器自身触顶（行数超上限）→ 同样展示截断提示', async () => {
    const content = Array.from({ length: 5001 }, (_, i) => `r${i}`).join('\n')
    const root = await mountTable(content, false)
    expect(findAll(root, byClass('truncation-notice')).length).toBeGreaterThan(0)
  })

  it('未截断 → 无截断提示', async () => {
    const root = await mountTable('a,b\n1,2', false)
    expect(findAll(root, byClass('truncation-notice'))).toHaveLength(0)
  })
})

describe('CsvTableView 复制工具条', () => {
  beforeEach(() => {
    copiedTexts.length = 0
    gridRows.length = 0
  })

  it('复制 CSV：tableToCsv(rows) 口径（含表头，逗号 + CRLF）', async () => {
    const root = await mountTable('name,age\nada,36')
    const csvBtn = findAll(root, byTag('button')).find((b) => collectText(b).includes('复制 CSV'))
    expect(csvBtn).toBeDefined()
    click(csvBtn!)
    await flush()
    expect(copiedTexts).toEqual(['name,age\r\nada,36'])
  })

  it('复制 Markdown：rowsToMarkdown(rows) 口径（管道表 + 对齐行）', async () => {
    const root = await mountTable('name,age\nada,36')
    const mdBtn = findAll(root, byTag('button')).find((b) => collectText(b).includes('复制 Markdown'))
    expect(mdBtn).toBeDefined()
    click(mdBtn!)
    await flush()
    expect(copiedTexts).toEqual(['| name | age |\n| --- | --- |\n| ada | 36 |'])
  })

  it('含逗号 / 引号 / 换行的单元格复制时按 CSV 转义', async () => {
    const root = await mountTable('a,b\n"x,y","say ""hi"""')
    const csvBtn = findAll(root, byTag('button')).find((b) => collectText(b).includes('复制 CSV'))
    click(csvBtn!)
    await flush()
    expect(copiedTexts).toEqual(['a,b\r\n"x,y","say ""hi"""'])
  })
})
