// 投递卡片（统一发送媒体方案 2026-11-18 D6/§7.1）：图片进预览网格（src 与预览列表都取 url），
// 文件渲染为「点击主区进中心文件预览 Tab + 右侧独立下载按钮」的结构化附件卡片。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from '@vue/compiler-sfc'

interface TemplateEl {
  type: number
  tag?: string
  props?: Array<{
    type: number
    name?: string
    arg?: { content?: string }
    exp?: { content?: string }
    value?: { content?: string }
    modifiers?: Array<{ content?: string } | string>
  }>
  children?: Array<TemplateEl & { content?: { content?: string } }>
}

const ELEMENT = 1
const DIRECTIVE = 7

function findElements(ast: TemplateEl | null | undefined, pred: (el: TemplateEl) => boolean): TemplateEl[] {
  if (!ast) return []
  const out: TemplateEl[] = []
  if (ast.type === ELEMENT && pred(ast)) out.push(ast)
  for (const child of ast.children ?? []) out.push(...findElements(child, pred))
  return out
}

/** `:name="expr"` 记为 name，`v-if` / 静态属性直接取 name（与既有 ChatRoundList 测试同口径）。 */
function propExp(el: TemplateEl, name: string): string | null {
  for (const p of el.props ?? []) {
    if (p.type === DIRECTIVE && p.name === 'bind' && p.arg?.content === name) return p.exp?.content ?? ''
    if (p.type === DIRECTIVE && p.name === 'on' && p.arg?.content === name) return p.exp?.content ?? ''
    if (p.name === name) return p.exp?.content ?? p.value?.content ?? ''
  }
  return null
}

function childText(el: TemplateEl): string {
  return (el.children ?? []).map(child => child.content?.content ?? '').join('')
}

const source = readFileSync(new URL('./ChatDeliveryBar.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source)
const root = descriptor.template?.ast as TemplateEl | undefined
const scriptContent = descriptor.scriptSetup?.content ?? ''
const styleContent = descriptor.styles.map(s => s.content).join('\n')

describe('ChatDeliveryBar 模板绑定与预览/下载双动作卡片', () => {
  it('图片用 el-image，src 与预览列表都取 delivery.url', () => {
    const images = findElements(root, el => el.tag === 'el-image')
    expect(images).toHaveLength(1)
    expect(propExp(images[0], 'src')).toBe('d.url')
    expect(propExp(images[0], 'preview-src-list')).toBe('imageUrls')
    expect(propExp(images[0], 'preview-teleported')).toBe('true')
  })

  it('文件卡片主区点击走文件预览（无嵌套交互元素），右侧并列提供独立下载按钮', () => {
    const card = findElements(root, el => el.tag === 'div' && propExp(el, 'for') === 'd in fileDeliveries')[0]
    expect(card).toBeTruthy()

    const buttons = findElements(card, el => el.tag === 'button')
    expect(buttons).toHaveLength(2)

    const mainBtn = buttons.find(el => propExp(el, 'class') === 'delivery-file-main')
    const downloadBtn = buttons.find(el => propExp(el, 'class') === 'delivery-file-download')
    expect(mainBtn).toBeTruthy()
    expect(downloadBtn).toBeTruthy()
    // 禁止 button 内嵌 button
    expect(findElements(mainBtn, el => el.tag === 'button')).toHaveLength(1)

    expect(propExp(mainBtn!, 'click')).toBe('handleFileOpen(d)')
    expect(propExp(mainBtn!, 'aria-label')).toBe('filePreviewAriaLabel(d)')

    expect(propExp(downloadBtn!, 'click')).toBe('handleFileDownload(d)')
    expect(propExp(downloadBtn!, 'aria-label')).toContain('下载文件')

    const spans = findElements(mainBtn!, el => el.tag === 'span')
    const badge = spans.find(el => propExp(el, 'class') === 'delivery-file-badge')
    const name = spans.find(el => propExp(el, 'class') === 'delivery-file-name')
    const kind = spans.find(el => propExp(el, 'class') === 'delivery-file-kind')
    const size = spans.find(el => propExp(el, 'class') === 'delivery-file-size')

    expect(badge).toBeTruthy()
    expect(name).toBeTruthy()
    expect(kind).toBeTruthy()
    expect(size).toBeTruthy()
    expect(childText(name!)).toContain('d.filename')
    expect(childText(kind!)).toContain('fileMeta(d).typeLabel')
    expect(childText(size!)).toContain('formatSize(d.bytes)')

    // 脚本层接线：优先注入 openDeliveryFile 进中心预览 Tab，只读分享页回落下载
    expect(scriptContent).toContain("inject<((delivery: SendDelivery) => void) | null>('openDeliveryFile', null)")
    expect(scriptContent).toContain('downloadDeliveryUrl(d.url, d.filename)')
  })

  it('文件容器采用横向折行卡片且约束最大宽度，避免单文件被纵向 flex 默认 stretch 拉满整行', () => {
    const filesBlockStart = styleContent.indexOf('.delivery-files {')
    expect(filesBlockStart).toBeGreaterThan(-1)
    const filesBlock = styleContent.slice(filesBlockStart, styleContent.indexOf('}', filesBlockStart))
    expect(filesBlock).toContain('flex-wrap: wrap')
    expect(filesBlock).not.toContain('flex-direction: column')

    const cardBlockStart = styleContent.indexOf('.delivery-file {')
    expect(cardBlockStart).toBeGreaterThan(-1)
    const cardBlock = styleContent.slice(cardBlockStart, styleContent.indexOf('}', cardBlockStart))
    expect(cardBlock).toContain('max-width: min(388px, 100%)')
    expect(styleContent).toContain('.delivery-file-main:focus-visible')
    expect(styleContent).toContain('.delivery-file-download:focus-visible')
  })

  it('无投递不渲染', () => {
    const outer = findElements(root, el => el.tag === 'div')[0]
    expect(outer).toBeTruthy()
    expect(propExp(outer, 'if')).toBe('deliveries.length > 0')
  })
})
