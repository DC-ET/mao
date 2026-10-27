// FileViewer dispatch 回归（技术方案 §9）：新增预览格式改道 + 既有路径不回归。
// 覆盖：csv 文本改道表格 / zip 扩展名早返回字节分支 / xlsx 扩展名早返回 +
// sniff xlsx 兜底改道 / docx 扩展名早返回 / project 模式无字节通道降级 / 快速切文件过期响应守卫 /
// md·txt·pdf 既有路径不进入新分支且 Monaco 不被新态误激活（§6-A1/A2/A4/H2）。
// 手法同 run-trace-panel-session.test.ts：mock 掉重依赖与子组件，编译真实
// SFC 模板走 $setup 绑定，自绘 nodeOps 挂载。
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as Vue from 'vue'
import { h, nextTick, ref, defineComponent, createRenderer } from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { compile } from '@vue/compiler-dom'
import JSZip from 'jszip'
import type { WorkspaceFileProvider } from '../../composables/workspace-file-provider'

// scoped 样式让 SFC setup 走 useSSRContext 取 CSS modules 上下文，node 环境下
// currentInstance 不在 SSR 渲染中返回 undefined——按既有用例同款 mock 兜底
vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useSSRContext: () => ({ modules: new Set(), scopeId: null, styles: '' }),
  }
})

// ---- mock：Monaco / 子组件 / store / 主题 / 外链（编译模板的 import 绑定只能靠 mock 替换）----
const monacoCalls: Array<{ enabled: { value: boolean }; filePath: string }> = []

vi.mock('../../composables/useMonacoViewer', () => ({
  useMonacoViewer: (opts: { enabled: { value: boolean }; filePath: { value: string } }) => {
    monacoCalls.push({ enabled: opts.enabled, filePath: opts.filePath.value })
  },
}))

const csvProps: Array<Record<string, unknown>> = []
vi.mock('./CsvTableView.vue', () => ({
  default: defineComponent({
    props: { filePath: String, content: String, truncated: Boolean, provider: Object },
    emits: ['refresh'],
    render() {
      csvProps.push({ ...this.$props })
      return h('div', { class: 'csv-stub' }, 'csv-table')
    },
  }),
}))

const archiveProps: Array<Record<string, unknown>> = []
vi.mock('./ArchiveBrowser.vue', () => ({
  default: defineComponent({
    props: { filePath: String, fileName: String, bytes: Object, provider: Object },
    emits: ['refresh'],
    render() {
      archiveProps.push({ ...this.$props })
      return h('div', { class: 'archive-stub' }, 'archive')
    },
  }),
}))

const spreadsheetProps: Array<Record<string, unknown>> = []
vi.mock('./SpreadsheetView.vue', () => ({
  default: defineComponent({
    props: { filePath: String, bytes: Object, provider: Object },
    emits: ['refresh'],
    render() {
      spreadsheetProps.push({ ...this.$props })
      return h('div', { class: 'spreadsheet-stub' }, 'spreadsheet')
    },
  }),
}))

const docxProps: Array<Record<string, unknown>> = []
vi.mock('./DocxPreview.vue', () => ({
  default: defineComponent({
    props: { filePath: String, bytes: Object, provider: Object },
    emits: ['refresh'],
    render() {
      docxProps.push({ ...this.$props })
      return h('div', { class: 'docx-stub' }, 'docx')
    },
  }),
}))

const mediaProps: Array<Record<string, unknown>> = []
vi.mock('./MediaPlayer.vue', () => ({
  default: defineComponent({
    props: { filePath: String, bytes: Object, provider: Object },
    emits: ['refresh'],
    render() {
      mediaProps.push({ ...this.$props })
      return h('div', { class: 'media-stub' }, 'media')
    },
  }),
}))

const pdfProps: Array<Record<string, unknown>> = []
vi.mock('./PdfViewer.vue', () => ({
  default: defineComponent({
    props: { blobUrl: String, filePath: String, fileName: String, provider: Object },
    render() {
      pdfProps.push({ ...this.$props })
      return h('div', { class: 'pdf-stub' }, 'pdf')
    },
  }),
}))

vi.mock('../common/MarkdownContent.vue', () => ({
  default: defineComponent({
    render() {
      return h('div', { class: 'md-stub' }, 'md')
    },
  }),
}))

