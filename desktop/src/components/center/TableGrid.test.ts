// TableGrid 公共表格网格回归（技术方案 §5.3 / §5.5）：表头吸附标记、数值列右对齐
// 启发式、斑马纹、空数据、>200 行窗口化虚拟滚动（定高 padding 行 + scroll 窗口）。
// CSV 与 XLSX 共用本组件；挂载手法同 FileViewer.dispatch.test.ts（编译真实 SFC 模板）。
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import * as Vue from 'vue'
import { h, nextTick, defineComponent, createRenderer, ref } from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { compile } from '@vue/compiler-dom'

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useSSRContext: () => ({ modules: new Set(), scopeId: null, styles: '' }),
  }
})

import TableGrid from './TableGrid.vue'

const descriptor = parse(readFileSync(new URL('./TableGrid.vue', import.meta.url), 'utf8')).descriptor
const script = compileScript(descriptor, { id: 'table-grid' })
const compiled = compile(descriptor.template!.content, {
  mode: 'function',
  prefixIdentifiers: true,
  bindingMetadata: script.bindings,
})
const clientRender = new Function('Vue', compiled.code)(Vue) as (ctx: unknown, cache: unknown) => unknown

const ClientGrid = {
  ...(TableGrid as object),
  render: clientRender,
}

interface StubEl { tag: string; children: StubNode[]; parent: StubEl | null; props: Record<string, unknown>; style: Record<string, string>; scrollTop: number; clientHeight: number }
type StubNode = StubEl | { text: string; parent: StubEl | null }

