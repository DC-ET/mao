// @vitest-environment jsdom
// ArchiveBrowser 集成回归（技术方案 §5.4 / §9）：真实 jszip 造包 → 动态加载 →
// 中央目录评估 → 条目点击四类行为（图片内嵌 / PDF 占位 / 文本内存预览 / 其他下载）。
// zip 炸弹防线的边界由 archive-entries.test.ts 纯函数覆盖，这里只验接线。
import { readFileSync } from 'node:fs'
import { join as pathJoin } from 'node:path'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as Vue from 'vue'
import { h, nextTick, defineComponent, createRenderer } from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { compile } from '@vue/compiler-dom'
import JSZip from 'jszip'

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useSSRContext: () => ({ modules: new Set(), scopeId: null, styles: '' }),
  }
})

// PdfViewer 静态 import 会拉 pdfjs：mock 掉，只验「PDF 条目把 blob URL 交给它」
const pdfViewerProps: Array<Record<string, unknown>> = []
vi.mock('./PdfViewer.vue', () => ({
  default: defineComponent({
    props: { blobUrl: String, filePath: String, fileName: String, provider: Object },
    render() {
      pdfViewerProps.push({ ...this.$props })
      return h('div', { class: 'pdf-stub' }, 'pdf')
    },
  }),
}))

vi.mock('@element-plus/icons-vue', () => ({
  Back: { render: () => null },
  Document: { render: () => null },
  Download: { render: () => null },
  Folder: { render: () => null },
  Refresh: { render: () => null },
}))

// jszip 用真实模块：被接线的正是它（动态 import 在组件内）
import ArchiveBrowser from './ArchiveBrowser.vue'

// jsdom 环境下 import.meta.url 是 http scheme，readFileSync 只吃 file:——按 cwd
// （vitest 根 = desktop/）拼路径，与其余 node 环境用例的 import.meta.url 等价
const sfcPath = pathJoin(process.cwd(), 'src/components/center/ArchiveBrowser.vue')
const descriptor = parse(readFileSync(sfcPath, 'utf8')).descriptor
const script = compileScript(descriptor, { id: 'archive-browser' })
const compiled = compile(descriptor.template!.content, {
  mode: 'function',
  prefixIdentifiers: true,
  bindingMetadata: script.bindings,
})
const clientRender = new Function('Vue', compiled.code)(Vue) as (ctx: unknown, cache: unknown) => unknown