vi.mock('../../composables/useCenterTabs', () => ({
  useCenterTabs: () => ({ openFileTab: vi.fn() }),
}))

vi.mock('../../stores/session', () => ({
  useSessionStore: () => ({ activeSessionId: '11', activeFileChanges: [] }),
}))

vi.mock('../../utils/theme', () => ({
  useTheme: () => ({ isDark: ref(false) }),
}))

vi.mock('../../utils/markdown-link', () => ({
  isExternalMarkdownLink: () => false,
  resolveMarkdownLink: () => null,
}))

vi.mock('../../utils/capacitor', () => ({
  openExternalUrl: vi.fn(),
}))

vi.mock('@element-plus/icons-vue', () => ({
  Refresh: { render: () => null },
  Download: { render: () => null },
}))

// file-preview-format 不 mock——判定纯函数正是被接线的一方
import FileViewer from './FileViewer.vue'

const descriptor = parse(readFileSync(new URL('./FileViewer.vue', import.meta.url), 'utf8')).descriptor
const script = compileScript(descriptor, { id: 'file-viewer-dispatch' })
const compiled = compile(descriptor.template!.content, {
  mode: 'function',
  prefixIdentifiers: true,
  bindingMetadata: script.bindings,
})
const clientRender = new Function('Vue', compiled.code)(Vue) as (ctx: unknown, cache: unknown) => unknown

const ClientViewer = {
  ...(FileViewer as object),
  render: clientRender,
}

interface StubEl { tag: string; children: StubNode[]; parent: StubEl | null; props: Record<string, unknown> }
type StubNode = StubEl | { text: string; parent: StubEl | null }

