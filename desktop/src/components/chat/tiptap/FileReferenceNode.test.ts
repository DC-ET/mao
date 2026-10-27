/**
 * @vitest-environment jsdom
 */
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import { FileReferenceNode } from './FileReferenceNode'
import { fileReferenceLabel } from '../../../utils/file-range-label'

function editorWith(attrs: Record<string, unknown>): Editor {
  return new Editor({
    extensions: [StarterKit, FileReferenceNode],
    content: {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'fileReference', attrs }],
      }],
    },
  })
}

describe('FileReferenceNode', () => {
  it('行区间写在标记外，过期提示不进发送文本', () => {
    const editor = editorWith({
      filePath: 'src/a.py',
      lineStart: 3,
      lineEnd: 4,
      snippet: 'print(1)',
      languageId: 'python',
      capturedChangeCount: 2,
      stale: '1',
    })
    const text = editor.getText({ blockSeparator: '\n' })
    expect(text).toContain('@{src/a.py}@ 第 3-4 行：')
    expect(text).toContain('```python\nprint(1)\n```')
    expect(text).not.toContain('内容可能已变化')
    expect(editor.getHTML()).toContain('a.py:3-4 · 内容可能已变化')
    editor.destroy()
  })

  it('没有行号时仍然只输出 @{path}@', () => {
    const editor = editorWith({ filePath: 'readme.md' })
    expect(editor.getText({ blockSeparator: '\n' })).toBe('@{readme.md}@')
    editor.destroy()
  })

  it('HTML 属性可以往返，标签按文件名和行号显示', () => {
    expect(fileReferenceLabel({ filePath: 'dir\\a.py', lineStart: 8, lineEnd: 8 })).toBe('a.py:8')
    const editor = editorWith({
      filePath: 'src/a.py',
      lineStart: 8,
      lineEnd: 9,
      snippet: 'x',
      languageId: 'python',
      capturedChangeCount: 1,
    })
    const html = editor.getHTML()
    editor.commands.setContent(html)
    const text = editor.getText({ blockSeparator: '\n' })
    expect(text).toContain('@{src/a.py}@ 第 8-9 行：')
    expect(text).toContain('x')
    editor.destroy()
  })
})
