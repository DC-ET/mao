/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { insertPlainParagraphs } from './paste-insert'

/** 真实 TipTap 编辑器（StarterKit 同 ChatInput 基础 schema）：锁定抽取后的段落插入行为。 */
function makeEditor(content = '<p></p>'): Editor {
  return new Editor({ extensions: [StarterKit], content })
}

describe('insertPlainParagraphs', () => {
  let editor: Editor | null = null
  afterEach(() => {
    editor?.destroy()
    editor = null
  })

  it('多行文本 → 每行一个段落，文本一致', () => {
    editor = makeEditor()
    insertPlainParagraphs(editor.view, '第一行\n第二行\n第三行')
    const doc = editor.getJSON() as { content?: Array<{ type: string; content?: Array<{ text?: string }> }> }
    const texts = doc.content?.map((node) => node.content?.map((c) => c.text ?? '').join('') ?? '')
    expect(texts).toEqual(['第一行', '第二行', '第三行'])
  })

  it('空行 → 空 paragraph（保持行结构）', () => {
    editor = makeEditor()
    insertPlainParagraphs(editor.view, 'a\n\nb')
    const doc = editor.getJSON() as { content?: unknown[] }
    expect(doc.content?.length).toBe(3)
    expect(editor.getText({ blockSeparator: '|' })).toBe('a||b')
  })

  it('Markdown 源文本按段落呈现（不做富文本解析）', () => {
    editor = makeEditor()
    insertPlainParagraphs(editor.view, '## 标题\n\n- 列表项')
    const doc = editor.getJSON() as { content?: Array<{ type: string }> }
    // 全部是 paragraph 节点、markdown 源文本原样在文本里——非 h2/list 节点
    expect(doc.content?.every((node) => node.type === 'paragraph')).toBe(true)
    expect(editor.getText({ blockSeparator: '\n' })).toBe('## 标题\n\n- 列表项')
  })

  it('连续插入可追加（共享函数被两个粘贴分支复用的语义）', () => {
    editor = makeEditor()
    insertPlainParagraphs(editor.view, '一')
    insertPlainParagraphs(editor.view, '二')
    expect(editor.getText({ blockSeparator: '\n' })).toContain('一')
    expect(editor.getText({ blockSeparator: '\n' })).toContain('二')
  })
})
