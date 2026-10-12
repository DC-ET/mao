// 回复引用溯源（技术方案 2026-10-12）的 MessageBubble 模板结构测试：
// 锁死 (1) MarkdownContent 收到 cite-map 绑定，(2) 来源区在正文之后、
// (3) FileChangePanel 仍在来源区之后（hoist 出分支不改动既有视觉顺序）。
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
  children?: TemplateEl[]
}

const ELEMENT = 1

function findElements(ast: TemplateEl | null | undefined, pred: (el: TemplateEl) => boolean): TemplateEl[] {
  if (!ast) return []
  const out: TemplateEl[] = []
  if (ast.type === ELEMENT && pred(ast)) out.push(ast)
  for (const child of ast.children ?? []) out.push(...findElements(child, pred))
  return out
}

/** 静态属性 / 指令（`v-if` → name='if'，不带 v- 前缀）的表达式 */
function propExp(el: TemplateEl, name: string): string | null {
  const p = (el.props ?? []).find(p => p.name === name)
  if (!p) return null
  return p.exp?.content ?? p.value?.content ?? ''
}

/** `:prop="exp"` 绑定指令（AST name='bind'，参数在 arg） */
function bindExp(el: TemplateEl, arg: string): string | null {
  const p = (el.props ?? []).find(p => p.name === 'bind' && p.arg?.content === arg)
  if (!p) return null
  return p.exp?.content ?? ''
}

/** `@event="exp"` 监听指令（AST name='on'，参数在 arg） */
function onExp(el: TemplateEl, event: string): string | null {
  const p = (el.props ?? []).find(p => p.name === 'on' && p.arg?.content === event)
  if (!p) return null
  return p.exp?.content ?? ''
}

/** 元素是否带某个 class：静态 `class="a b"` 或 `:class="[..., 'a', ...]"` */
function hasClass(el: TemplateEl, cls: string): boolean {
  return (el.props ?? []).some(p =>
    (p.name === 'class' && (p.value?.content ?? '').split(/\s+/).includes(cls))
    || (p.name === 'bind' && p.arg?.content === 'class' && (p.exp?.content ?? '').includes(`'${cls}'`)),
  )
}

const source = readFileSync(new URL('./MessageBubble.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source)
const ast = descriptor.template?.ast as TemplateEl | undefined

describe('MessageBubble citation source area (template structure)', () => {
  it('渲染回复正文的 MarkdownContent 都绑定 cite-map', () => {
    const withCiteMap = findElements(ast, (el) => el.tag === 'MarkdownContent' && bindExp(el, 'cite-map') === 'citeMap')
    // 分段正文 + 无 segments 回退，两条正文渲染路径都要带上标数据
    expect(withCiteMap).toHaveLength(2)
    expect(withCiteMap.map(m => bindExp(m, 'content')).sort()).toEqual(['message.content', 'seg.content'])
    // 后台子代理完成通知是后台事件文案，不参与引用渲染
    const notice = findElements(ast, (el) => el.tag === 'MarkdownContent' && propExp(el, 'if') === '!backgroundNoticeLong || noticeExpanded')
    expect(notice).toHaveLength(1)
    expect(bindExp(notice[0], 'cite-map')).toBeNull()
  })

  it('来源区在正文之后、FileChangePanel 之前（hoist 后顺序不变）', () => {
    const citations = findElements(ast, (el) => el.tag === 'div' && hasClass(el, 'message-citations'))
    const panels = findElements(ast, (el) => el.tag === 'FileChangePanel')
    expect(citations).toHaveLength(1)
    expect(panels).toHaveLength(1)
    expect(propExp(citations[0], 'if')).toBe('showCitations')
    // 先序遍历：来源区必须早于 FileChangePanel
    const flat: TemplateEl[] = []
    const walk = (el: TemplateEl | null | undefined) => {
      if (!el) return
      if (el.type === ELEMENT) flat.push(el)
      for (const c of el.children ?? []) walk(c)
    }
    walk(ast)
    const citeIdx = flat.indexOf(citations[0])
    const panelIdx = flat.indexOf(panels[0])
    expect(citeIdx).toBeGreaterThanOrEqual(0)
    expect(panelIdx).toBeGreaterThan(citeIdx)
  })

  it('来源条目带 data-cite-item（上标点击滚动锚点）与点击外跳', () => {
    const items = findElements(ast, (el) => el.tag === 'li' && hasClass(el, 'cite-item'))
    expect(items).toHaveLength(1)
    expect(bindExp(items[0], 'data-cite-item')).toBe('idx + 1')
    expect(onExp(items[0], 'click')).toBe('openCitation(c)')
  })

  it('消息根节点挂上标点击委托', () => {
    const root = findElements(ast, (el) => el.tag === 'div' && hasClass(el, 'message-bubble'))
    expect(root).toHaveLength(1)
    expect(onExp(root[0], 'click')).toBe('onCitationSupClick')
  })

  it('复制消息时一并剥掉引用标记（剪贴板不该出现 [^n^]）', () => {
    // 桌面 vitest 是 node 环境、无法挂载组件，用源码结构锁死组合顺序：
    // stripInternalMarkers 之后再套 stripCitationMarkers，两层互不影响
    const start = source.indexOf('async function copyMessage')
    expect(start).toBeGreaterThanOrEqual(0)
    const body = source.slice(start, source.indexOf('</script>', start))
    expect(body).toContain('stripCitationMarkers(stripInternalMarkers(')
  })

  it('来源条目外跳走统一 openExternalUrl（安卓壳 window.open 无响应）', () => {
    const start = source.indexOf('function openCitation')
    expect(start).toBeGreaterThanOrEqual(0)
    const body = source.slice(start, source.indexOf('\n}', start))
    expect(body).toContain('openExternalUrl(c.url)')
    expect(body).not.toContain('window.open(')
  })
})