function nodeOps() {
  const createElement = (tag: string): StubEl => ({ tag, children: [], parent: null, props: {}, style: {}, scrollTop: 0, clientHeight: 600 })
  const createText = (text: string): StubNode => ({ text, parent: null })
  return {
    createElement,
    createText,
    createComment: () => createText(''),
    setText: (n: StubNode, t: string) => { if ('text' in n) n.text = String(t) },
    setElementText: (el: StubEl, t: string) => { el.children = [{ text: t, parent: el }] },
    insert: (child: StubNode, parent: StubEl, anchor?: StubNode | null) => {
      child.parent = parent
      const at = anchor == null ? -1 : parent.children.indexOf(anchor)
      if (at < 0) parent.children.push(child)
      else parent.children.splice(at, 0, child)
    },
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

/** 样式绑定在 patchProp 里以整体对象落入 props.style（自定义渲染器口径） */
function styleHeight(el: StubEl): string | undefined {
  const style = el.props.style as { height?: string } | undefined
  return style?.height
}

function byClass(cls: string) {
  return (el: StubEl) => typeof el.props.class === 'string' && el.props.class.split(' ').includes(cls)
}

async function mountGrid(rows: string[][]): Promise<StubEl> {
  const Host = defineComponent({
    render: () => h(ClientGrid as never, { rows } as never),
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

function headerCells(root: StubEl): StubEl[] {
  return findAll(root, byTag('th'))
}

describe('TableGrid 渲染', () => {
  it('首行作表头，其余进 tbody', async () => {
    const root = await mountGrid([
      ['name', 'age'],
      ['ada', '36'],
      ['grace', '45'],
    ])
    expect(headerCells(root).map((el) => collectText(el))).toEqual(['name', 'age'])
    const firstBodyRow = findAll(root, byTag('tr')).find((tr) => tr.children.some((c) => !('text' in c) && c.tag === 'td'))
    expect(collectText(firstBodyRow!)).toContain('ada')
  })

  it('数值列右对齐：数据行 ≥80% 可 Number() 解析的列加 numeric', async () => {
    const root = await mountGrid([
      ['name', 'age', 'mixed'],
      ['ada', '36', '1'],
      ['grace', '45', 'x'],
      ['linus', '58', 'y'],
    ])
    const headers = headerCells(root)
    expect(headers[0].props.class).not.toContain('numeric')
    expect(headers[1].props.class).toContain('numeric')
    expect(headers[2].props.class).not.toContain('numeric')
    // 数据单元格同口径
    const firstRow = findAll(root, byTag('tr')).find((tr) => tr.children.some((c) => !('text' in c) && c.tag === 'td'))
    const cells = firstRow!.children.filter((c) => !('text' in c)) as StubEl[]
    expect(cells[1].props.class).toContain('numeric')
    expect(cells[0].props.class).not.toContain('numeric')
  })

  it('空 rows：无数据占位，不渲染表格', async () => {
    const root = await mountGrid([])
    expect(findAll(root, byTag('table'))).toHaveLength(0)
    expect(collectText(root)).toContain('无数据')
  })

  it('仅表头无数据行：渲染表头，无 tbody 行', async () => {
    const root = await mountGrid([['only', 'header']])
    expect(headerCells(root).map((el) => collectText(el))).toEqual(['only', 'header'])
    expect(findAll(root, byTag('td'))).toHaveLength(0)
  })
})

describe('TableGrid 虚拟滚动', () => {
  const manyRows: string[][] = [
    ['id', 'value'],
    ...Array.from({ length: 1000 }, (_, i) => [String(i), `v${i}`]),
  ]

  it('≤200 数据行：全量渲染，无 padding 行', async () => {
    const rows = [['a'], ...Array.from({ length: 100 }, (_, i) => [String(i)])]
    const root = await mountGrid(rows)
    expect(findAll(root, byClass('pad-row'))).toHaveLength(0)
    expect(findAll(root, byTag('tr')).length).toBe(101)
  })

  it('>200 数据行：padding 行撑滚动区，只渲染可视窗口', async () => {
    const root = await mountGrid(manyRows)
    const padRows = findAll(root, byClass('pad-row'))
    expect(padRows).toHaveLength(2)
    // 初始 scrollTop=0：padTop=0，padBottom ≈ (1000 - endIdx) * 32
    expect(styleHeight(padRows[0])).toBe('0px')
    const renderedRows = findAll(root, byTag('tr')).length - 1 - 2 // 去表头与两个 padding 行
    expect(renderedRows).toBeGreaterThan(0)
    expect(renderedRows).toBeLessThan(1000)
    expect(renderedRows).toBeLessThanOrEqual(20 + 2 * 10) // 视口 600px / 32 + 双侧 overscan
  })

  it('scroll 到中段：窗口随 scrollTop 平移，padTop 高度跟上', async () => {
    const root = await mountGrid(manyRows)
    const scrollEl = findAll(root, byClass('table-grid-scroll'))[0]
    // 滚到第 100 行顶部（100 * 32 = 3200）
    scrollEl.scrollTop = 3200
    const onScroll = scrollEl.props.onScrollPassive as (() => void) | undefined
    onScroll!()
    await flush()

    const padRows = findAll(root, byClass('pad-row'))
    // startIdx = 3200/32 - 10 = 90 → padTop = 90 * 32 = 2880
    expect(styleHeight(padRows[0])).toBe('2880px')
    // 首个渲染的数据行是第 90 行（scrollTop=3200 → startIdx=90，内容 id=90）
    const dataRows = findAll(root, byTag('tr')).filter((tr) =>
      tr.children.some((c) => !('text' in c) && c.tag === 'td'),
    )
    expect(collectText(dataRows[0]).trim()).toBe('90 v90')
  })

  it('换数据源（rows 引用变化）：滚动位置重置，窗口回到顶部', async () => {
    const rows = [['a'], ...Array.from({ length: 300 }, (_, i) => [String(i)])]
    const rowsRef = ref(rows)
    const Host = defineComponent({
      render: () => h(ClientGrid as never, { rows: rowsRef.value } as never),
    })
    const ops = nodeOps()
    const { createApp } = createRenderer(ops)
    const root = ops.createElement('root')
    const app = createApp(Host)
    const errors: unknown[] = []
    app.config.errorHandler = (err) => { errors.push(err) }
    app.mount(root as never)
    if (errors.length) throw errors[0]
    await flush()

    const scrollEl = findAll(root, byClass('table-grid-scroll'))[0]
    scrollEl.scrollTop = 3200
    ;(scrollEl.props.onScrollPassive as () => void)()
    await flush()

    // 换数据源：新数组引用
    rowsRef.value = [['a'], ...Array.from({ length: 300 }, (_, i) => [`n${i}`])]
    await flush()
    const padRows = findAll(root, byClass('pad-row'))
    expect(styleHeight(padRows[0])).toBe('0px')
  })
})