function nodeOps() {
  const createElement = (tag: string): StubEl => ({ tag, children: [], parent: null, props: {} })
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

function flatText(root: StubEl): string {
  return collectText(root).replace(/\s+/g, ' ')
}

function findAllByClass(node: StubNode | null, cls: string): StubEl[] {
  if (node == null || 'text' in node) return []
  const self = typeof node.props.class === 'string' && node.props.class.split(' ').includes(cls) ? [node] : []
  return [...self, ...node.children.flatMap((child) => findAllByClass(child, cls))]
}

interface ProviderImpl {
  readFile?: (path: string, opts?: { offset?: number; limit?: number }) => Promise<Record<string, unknown>>
  readFileBytes?: (path: string) => Promise<{ bytes?: Uint8Array; size?: number; error?: string }>
  previewFile?: (path: string) => Promise<{ blob?: Blob; error?: string }>
}

/** 记录真实调用序列（readFile / readFileBytes / previewFile + 路径）用于断言分支 */
function makeProvider(impl: ProviderImpl = {}): { provider: WorkspaceFileProvider; calls: string[] } {
  const calls: string[] = []
  const provider: WorkspaceFileProvider = {
    listDirectory: async () => ({ entries: [] }),
    searchFiles: async () => ({}),
    readFile: async (path, opts) => {
      calls.push(`readFile:${path}`)
      return (impl.readFile ? impl.readFile(path, opts) : { content: '', total_lines: 0 }) as never
    },
    ...(impl.readFileBytes
      ? {
          readFileBytes: async (path: string) => {
            calls.push(`readFileBytes:${path}`)
            return impl.readFileBytes!(path)
          },
        }
      : {}),
    ...(impl.previewFile
      ? {
          previewFile: async (path: string) => {
            calls.push(`previewFile:${path}`)
            return impl.previewFile!(path)
          },
        }
      : {}),
  }
  return { provider, calls }
}

async function mountViewer(filePath: string, provider: WorkspaceFileProvider | null): Promise<StubEl> {
  const Host = defineComponent({
    render: () => h(ClientViewer as never, { filePath, provider } as never),
  })
  const ops = nodeOps()
  const { createApp } = createRenderer(ops)
  const root = ops.createElement('root')
  const app = createApp(Host)
  const errors: unknown[] = []
  app.config.warnHandler = () => {}
  app.config.errorHandler = (err) => { errors.push(err) }
  // v-loading 是 element-plus 指令：注册空实现，withDirectives 的 hook 调用有 if (hook) 守卫
  app.directive('loading', {})
  app.mount(root as never)
  if (errors.length) throw errors[0]
  await flush()
  return root
}

function lastMonacoEnabled(): boolean {
  return monacoCalls.length > 0 ? monacoCalls[monacoCalls.length - 1].enabled.value : false
}

describe('FileViewer dispatch：新增预览格式', () => {
  beforeEach(() => {
    monacoCalls.length = 0
    csvProps.length = 0
    archiveProps.length = 0
    spreadsheetProps.length = 0
    docxProps.length = 0
    mediaProps.length = 0
    pdfProps.length = 0
  })

  it('csv 扩展名：readFile 成功后改道 CsvTableView，不进 Monaco（A1 文本类改道点）', async () => {
    const { provider, calls } = makeProvider({
      readFile: async () => ({ content: 'a,b\n1,2', total_lines: 2 }),
    })
    await mountViewer('data.csv', provider)

    expect(calls).toEqual(['readFile:data.csv'])
    expect(csvProps).toHaveLength(1)
    expect(csvProps[0].content).toBe('a,b\n1,2')
    expect(csvProps[0].truncated).toBe(false)
    expect(archiveProps).toHaveLength(0)
    expect(pdfProps).toHaveLength(0)
    // 新态是平行 state 值，monacoEnabled 的 state==='ready' 条件天然排除（A4）
    expect(lastMonacoEnabled()).toBe(false)
  })

  it('zip 扩展名：readFile 之前早返回字节分支，CsvTableView 不介入', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02])
    const { provider, calls } = makeProvider({
      readFileBytes: async () => ({ bytes, size: bytes.byteLength }),
    })
    await mountViewer('bundle.zip', provider)

    expect(calls).toEqual(['readFileBytes:bundle.zip'])
    expect(archiveProps).toHaveLength(1)
    expect(archiveProps[0].fileName).toBe('bundle.zip')
    expect((archiveProps[0].bytes as Uint8Array).byteLength).toBe(bytes.byteLength)
    expect(csvProps).toHaveLength(0)
    expect(lastMonacoEnabled()).toBe(false)
  })

  it('sniff 兜底：无扩展名文件 readFile 内容以 PK 魔数开头（含 NUL，同真实包），改道字节分支（B7）', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x05, 0x06])
    const { provider, calls } = makeProvider({
      // 第 5 字节是本地头的 version needed（0x14 0x00）：真实 zip 必有 NUL，
      // 这也是 sniff 必须排在 binary 检查之前的原因（review round1 #1）
      readFile: async () => ({ content: 'PK\u0003\u0004\u0014\u0000stored-entry-bytes', total_lines: 1 }),
      readFileBytes: async () => ({ bytes, size: bytes.byteLength }),
    })
    await mountViewer('archive', provider)

    expect(calls).toEqual(['readFile:archive', 'readFileBytes:archive'])
    expect(archiveProps).toHaveLength(1)
    expect(csvProps).toHaveLength(0)
  })

  it('project 模式无 readFileBytes：zip 显示降级文案而非二进制错误态（B3）', async () => {
    const { provider, calls } = makeProvider({
      readFile: async () => ({ content: 'PK\u0003\u0004binary', total_lines: 1 }),
    })
    const root = await mountViewer('bundle.zip', provider)

    // 扩展名命中即早返回，readFile 不应被调用
    expect(calls).toEqual([])
    const errorNodes = findAllByClass(root, 'error')
    expect(errorNodes.length).toBeGreaterThan(0)
    expect(flatText(root)).toContain('会话工作区')
    expect(csvProps).toHaveLength(0)
    expect(archiveProps).toHaveLength(0)
  })

  it('过期响应守卫：zip 字节迟到时已切到 csv，旧 bytes 不覆盖新状态（A2）', async () => {
    let resolveZip: (v: { bytes?: Uint8Array; size?: number }) => void = () => {}
    const zipDeferred = new Promise<{ bytes?: Uint8Array; size?: number }>((resolve) => {
      resolveZip = resolve
    })
    const provider = {
      listDirectory: async () => ({ entries: [] }),
      searchFiles: async () => ({}),
      readFile: async () => ({ content: 'x,y\n3,4', total_lines: 2 }),
      readFileBytes: () => zipDeferred,
    } as unknown as WorkspaceFileProvider

    const filePath = ref('slow.zip')
    const Host = defineComponent({
      render: () => h(ClientViewer as never, { filePath: filePath.value, provider } as never),
    })
    const ops = nodeOps()
    const { createApp } = createRenderer(ops)
    const root = ops.createElement('root')
    const app = createApp(Host)
    const errors: unknown[] = []
    app.config.warnHandler = () => {}
    app.config.errorHandler = (err) => { errors.push(err) }
    app.directive('loading', {})
    app.mount(root as never)
    if (errors.length) throw errors[0]
    await flush()

    // zip 请求在途中时切到 csv（readFile 同步返回），再让 zip 迟到落地
    filePath.value = 'fast.csv'
    await flush()
    resolveZip({ bytes: new Uint8Array([1, 2, 3]), size: 3 })
    await flush()

    expect(csvProps).toHaveLength(1)
    expect(csvProps[0].content).toBe('x,y\n3,4')
    expect(archiveProps).toHaveLength(0)
  })

  it('readFileBytes 失败：转 error 态并展示后端错误信息（既有 error 态复用）', async () => {
    const { provider } = makeProvider({
      readFileBytes: async () => ({ error: '文件过大（70.0 MB），预览上限为 64.0 MB' }),
    })
    const root = await mountViewer('big.zip', provider)
    expect(flatText(root)).toContain('预览上限为 64.0 MB')
    expect(archiveProps).toHaveLength(0)
  })

  it('xlsx 扩展名：readFile 之前早返回字节分支，进 SpreadsheetView（A1 二进制类）', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02])
    const { provider, calls } = makeProvider({
      readFileBytes: async () => ({ bytes, size: bytes.byteLength }),
    })
    await mountViewer('report.xlsx', provider)

    expect(calls).toEqual(['readFileBytes:report.xlsx'])
    expect(spreadsheetProps).toHaveLength(1)
    expect((spreadsheetProps[0].bytes as Uint8Array).byteLength).toBe(bytes.byteLength)
    expect(spreadsheetProps[0].filePath).toBe('report.xlsx')
    expect(csvProps).toHaveLength(0)
    expect(archiveProps).toHaveLength(0)
    expect(lastMonacoEnabled()).toBe(false)
  })

  it('sniff 兜底：无扩展名文件含 xl/workbook.xml 特征（含 NUL），改道表格分支（B7）', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x05, 0x06])
    const { provider, calls } = makeProvider({
      readFile: async () => ({
        content: 'PK\u0003\u0004\u0014\u0000xl/workbook.xmlsheet-data',
        total_lines: 1,
      }),
      readFileBytes: async () => ({ bytes, size: bytes.byteLength }),
    })
    await mountViewer('workbook', provider)

    expect(calls).toEqual(['readFile:workbook', 'readFileBytes:workbook'])
    expect(spreadsheetProps).toHaveLength(1)
    expect(archiveProps).toHaveLength(0)
    expect(csvProps).toHaveLength(0)
  })

  it('sniff 兜底（真实 zip）：STORED 与 DEFLATE 包都能改道字节分支，不停在 binary 态（review round1 #1）', async () => {
    for (const compression of ['STORE', 'DEFLATE'] as const) {
      const zip = new JSZip()
      zip.file('readme.txt', 'hello archive, plain text content')
      const bytes = await zip.generateAsync({ type: 'uint8array', compression })
      archiveProps.length = 0
      csvProps.length = 0
      const { provider, calls } = makeProvider({
        // LOCAL localReadFile 口径：二进制按 utf-8 解码成文本
        readFile: async () => ({ content: Buffer.from(bytes).toString('utf-8'), total_lines: 1 }),
        readFileBytes: async () => ({ bytes, size: bytes.byteLength }),
      })
      await mountViewer('archive', provider)

      expect(calls, compression).toEqual(['readFile:archive', 'readFileBytes:archive'])
      expect(archiveProps, compression).toHaveLength(1)
      expect(csvProps, compression).toHaveLength(0)
    }
  })

  it('project 模式无 readFileBytes：xlsx 显示降级文案而非二进制错误态（B3）', async () => {
    const { provider, calls } = makeProvider({
      readFile: async () => ({ content: 'PK\u0003\u0004binary', total_lines: 1 }),
    })
    const root = await mountViewer('report.xlsx', provider)

    // 扩展名命中即早返回，readFile 不应被调用
    expect(calls).toEqual([])
    expect(flatText(root)).toContain('会话工作区')
    expect(spreadsheetProps).toHaveLength(0)
  })

  it('xlsx readFileBytes 失败：转 error 态并展示后端错误信息', async () => {
    const { provider } = makeProvider({
      readFileBytes: async () => ({ error: '读取文件失败' }),
    })
    const root = await mountViewer('report.xlsx', provider)
    expect(flatText(root)).toContain('读取文件失败')
    expect(spreadsheetProps).toHaveLength(0)
  })

  it('过期响应守卫：xlsx 字节迟到时已切到 zip，旧 bytes 不覆盖新状态（A2）', async () => {
    let resolveXlsx: (v: { bytes?: Uint8Array; size?: number }) => void = () => {}
    const xlsxDeferred = new Promise<{ bytes?: Uint8Array; size?: number }>((resolve) => {
      resolveXlsx = resolve
    })
    const provider = {
      listDirectory: async () => ({ entries: [] }),
      searchFiles: async () => ({}),
      readFile: async () => ({ content: 'x,y\n3,4', total_lines: 2 }),
      readFileBytes: (path: string) =>
        path.endsWith('.xlsx') ? xlsxDeferred : Promise.resolve({ bytes: new Uint8Array([7]), size: 1 }),
    } as unknown as WorkspaceFileProvider

    const filePath = ref('slow.xlsx')
    const Host = defineComponent({
      render: () => h(ClientViewer as never, { filePath: filePath.value, provider } as never),
    })
    const ops = nodeOps()
    const { createApp } = createRenderer(ops)
    const root = ops.createElement('root')
    const app = createApp(Host)
    const errors: unknown[] = []
    app.config.warnHandler = () => {}
    app.config.errorHandler = (err) => { errors.push(err) }
    app.directive('loading', {})
    app.mount(root as never)
    if (errors.length) throw errors[0]
    await flush()

    // xlsx 请求在途中时切到 zip（同步返回），再让 xlsx 迟到落地
    filePath.value = 'fast.zip'
    await flush()
    resolveXlsx({ bytes: new Uint8Array([1, 2, 3]), size: 3 })
    await flush()

    expect(archiveProps).toHaveLength(1)
    expect(spreadsheetProps).toHaveLength(0)
  })

  it('docx 扩展名：readFile 之前早返回字节分支，进 DocxPreview（A1 二进制类）', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x05, 0x06])
    const { provider, calls } = makeProvider({
      readFileBytes: async () => ({ bytes, size: bytes.byteLength }),
    })
    await mountViewer('spec.docx', provider)

    expect(calls).toEqual(['readFileBytes:spec.docx'])
    expect(docxProps).toHaveLength(1)
    expect((docxProps[0].bytes as Uint8Array).byteLength).toBe(bytes.byteLength)
    expect(docxProps[0].filePath).toBe('spec.docx')
    expect(spreadsheetProps).toHaveLength(0)
    expect(csvProps).toHaveLength(0)
    expect(lastMonacoEnabled()).toBe(false)
  })

  it('project 模式无 readFileBytes：docx 显示降级文案而非二进制错误态（B3）', async () => {
    const { provider, calls } = makeProvider({
      readFile: async () => ({ content: 'PK\u0003\u0004binary', total_lines: 1 }),
    })
    const root = await mountViewer('spec.docx', provider)

    // 扩展名命中即早返回，readFile 不应被调用
    expect(calls).toEqual([])
    expect(flatText(root)).toContain('会话工作区')
    expect(docxProps).toHaveLength(0)
  })

  it('mp4 扩展名：readFile 之前早返回字节分支，进 MediaPlayer（A1 二进制类）', async () => {
    const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x18])
    const { provider, calls } = makeProvider({
      readFileBytes: async () => ({ bytes, size: bytes.byteLength }),
    })
    await mountViewer('clip.mp4', provider)

    expect(calls).toEqual(['readFileBytes:clip.mp4'])
    expect(mediaProps).toHaveLength(1)
    expect((mediaProps[0].bytes as Uint8Array).byteLength).toBe(bytes.byteLength)
    expect(mediaProps[0].filePath).toBe('clip.mp4')
    expect(csvProps).toHaveLength(0)
    expect(archiveProps).toHaveLength(0)
    expect(lastMonacoEnabled()).toBe(false)
  })

  it('wav 扩展名：音频同样早返回字节分支，不进 Monaco', async () => {
    const { provider, calls } = makeProvider({
      readFileBytes: async () => ({ bytes: new Uint8Array([1, 2]), size: 2 }),
    })
    await mountViewer('record.wav', provider)

    expect(calls).toEqual(['readFileBytes:record.wav'])
    expect(mediaProps).toHaveLength(1)
    expect(lastMonacoEnabled()).toBe(false)
  })

  it('project 模式无 readFileBytes：media 显示降级文案而非二进制错误态（B3）', async () => {
    const { provider, calls } = makeProvider({
      readFile: async () => ({ content: 'PK\u0003\u0004binary', total_lines: 1 }),
    })
    const root = await mountViewer('clip.mp3', provider)

    // 扩展名命中即早返回，readFile 不应被调用
    expect(calls).toEqual([])
    expect(flatText(root)).toContain('会话工作区')
    expect(mediaProps).toHaveLength(0)
  })

  it('media readFileBytes 失败：转 error 态并展示后端错误信息', async () => {
    const { provider } = makeProvider({
      readFileBytes: async () => ({ error: '读取文件失败' }),
    })
    const root = await mountViewer('clip.mp4', provider)
    expect(flatText(root)).toContain('读取文件失败')
    expect(mediaProps).toHaveLength(0)
  })

  it('过期响应守卫：media 字节迟到时已切到 csv，旧 bytes 不覆盖新状态（A2）', async () => {
    let resolveMedia: (v: { bytes?: Uint8Array; size?: number }) => void = () => {}
    const mediaDeferred = new Promise<{ bytes?: Uint8Array; size?: number }>((resolve) => {
      resolveMedia = resolve
    })
    const provider = {
      listDirectory: async () => ({ entries: [] }),
      searchFiles: async () => ({}),
      readFile: async () => ({ content: 'x,y\n3,4', total_lines: 2 }),
      readFileBytes: (path: string) =>
        /\.(mp4|mp3|wav)$/.test(path) ? mediaDeferred : Promise.resolve({ bytes: new Uint8Array([7]), size: 1 }),
    } as unknown as WorkspaceFileProvider

    const filePath = ref('slow.mp4')
    const Host = defineComponent({
      render: () => h(ClientViewer as never, { filePath: filePath.value, provider } as never),
    })
    const ops = nodeOps()
    const { createApp } = createRenderer(ops)
    const root = ops.createElement('root')
    const app = createApp(Host)
    const errors: unknown[] = []
    app.config.warnHandler = () => {}
    app.config.errorHandler = (err) => { errors.push(err) }
    app.directive('loading', {})
    app.mount(root as never)
    if (errors.length) throw errors[0]
    await flush()

    // media 请求在途中时切到 csv（同步返回），再让 media 迟到落地
    filePath.value = 'fast.csv'
    await flush()
    resolveMedia({ bytes: new Uint8Array([1, 2, 3]), size: 3 })
    await flush()

    expect(csvProps).toHaveLength(1)
    expect(csvProps[0].content).toBe('x,y\n3,4')
    expect(mediaProps).toHaveLength(0)
  })

  it('过期响应守卫：PDF 迟到时已切到 zip，旧 PDF 不覆盖新状态（round2 #1，两个计数器序号碰撞）', async () => {
    let resolvePdf: (v: { blob?: Blob; error?: string }) => void = () => {}
    const pdfDeferred = new Promise<{ blob?: Blob; error?: string }>((resolve) => {
      resolvePdf = resolve
    })
    const provider = {
      listDirectory: async () => ({ entries: [] }),
      searchFiles: async () => ({}),
      previewFile: () => pdfDeferred,
      readFile: async () => ({ content: 'x,y\n3,4', total_lines: 2 }),
      readFileBytes: async () => ({ bytes: new Uint8Array([7]), size: 1 }),
    } as unknown as WorkspaceFileProvider

    const filePath = ref('slow.pdf')
    const Host = defineComponent({
      render: () => h(ClientViewer as never, { filePath: filePath.value, provider } as never),
    })
    const ops = nodeOps()
    const { createApp } = createRenderer(ops)
    const root = ops.createElement('root')
    const app = createApp(Host)
    const errors: unknown[] = []
    app.config.warnHandler = () => {}
    app.config.errorHandler = (err) => { errors.push(err) }
    app.directive('loading', {})
    app.mount(root as never)
    if (errors.length) throw errors[0]
    await flush()

    // PDF 请求在途中时切到 zip（同步返回），再让 PDF 迟到落地
    filePath.value = 'fast.zip'
    await flush()
    resolvePdf({ blob: new Blob(['%PDF-1.4']) })
    await flush()

    expect(archiveProps).toHaveLength(1)
    expect(pdfProps).toHaveLength(0)
  })
})