const ClientBrowser = {
  ...(ArchiveBrowser as object),
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

// jszip 的 loadAsync / generateAsync 内部按 chunk 让出（setImmediate / setTimeout），
// 只冲微task等不到它——每轮补一个宏task 让出
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

let objectUrlSeq = 0
const revokedUrls: string[] = []
const createdUrls: string[] = []
let anchorClickSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  pdfViewerProps.length = 0
  revokedUrls.length = 0
  createdUrls.length = 0
  objectUrlSeq = 0
  URL.createObjectURL = (() => {
    objectUrlSeq += 1
    const url = `blob:mock-${objectUrlSeq}`
    createdUrls.push(url)
    return url
  }) as never
  URL.revokeObjectURL = ((url: string) => {
    revokedUrls.push(url)
  }) as never
  anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

async function buildZip(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('readme.txt', 'hello archive')
  zip.file('pixel.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
  zip.file('doc.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]))
  zip.file('blob.bin', new Uint8Array([0, 1, 2, 255]))
  zip.file('empty/', null)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

async function buildManyEntryZip(count: number): Promise<Uint8Array> {
  const zip = new JSZip()
  for (let i = 0; i < count; i++) zip.file(`f${i}.txt`, `content ${i}`)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

/**
 * 中央目录完好、首个条目压缩数据损坏的 zip：jszip loadAsync 只读中央目录即可成功
 * （炸弹防线只信声明大小），解压该条目时才抛错——用来验条目级失败可见。
 * 后面跟一个正常条目，用于验证错误横幅在下次点击时被清掉。
 * 本地文件头 30 字节 + 文件名长 + 扩展字段长之后就是压缩数据。
 */
async function buildCorruptedEntryZip(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('readme.txt', 'hello archive '.repeat(50))
  zip.file('ok.txt', 'intact entry')
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  const corrupted = new Uint8Array(bytes)
  const nameLen = corrupted[26] | (corrupted[27] << 8)
  const extraLen = corrupted[28] | (corrupted[29] << 8)
  const dataStart = 30 + nameLen + extraLen
  for (let i = 0; i < 8; i++) corrupted[dataStart + i] = 0xff
  return corrupted
}

async function mountBrowser(
  bytes: Uint8Array,
  provider: Record<string, unknown> | null = null,
): Promise<StubEl> {
  const Host = defineComponent({
    render: () =>
      h(ClientBrowser as never, {
        filePath: 'bundle.zip',
        fileName: 'bundle.zip',
        bytes,
        provider,
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
  await flush()
  return root
}

function entryButtons(root: StubEl): StubEl[] {
  return findAll(root, byClass('archive-entry'))
}

function findEntry(root: StubEl, title: string): StubEl {
  const btn = entryButtons(root).find((el) => el.props.title === title)
  if (!btn) throw new Error(`entry not found: ${title}`)
  return btn
}

/** stub DOM 的 click 处理器存在元素 props 里（patchProp 落盘），取出即触发 */
function click(el: StubEl) {
  ;(el.props.onClick as (() => void) | undefined)?.()
}

describe('ArchiveBrowser 条目列表', () => {
  it('动态加载 jszip 后渲染中央目录条目（名称 / 大小 / 压缩率 / 目录标识）', async () => {
    const root = await mountBrowser(await buildZip())
    const titles = entryButtons(root).map((el) => el.props.title)
    expect(titles).toEqual(['blob.bin', 'doc.pdf', 'empty/', 'pixel.png', 'readme.txt'])
    expect(collectText(root)).toContain('5 个条目')
    // 目录条目置灰不可点
    expect(findEntry(root, 'empty/').props.disabled).toBe(true)
    expect(findEntry(root, 'readme.txt').props.disabled).toBe(false)
    // 大小列：readme.txt 解压 13 字节
    const readmeRow = collectText(findEntry(root, 'readme.txt'))
    expect(readmeRow).toContain('13 B')
  })

  it('条目数超上限：整包拒绝并提示下载', async () => {
    const root = await mountBrowser(await buildManyEntryZip(501))
    expect(collectText(root)).toContain('条目过多')
    expect(collectText(root)).toContain('请下载后查看')
    expect(entryButtons(root)).toHaveLength(0)
  })

  it('LOCAL 被拒（无 downloadFile）：拒绝态给「在 Finder 中显示」出口，不是死路（review round1 #5）', async () => {
    const shown: string[] = []
    ;(globalThis as unknown as { window?: unknown }).window = {
      electronAPI: { showItemInFolder: (p: string) => { shown.push(p) } },
    }
    try {
      const provider = { getAbsolutePath: (p: string) => `/Users/u/work/${p}` }
      const root = await mountBrowser(await buildManyEntryZip(501), provider)

      expect(collectText(root)).toContain('条目过多')
      const finderBtn = findAll(root, byClass('retry-btn')).find((el) => collectText(el).includes('在 Finder 中显示'))
      expect(finderBtn).toBeDefined()
      click(finderBtn!)
      await flush()
      expect(shown).toEqual(['/Users/u/work/bundle.zip'])
    } finally {
      delete (globalThis as unknown as { window?: unknown }).window
    }
  })
})

describe('ArchiveBrowser 条目点击行为', () => {
  it('文本条目：内存 <pre> 预览（标注压缩包内预览），可返回列表', async () => {
    const root = await mountBrowser(await buildZip())
    click(findEntry(root, 'readme.txt'))
    await flush()

    const pre = findAll(root, byTag('pre'))[0]
    expect(collectText(pre)).toContain('hello archive')
    expect(collectText(root)).toContain('压缩包内预览')

    // 返回条目列表：覆盖层关闭，无残留 blob URL
    const backBtn = findAll(root, byTag('button')).find((b) => b.props.title === '返回条目列表')
    click(backBtn!)
    await flush()
    expect(findAll(root, byTag('pre'))).toHaveLength(0)
  })

  it('图片条目：解压为 blob URL 交 <img> 内嵌预览', async () => {
    const root = await mountBrowser(await buildZip())
    click(findEntry(root, 'pixel.png'))
    await flush()

    const img = findAll(root, byTag('img'))[0]
    expect(img).toBeDefined()
    expect(img.props.src).toMatch(/^blob:mock-/)
  })

  it('PDF 条目：blob URL 交 PdfViewer（provider 传 null，下载按钮随 v-if 隐藏）', async () => {
    const root = await mountBrowser(await buildZip())
    click(findEntry(root, 'doc.pdf'))
    await flush()

    expect(pdfViewerProps).toHaveLength(1)
    expect(pdfViewerProps[0].blobUrl).toMatch(/^blob:mock-/)
    expect(pdfViewerProps[0].provider).toBeNull()
  })

  it('其他类型条目：单条目 blob 触发 a.download，文件名取末段', async () => {
    const root = await mountBrowser(await buildZip())
    click(findEntry(root, 'blob.bin'))
    await flush()

    expect(anchorClickSpy).toHaveBeenCalledTimes(1)
    expect(createdUrls.length).toBeGreaterThan(0)
    // 下载后即 revoke，不常驻内存
    expect(revokedUrls.length).toBeGreaterThan(0)
    // 未进入任何预览态
    expect(findAll(root, byTag('pre'))).toHaveLength(0)
    expect(findAll(root, byTag('img'))).toHaveLength(0)
  })

  it('换条目预览：旧 blob URL 先 revoke 再建新的（A5 / D1）', async () => {
    const root = await mountBrowser(await buildZip())
    click(findEntry(root, 'pixel.png'))
    await flush()
    const firstUrl = createdUrls[createdUrls.length - 1]

    click(findEntry(root, 'doc.pdf'))
    await flush()
    expect(revokedUrls).toContain(firstUrl)
    expect(pdfViewerProps[pdfViewerProps.length - 1].blobUrl).not.toBe(firstUrl)
  })

  it('刷新按钮：emit refresh 交回 FileViewer 重走 dispatch，不在本地重解同一份字节（round2 #2 / §5.8）', async () => {
    const refreshes: number[] = []
    const Host = defineComponent({
      emits: ['refresh'],
      render() {
        return h(ClientBrowser as never, {
          filePath: 'bundle.zip',
          fileName: 'bundle.zip',
          bytes: new Uint8Array([1, 2, 3]),
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
    // 假字节解析失败 → error 态；此时点刷新仍应 emit（由 FileViewer 换新 bytes 重挂）
    expect(findAll(root, byClass('archive-message')).length).toBeGreaterThan(0)

    const refreshBtn = findAll(root, byTag('button')).find((b) => b.props.title === '刷新')
    expect(refreshBtn).toBeDefined()
    click(refreshBtn!)
    await flush()
    expect(refreshes).toEqual([1])
  })

  it('目录条目不可点：disabled 按钮不派发 click', async () => {
    const root = await mountBrowser(await buildZip())
    const dirBtn = findEntry(root, 'empty/')
    expect(dirBtn.props.disabled).toBe(true)
  })

  it('条目数据损坏：解压抛错时行内横幅可见，条目列表不被踢掉（review round1 #2）', async () => {
    const bytes = await buildCorruptedEntryZip()
    // 中央目录完好：loadAsync 成功、条目照常列出
    const loaded = await JSZip.loadAsync(bytes)
    let threw = ''
    try {
      await loaded.file('readme.txt')!.async('text')
    } catch (e: any) {
      threw = e?.message ?? ''
    }
    expect(threw).not.toBe('')

    const root = await mountBrowser(bytes)
    expect(entryButtons(root).length).toBeGreaterThan(0)
    click(findEntry(root, 'readme.txt'))
    await flush()

    // 无预览、无错误态跳变，但失败原因必须出现在 ready 态的行内横幅里
    expect(findAll(root, byTag('pre'))).toHaveLength(0)
    expect(findAll(root, byClass('archive-message'))).toHaveLength(0)
    expect(collectText(root)).toContain('条目读取失败')
    expect(entryButtons(root).length).toBeGreaterThan(0)

    // 返回/重试路径：点正常条目即清掉旧错误并出预览
    click(findEntry(root, 'ok.txt'))
    await flush()
    expect(collectText(root)).not.toContain('条目读取失败')
    expect(collectText(findAll(root, byTag('pre'))[0])).toContain('intact entry')
  })
})
