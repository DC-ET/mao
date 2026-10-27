/**
 * @vitest-environment jsdom
 *
 * Diff 查看器换文件 / 切主题走 setModel，而 setModel 不触发选区 / 滚动 /
 * 内容三个事件。旧快照的行号在新模型上没有意义：按钮必须跟着收起，
 * 否则点下去会按旧行号从新模型取内容（越界行是空串），引出错内容。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachMonacoQuote } from './useMonacoQuote'
import type { editor as MonacoEditor } from 'monaco-editor'

const LINES = ['import os', '', 'def main():', '    print(1)']

function fakeEditor() {
  const listeners = new Map<string, Array<() => void>>()
  const host = document.createElement('div')
  Object.defineProperty(host, 'clientHeight', { value: 400 })
  document.body.appendChild(host)
  let selection: {
    isEmpty: () => boolean
    startLineNumber: number
    endLineNumber: number
    endColumn: number
  } | null = null
  const editor = {
    getDomNode: () => host,
    addAction: () => ({ dispose() {} }),
    onDidChangeCursorSelection: (cb: () => void) => register('selection', cb),
    onDidScrollChange: (cb: () => void) => register('scroll', cb),
    onDidChangeModelContent: (cb: () => void) => register('content', cb),
    onDidChangeModel: (cb: () => void) => register('model', cb),
    getModel: () => ({
      getLineCount: () => LINES.length,
      getLineContent: (line: number) => LINES[line - 1] ?? '',
      getLanguageId: () => 'python',
    }),
    getSelection: () => selection,
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    getScrolledVisiblePosition: () => ({ top: 40, left: 10, height: 20 }),
  }
  function register(event: string, cb: () => void) {
    const list = listeners.get(event) ?? []
    list.push(cb)
    listeners.set(event, list)
    return { dispose() {} }
  }
  return {
    editor: editor as unknown as MonacoEditor.IStandaloneCodeEditor,
    host,
    fire: (event: string) => { for (const cb of listeners.get(event) ?? []) cb() },
    select: (start: number, end: number) => {
      selection = { isEmpty: () => false, startLineNumber: start, endLineNumber: end, endColumn: 5 }
    },
    clearSelection: () => { selection = null },
    button: () => host.querySelector('button') as HTMLButtonElement | null,
  }
}

let detach: (() => void) | null = null

afterEach(() => {
  detach?.()
  detach = null
  document.body.innerHTML = ''
})

describe('attachMonacoQuote', () => {
  it('选中多行后按钮可点，引用带上区间与片段', () => {
    const fake = fakeEditor()
    const onQuote = vi.fn()
    detach = attachMonacoQuote({
      editor: fake.editor,
      getFilePath: () => 'src/a.py',
      getCapturedRevision: () => 2,
      onQuote,
    })
    fake.select(3, 4)
    fake.fire('selection')
    fake.button()?.click()
    expect(onQuote).toHaveBeenCalledWith({
      filePath: 'src/a.py',
      lineStart: 3,
      lineEnd: 4,
      snippet: 'def main():\n    print(1)',
      languageId: 'python',
      capturedChangeCount: 2,
    })
  })

  it('setModel 换模型后清快照、藏按钮，再点不会按旧行号引用', () => {
    const fake = fakeEditor()
    const onQuote = vi.fn()
    detach = attachMonacoQuote({
      editor: fake.editor,
      getFilePath: () => 'src/a.py',
      getCapturedRevision: () => 2,
      onQuote,
    })
    fake.select(3, 4)
    fake.fire('selection')
    expect(fake.button()?.style.display).toBe('block')

    // Diff 查看器换文件：setModel 不触发 selection / scroll / content
    fake.fire('model')
    expect(fake.button()?.style.display).toBe('none')

    fake.button()?.click()
    expect(onQuote).not.toHaveBeenCalled()
  })

  it('换模型后重新选中仍可正常引用', () => {
    const fake = fakeEditor()
    const onQuote = vi.fn()
    detach = attachMonacoQuote({
      editor: fake.editor,
      getFilePath: () => 'src/b.py',
      getCapturedRevision: () => 0,
      onQuote,
    })
    fake.select(3, 4)
    fake.fire('selection')
    fake.fire('model')

    fake.select(1, 2)
    fake.fire('selection')
    fake.button()?.click()
    expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({
      filePath: 'src/b.py',
      lineStart: 1,
      lineEnd: 2,
      snippet: 'import os\n',
    }))
  })
})
