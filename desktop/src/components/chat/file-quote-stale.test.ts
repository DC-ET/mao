/**
 * @vitest-environment jsdom
 *
 * 「内容可能已变化」是用户不可见的内部状态同步：每个 file_change 事件都会重算，
 * 事务必须带 addToHistory=false，否则 Ctrl+Z 先撤销这个刷新而不是用户刚打的字。
 */
import { Editor } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import { FileReferenceNode } from './tiptap/FileReferenceNode'
import { refreshFileQuoteStaleFlags } from './file-quote-stale'

function editorWith(capturedChangeCount: number): Editor {
  return new Editor({
    extensions: [StarterKit, FileReferenceNode],
    content: {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'fileReference',
          attrs: {
            filePath: 'src/a.py',
            lineStart: 3,
            lineEnd: 4,
            snippet: 'print(1)',
            languageId: 'python',
            capturedChangeCount,
            stale: null,
          },
        }],
      }],
    },
  })
}

function staleAttr(editor: Editor): string | null {
  let stale: string | null = null
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'fileReference') stale = (node.attrs.stale ?? null) as string | null
  })
  return stale
}

describe('refreshFileQuoteStaleFlags', () => {
  it('修订号变大时打上 stale', () => {
    const editor = editorWith(0)
    refreshFileQuoteStaleFlags(editor, () => 1)
    expect(staleAttr(editor)).toBe('1')
    editor.destroy()
  })

  it('修订号没变时不动文档', () => {
    const editor = editorWith(2)
    refreshFileQuoteStaleFlags(editor, () => 2)
    expect(staleAttr(editor)).toBeNull()
    editor.destroy()
  })

  it('刷新不进撤销栈：Ctrl+Z 不会撤销 stale 标记', () => {
    const editor = editorWith(0)
    refreshFileQuoteStaleFlags(editor, () => 1)
    expect(staleAttr(editor)).toBe('1')
    // addToHistory=false → 没有任何可撤销的步骤
    expect(editor.can().undo()).toBe(false)
    editor.commands.undo()
    expect(staleAttr(editor)).toBe('1')
    editor.destroy()
  })
})
