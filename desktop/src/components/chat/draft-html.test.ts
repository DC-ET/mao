/**
 * @vitest-environment jsdom
 */
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it } from 'vitest'
import { coerceDraftHtml, resolveDraftHtml } from './draft-html'

function makeEditor(content: string): Editor {
  return new Editor({
    extensions: [StarterKit.configure({
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
    })],
    content,
  })
}

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

describe('coerceDraftHtml', () => {
  it('纯文本换行合成 br，setContent 后换行还在', () => {
    const html = coerceDraftHtml('1\n2\n3', '1\n2\n3')
    expect(html).toBe('<p>1<br>2<br>3</p>')
    editor = makeEditor(html)
    expect(editor.getText({ blockSeparator: '\n' })).toBe('1\n2\n3')
  })

  it('直接把纯文本交给 setContent 时换行被折成空格', () => {
    editor = makeEditor('1\n2\n3')
    expect(editor.getText({ blockSeparator: '\n' })).toBe('1 2 3')
  })

  it('已是编辑器 HTML 时不改写', () => {
    const html = '<p>1</p><p>2</p><p>3</p>'
    expect(coerceDraftHtml(html, '1\n2\n3')).toBe(html)
  })
})

describe('resolveDraftHtml', () => {
  it('编辑器还能序列化时用 live HTML', () => {
    expect(resolveDraftHtml({
      liveHtml: '<p>1</p><p>2</p>',
      plainText: '1\n2',
      storedHtml: '1\n2',
      storedText: '1\n2',
    })).toBe('<p>1</p><p>2</p>')
  })

  it('编辑器已销毁时沿用同文的 HTML，不退回纯文本', () => {
    expect(resolveDraftHtml({
      liveHtml: null,
      plainText: '1\n2',
      storedHtml: '<p>1</p><p>2</p>',
      storedText: '1\n2',
    })).toBe('<p>1</p><p>2</p>')
  })

  it('库里的 html 已是纯文本时按换行重新合成', () => {
    expect(resolveDraftHtml({
      liveHtml: null,
      plainText: '1\n2',
      storedHtml: '1\n2',
      storedText: '1\n2',
    })).toBe('<p>1<br>2</p>')
  })
})
