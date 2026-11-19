// 投递条（统一发送媒体方案 2026-11-18 D6/§7.1）：图片进预览网格（src 与预览列表都取 url），
// 文件渲染为指向 url 的链接、文字是 filename，并带大小。模板 AST 断言锁住数据绑定。
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

describe('ChatDeliveryBar 模板绑定', () => {
  it('图片用 el-image，src 与预览列表都取 delivery.url', () => {
    const images = findElements(root, el => el.tag === 'el-image')
    expect(images).toHaveLength(1)
    expect(propExp(images[0], 'src')).toBe('d.url')
    expect(propExp(images[0], 'preview-src-list')).toBe('imageUrls')
    expect(propExp(images[0], 'preview-teleported')).toBe('true')
  })

  it('文件链接 href 是 url、文字是 filename、附大小', () => {
    const links = findElements(root, el => el.tag === 'a')
    expect(links).toHaveLength(1)
    expect(propExp(links[0], 'href')).toBe('d.url')
    expect(propExp(links[0], 'target')).toBe('_blank')
    const spans = findElements(links[0], el => el.tag === 'span')
    const name = spans.find(el => propExp(el, 'class') === 'delivery-file-name')
    const size = spans.find(el => propExp(el, 'class') === 'delivery-file-size')
    expect(name).toBeTruthy()
    expect(size).toBeTruthy()
    expect(childText(name!)).toContain('d.filename')
    expect(childText(size!)).toContain('formatSize(d.bytes)')
  })

  it('无投递不渲染', () => {
    const outer = findElements(root, el => el.tag === 'div')[0]
    expect(outer).toBeTruthy()
    expect(propExp(outer, 'if')).toBe('deliveries.length > 0')
  })
})