describe('FileViewer dispatch：既有路径不回归', () => {
  beforeEach(() => {
    monacoCalls.length = 0
    csvProps.length = 0
    archiveProps.length = 0
    spreadsheetProps.length = 0
    docxProps.length = 0
    mediaProps.length = 0
    pdfProps.length = 0
  })

  it('md 走既有渲染路径：不进新分支，MarkdownContent 渲染，源码态未启用 Monaco', async () => {
    const { provider } = makeProvider({
      readFile: async () => ({ content: '# title\n\nbody', total_lines: 3 }),
    })
    const root = await mountViewer('notes.md', provider)

    expect(csvProps).toHaveLength(0)
    expect(archiveProps).toHaveLength(0)
    // markdown 默认 rendered 态：MarkdownContent stub 在场、源码 Monaco 未启用
    expect(findAllByClass(root, 'md-stub').length).toBeGreaterThan(0)
    expect(lastMonacoEnabled()).toBe(false)
  })

  it('txt 走既有 ready 路径：Monaco 启用，不进新分支（H2）', async () => {
    const { provider, calls } = makeProvider({
      readFile: async () => ({ content: 'plain text', total_lines: 1 }),
    })
    await mountViewer('notes.txt', provider)

    expect(calls).toEqual(['readFile:notes.txt'])
    expect(csvProps).toHaveLength(0)
    expect(archiveProps).toHaveLength(0)
    expect(lastMonacoEnabled()).toBe(true)
  })

  it('pdf 走既有 previewFile 路径：PdfViewer stub 接收 blob URL，不进新分支', async () => {
    const createObjectURL = vi.fn(() => 'blob:mock-url')
    const revokeObjectURL = vi.fn()
    URL.createObjectURL = createObjectURL as never
    URL.revokeObjectURL = revokeObjectURL as never
    try {
      const { provider, calls } = makeProvider({
        previewFile: async () => ({ blob: new Blob(['%PDF-1.4']) }),
      })
      await mountViewer('doc.pdf', provider)

      expect(calls).toEqual(['previewFile:doc.pdf'])
      expect(csvProps).toHaveLength(0)
      expect(archiveProps).toHaveLength(0)
      expect(pdfProps).toHaveLength(1)
      expect(pdfProps[0].blobUrl).toBe('blob:mock-url')
      expect(pdfProps[0].fileName).toBe('doc.pdf')
    } finally {
      delete (URL as unknown as Record<string, unknown>).createObjectURL
      delete (URL as unknown as Record<string, unknown>).revokeObjectURL
    }
  })

  it('非 zip 二进制内容（含 NUL）仍走 binary 态：PK 魔数不命中就不误入字节分支', async () => {
    const { provider, calls } = makeProvider({
      readFile: async () => ({ content: '\u0000\u0001\u0002binary-payload', total_lines: 1 }),
      readFileBytes: async () => ({ bytes: new Uint8Array([1]), size: 1 }),
    })
    const root = await mountViewer('archive', provider)

    expect(calls).toEqual(['readFile:archive'])
    expect(flatText(root)).toContain('二进制文件，无法预览')
    expect(archiveProps).toHaveLength(0)
    expect(csvProps).toHaveLength(0)
  })
})
