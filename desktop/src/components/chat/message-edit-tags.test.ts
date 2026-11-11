/**
 * @vitest-environment jsdom
 */
// 气泡编辑态标签 round-trip（技术方案 2026-11-11-message-edit-quick-command-tags §7）：
// 真实 tiptap Editor（扩展清单与 MessageEditEditor 一致）锁定「标记文本 → 标签节点 → getText 还原」
// 全链恒等；MessageBubble 模板断言锁定编辑态容器换载体（MessageEditEditor 替代裸 textarea）。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { parse } from '@vue/compiler-sfc'
import { QuickCommandNode } from './tiptap/QuickCommandNode'
import { FileReferenceNode } from './tiptap/FileReferenceNode'
import { markedTextToEditorHtml } from '../../utils/editor-tags'
import { serializeFileRange } from '../../utils/selection-quote'

const EDITOR_EXTENSIONS = [
  StarterKit.configure({
    heading: false,
    codeBlock: false,
    blockquote: false,
    horizontalRule: false,
    bulletList: false,
    orderedList: false,
    listItem: false,
    code: false,
    bold: false,
    italic: false,
    strike: false,
  }),
  QuickCommandNode,
  FileReferenceNode,
]

let editor: Editor | null = null

/** 构造与 MessageEditEditor 完全一致的初始 doc：`<p>${markedTextToEditorHtml(text)}</p>` */
function makeEditor(text: string): Editor {
  editor = new Editor({ extensions: EDITOR_EXTENSIONS, content: `<p>${markedTextToEditorHtml(text)}</p>` })
  return editor
}

function quickCommandCount(ed: Editor): number {
  let n = 0
  ed.state.doc.descendants(node => {
    if (node.type.name === 'quickCommand') n++
  })
  return n
}

afterEach(() => {
  editor?.destroy()
  editor = null
})

describe('编辑态标记 round-trip（真实 tiptap Editor）', () => {
  const texts = [
    '#{talk}# 你好',
    '${code}$ 单独技能',
    '@{p/a.ts}@ 单独引用',
    '相邻 #{a}#${b}$@{c}@ 相邻',
    '多行第一行\n第二行\n\n第四行',
    '前 #{a}# 中 ${b}$ 后',
    'plain text 无标记',
  ]

  for (const text of texts) {
    it(`恒等：${JSON.stringify(text).slice(0, 30)}`, () => {
      expect(roundTripGetText(text)).toBe(text)
    })
  }

  function roundTripGetText(text: string): string {
    const ed = makeEditor(text)
    return ed.getText({ blockSeparator: '\n' })
  }

  it('quickCommand 节点数 = 标记数', () => {
    expect(quickCommandCount(makeEditor('#{a}#${b}$纯文本'))).toBe(2)
  })

  it('引用型后缀形态（serializeFileRange 产物）：chip 未删时逐字节恒等', () => {
    const text = serializeFileRange({ filePath: 'p/a.ts', lineStart: 3, lineEnd: 5, snippet: 'const a = 1', languageId: 'ts' })
    expect(text).toContain('@{p/a.ts}@')
    const ed = makeEditor(text)
    expect(ed.getText({ blockSeparator: '\n' })).toBe(text)
    expect(quickCommandCount(ed)).toBe(0)
  })

  it('用户按 Enter 产生的多段落：blockSeparator 还原为 \\n（与发送路径同参数）', () => {
    const ed = makeEditor('a')
    ed.commands.setContent('<p>第一段</p><p>第二段</p>')
    expect(ed.getText({ blockSeparator: '\n' })).toBe('第一段\n第二段')
  })

  it('空串初始化为空段落', () => {
    expect(makeEditor('').getText({ blockSeparator: '\n' })).toBe('')
  })
})

// ===== MessageBubble 模板断言（SFC AST，仿 MessageBubble.imageUrl.test.ts）=====

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

function propExp(el: TemplateEl, name: string): string | null {
  const p = (el.props ?? []).find(p => p.name === name)
  return p?.exp?.content ?? p?.value?.content ?? null
}

/** `:argName="exp"` 形式的绑定 prop（Vue AST 中是 name:'bind' + arg 的指令） */
function bindPropExp(el: TemplateEl, argName: string): string | null {
  const p = (el.props ?? []).find(p => p.name === 'bind' && p.arg?.content === argName)
  return p?.exp?.content ?? null
}

/** `@event="exp"` 事件绑定（name:'on' + arg 的指令） */
function onExp(el: TemplateEl, event: string): string | null {
  const p = (el.props ?? []).find(p => p.name === 'on' && p.arg?.content === event)
  return p?.exp?.content ?? null
}

// jsdom 环境 import.meta.url 非 file 协议（readFileSync 会拒），用 cwd（desktop 根）解析
const source = readFileSync(resolve(process.cwd(), 'src/components/chat/MessageBubble.vue'), 'utf8')
const { descriptor } = parse(source)
const ast = descriptor.template?.ast as TemplateEl | undefined

describe('MessageBubble 编辑态容器换载体', () => {
  it('编辑态分支（role === user && isEditing）用 MessageEditEditor，不再有裸 textarea', () => {
    const editBlocks = findElements(ast, (el) => el.tag === 'div'
      && (propExp(el, 'else-if') ?? '') === "role === 'user' && isEditing")
    expect(editBlocks).toHaveLength(1)
    const block = editBlocks[0]
    expect(findElements(block, (el) => el.tag === 'MessageEditEditor')).toHaveLength(1)
    expect(findElements(block, (el) => el.tag === 'textarea')).toHaveLength(0)
  })

  it('全模板不再有编辑态 textarea（旧载体清零）', () => {
    expect(findElements(ast, (el) => el.tag === 'textarea')).toHaveLength(0)
  })

  it('确认按钮 disabled 仍读 editContent.trim()，点击走 handleConfirm', () => {
    const confirmBtns = findElements(ast, (el) => el.tag === 'button'
      && (bindPropExp(el, 'disabled') ?? '') === '!editContent.trim()')
    expect(confirmBtns).toHaveLength(1)
    expect(onExp(confirmBtns[0], 'click')).toBe('handleConfirm')
  })
})
