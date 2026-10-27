// SpreadsheetView 接线回归（技术方案 §5.5 / §9）：exceljs 动态 import 后抽行进
// TableGrid、sheet tab 切换、三条上限降级、hover 复制工具条序列化口径、
// 加载代际守卫。手法同 CsvTableView.test.ts：编译真实 SFC 模板 + mock 掉
// TableGrid 子组件（vitest SSR 模式不编译子组件模板）与 exceljs。
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as Vue from 'vue'
import { h, nextTick, ref, isRef, defineComponent, createRenderer, type Ref } from 'vue'
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

// ---- exceljs mock：默认导入的 Workbook，load 行为由 mock 内 state 注入 ----
// state 挂在 mock 模块自身上随 import 取回：跨 SFC 动态 import 边界保持同一
// 份对象（vi.hoisted 闭包在该边界下会拿到不同绑定，实测断言不到）
interface FakeSheet {
  name: string
  rowCount: number
  getRow: (r: number) => { values: unknown[] }
}

interface ExcelMockState {
  loadArgs: unknown[]
  error: Error | null
  sheets: FakeSheet[]
  /** 测试置 true 时 load 挂起，resolvers 逐个放行（过期响应守卫用） */
  defer: boolean
  resolvers: Array<() => void>
}

vi.mock('exceljs', () => {
  const state: ExcelMockState = {
    loadArgs: [],
    error: null,
    sheets: [],
    defer: false,
    resolvers: [],
  }
  class MockWorkbook {
    worksheets: FakeSheet[] = []
    xlsx = {
      load: async (data: unknown) => {
        state.loadArgs.push(data)
        if (state.error) throw state.error
        if (state.defer) {
          await new Promise<void>((resolve) => {
            state.resolvers.push(resolve)
          })
        }
        this.worksheets = state.sheets
      },
    }
  }
  return { default: { Workbook: MockWorkbook }, __mockState: state }
})

import * as exceljsMock from 'exceljs'

const excelState = (exceljsMock as unknown as { __mockState: ExcelMockState }).__mockState

// TableGrid 用 stub 记录 rows props（真实模板由 TableGrid.test.ts 覆盖）
const gridRows: string[][][] = []
vi.mock('./TableGrid.vue', () => ({
  default: defineComponent({
    props: { rows: Array },
    render() {
      gridRows.push(this.$props.rows as string[][])
      return h('table', { class: 'grid-stub' }, 'grid')
    },
  }),
}))

// xlsx-extract 不 mock——被接线的正是它（假 sheet 喂进真抽取函数）
import SpreadsheetView from './SpreadsheetView.vue'

const descriptor = parse(readFileSync(new URL('./SpreadsheetView.vue', import.meta.url), 'utf8')).descriptor
const script = compileScript(descriptor, { id: 'spreadsheet-view' })
const compiled = compile(descriptor.template!.content, {
  mode: 'function',
  prefixIdentifiers: true,
  bindingMetadata: script.bindings,
})
const clientRender = new Function('Vue', compiled.code)(Vue) as (ctx: unknown, cache: unknown) => unknown

const ClientSheet = {
  ...(SpreadsheetView as object),
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

// exceljs 动态 import 经 vitest 模块运行时加载，纯微任务 flush 等不到：
// 每轮补一个 setTimeout(0) 宏任务让位（同 ArchiveBrowser.test.ts）
async function flush(rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function collectText(node: StubNode | null): string {
  if (node == null) return ''
  if ('text' in node) return node.text
  return node.children.map((child) => collectText(child)).join(' ')
}

function flatText(root: StubEl): string {
  return collectText(root).replace(/\s+/g, ' ')
}

function findAll(node: StubNode | null, pred: (el: StubEl) => boolean): StubEl[] {
  if (node == null || 'text' in node) return []
  const self = pred(node) ? [node] : []
  return [...self, ...node.children.flatMap((child) => findAll(child, pred))]
}

function byClass(cls: string) {
  return (el: StubEl) => typeof el.props.class === 'string' && el.props.class.split(' ').includes(cls)
}

function byTag(tag: string) {
  return (el: StubEl) => el.tag === tag
}

function click(el: StubEl) {
  ;(el.props.onClick as (() => void) | undefined)?.()
}

function sheet(name: string, rows: unknown[][]): FakeSheet {
  return {
    name,
    rowCount: rows.length,
    getRow: (r: number) => ({ values: [null, ...(rows[r - 1] ?? [])] }),
  }
}

async function mountSheet(
  bytes: Uint8Array | Ref<Uint8Array>,
  provider: Record<string, unknown> | null = null,
): Promise<StubEl> {
  // 传 ref 时 Host 渲染其当前值：测试改 .value 即触发重渲染与 bytes watch
  const bytesRef = isRef(bytes) ? bytes : ref(bytes)
  const Host = defineComponent({
    render: () => h(ClientSheet as never, { filePath: 'report.xlsx', bytes: bytesRef.value, provider } as never),
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

const smallBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04])

describe('SpreadsheetView 解析与渲染', () => {
  beforeEach(() => {
    copiedTexts.length = 0
    gridRows.length = 0
    excelState.loadArgs.length = 0
    excelState.error = null
    excelState.sheets = []
    excelState.defer = false
    excelState.resolvers.length = 0
  })

  it('解析成功：exceljs 收到字节，行数组进 TableGrid，工具条显示行列数', async () => {
    excelState.sheets = [sheet('Sheet1', [['name', 'age'], ['ada', 36], ['grace', 45]])]
    const root = await mountSheet(smallBytes)

    expect(excelState.loadArgs).toHaveLength(1)
    expect(gridRows).toHaveLength(1)
    expect(gridRows[0]).toEqual([['name', 'age'], ['ada', '36'], ['grace', '45']])
    expect(flatText(root)).toContain('report.xlsx')
    expect(flatText(root)).toContain('3 行 × 2 列')
  })

  it('多 sheet：渲染 tab，点击第二个 tab 切换 TableGrid 数据源', async () => {
    excelState.sheets = [
      sheet('一季', [['q', 'v'], ['Q1', 1]]),
      sheet('二季', [['q', 'v'], ['Q2', 2]]),
    ]
    const root = await mountSheet(smallBytes)

    const tabs = findAll(root, byClass('sheet-tab'))
    expect(tabs).toHaveLength(2)
    expect(flatText(root)).toContain('2 个工作表')
    expect(gridRows[gridRows.length - 1]).toEqual([['q', 'v'], ['Q1', '1']])

    click(tabs[1])
    await flush()
    expect(gridRows[gridRows.length - 1]).toEqual([['q', 'v'], ['Q2', '2']])
    expect(tabs[1].props.class).toContain('active')
  })

  it('单 sheet：不渲染 sheet tab', async () => {
    excelState.sheets = [sheet('Only', [['a'], ['b']])]
    const root = await mountSheet(smallBytes)
    expect(findAll(root, byClass('sheet-tab'))).toHaveLength(0)
  })

  it('文件超 20MB：字节上限先行，不进 exceljs，降级「表格过大」', async () => {
    const big = new Uint8Array(20 * 1024 * 1024 + 1)
    const root = await mountSheet(big)
    expect(excelState.loadArgs).toHaveLength(0)
    expect(flatText(root)).toContain('表格过大，请下载后查看')
    expect(gridRows).toHaveLength(0)
  })

  it('单 sheet 行数超限：extractWorkbook 判 ok:false，整体降级不半截渲染', async () => {
    excelState.sheets = [
      sheet('S', Array.from({ length: 50_001 }, () => ['x'])),
    ]
    const root = await mountSheet(smallBytes)
    expect(flatText(root)).toContain('表格过大，请下载后查看')
    expect(gridRows).toHaveLength(0)
  })

  it('exceljs 解析失败：错误态展示原因，提供下载出口', async () => {
    excelState.error = new Error('Corrupted zip: CRC32 mismatch')
    const downloadCalls: string[] = []
    const provider = {
      downloadFile: async (path: string, name: string) => {
        downloadCalls.push(`${path}:${name}`)
        return { ok: true }
      },
    }
    const root = await mountSheet(smallBytes, provider)
    expect(flatText(root)).toContain('Corrupted zip: CRC32 mismatch')
    const dlBtn = findAll(root, byClass('retry-btn'))[0]
    expect(dlBtn).toBeDefined()
    click(dlBtn)
    await flush()
    expect(downloadCalls).toEqual(['report.xlsx:report.xlsx'])
  })

  it('LOCAL 超上限（无 downloadFile）：降级态给「在 Finder 中显示」出口，不是死路（review round1 #5）', async () => {
    const shown: string[] = []
    ;(globalThis as unknown as { window?: unknown }).window = {
      electronAPI: { showItemInFolder: (p: string) => { shown.push(p) } },
    }
    try {
      // LOCAL provider 形态：只有 getAbsolutePath，没有 downloadFile
      const provider = { getAbsolutePath: (p: string) => `/Users/u/work/${p}` }
      const root = await mountSheet(new Uint8Array(20 * 1024 * 1024 + 1), provider)

      expect(flatText(root)).toContain('表格过大，请下载后查看')
      const finderBtn = findAll(root, byClass('retry-btn')).find((el) => collectText(el).includes('在 Finder 中显示'))
      expect(finderBtn).toBeDefined()
      click(finderBtn!)
      await flush()
      expect(shown).toEqual(['/Users/u/work/report.xlsx'])
    } finally {
      delete (globalThis as unknown as { window?: unknown }).window
    }
  })

  it('hover 复制工具条：复制 CSV / Markdown 序列化当前 sheet 行数组', async () => {
    excelState.sheets = [sheet('S', [['name', 'age'], ['ada', 36]])]
    const root = await mountSheet(smallBytes)

    const scroll = findAll(root, byClass('sheet-scroll'))[0]
    ;(scroll.props.onMouseenter as (() => void) | undefined)?.()
    await flush()

    const csvBtn = findAll(root, byTag('button')).find((b) => collectText(b).includes('复制 CSV'))
    click(csvBtn!)
    await flush()
    expect(copiedTexts).toEqual(['name,age\r\nada,36'])

    const mdBtn = findAll(root, byTag('button')).find((b) => collectText(b).includes('复制 Markdown'))
    click(mdBtn!)
    await flush()
    expect(copiedTexts[1]).toBe('| name | age |\n| --- | --- |\n| ada | 36 |')
  })

  it('复制内容跟随当前 sheet：切 tab 后复制第二个 sheet', async () => {
    excelState.sheets = [
      sheet('A', [['a'], ['1']]),
      sheet('B', [['b'], ['2']]),
    ]
    const root = await mountSheet(smallBytes)
    const tabs = findAll(root, byClass('sheet-tab'))
    click(tabs[1])
    await flush()

    const scroll = findAll(root, byClass('sheet-scroll'))[0]
    ;(scroll.props.onMouseenter as (() => void) | undefined)?.()
    await flush()
    const csvBtn = findAll(root, byTag('button')).find((b) => collectText(b).includes('复制 CSV'))
    click(csvBtn!)
    await flush()
    expect(copiedTexts).toEqual(['b\r\n2'])
  })

  it('刷新按钮：emit refresh 交回 FileViewer 重走 dispatch，不在本地重解析同一份字节（round2 #2 / §5.8）', async () => {
    excelState.sheets = [sheet('S', [['a'], ['1']])]
    const refreshes: number[] = []
    const Host = defineComponent({
      emits: ['refresh'],
      render() {
        return h(ClientSheet as never, {
          filePath: 'report.xlsx',
          bytes: smallBytes,
          provider: null,
          onRefresh: () => refreshes.push(1),
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
    await flush()
    expect(excelState.loadArgs).toHaveLength(1)

    const refreshBtn = findAll(root, byClass('tool-btn')).find((el) => el.props.title === '刷新')
    expect(refreshBtn).toBeDefined()
    click(refreshBtn!)
    await flush()

    // emit 出去由 FileViewer 重新 readFileBytes（能拿到磁盘新内容），本地不重解析
    expect(refreshes).toEqual([1])
    expect(excelState.loadArgs).toHaveLength(1)
  })

  it('过期响应守卫：旧 bytes 的迟到解析不覆盖新文件内容（A2）', async () => {
    excelState.defer = true
    excelState.sheets = [sheet('Old', [['old'], ['1']])]
    const bytesRef = ref(smallBytes)
    const root = await mountSheet(bytesRef)
    // 第一个 load 已挂起；切到新 bytes 触发第二个 load
    excelState.sheets = [sheet('New', [['new'], ['2']])]
    bytesRef.value = new Uint8Array([9, 9])
    await flush()
    expect(excelState.resolvers).toHaveLength(2)

    // 先放行新请求（后发起），再放行迟到的旧请求
    excelState.resolvers[1]()
    await flush()
    excelState.sheets = [sheet('Stale', [['stale'], ['3']])]
    excelState.resolvers[0]()
    await flush()

    expect(gridRows[gridRows.length - 1]).toEqual([['new'], ['2']])
    expect(flatText(root)).toContain('report.xlsx')
  })
})
