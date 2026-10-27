import type { editor as MonacoEditor } from 'monaco-editor'
import {
  snippetWithinLimit,
  type FileRangeQuotePayload,
} from '../utils/selection-quote'

/**
 * 在只读 Monaco 上注册一次「引用到对话」。
 * Diff 会反复 setModel，动作挂在编辑器上，不要每次换模型都再注册。
 */
export function attachMonacoQuote(options: {
  editor: MonacoEditor.IStandaloneCodeEditor
  getFilePath: () => string
  getCapturedRevision: () => number
  onQuote: (quote: FileRangeQuotePayload) => void
}): () => void {
  const { editor } = options
  const host = editor.getDomNode()
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = '引用到对话'
  button.className = 'monaco-quote-btn'
  button.style.position = 'absolute'
  button.style.zIndex = '30'
  button.style.display = 'none'
  button.style.height = '24px'
  button.style.padding = '0 8px'
  button.style.border = '1px solid var(--aw-hairline, #ddd)'
  button.style.borderRadius = '6px'
  button.style.background = 'var(--aw-canvas, #fff)'
  button.style.color = 'var(--aw-ink, #222)'
  button.style.fontSize = '12px'
  button.style.lineHeight = '22px'
  button.style.cursor = 'pointer'
  button.style.boxShadow = '0 1px 4px rgba(0,0,0,.12)'
  if (host) {
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative'
    host.appendChild(button)
  }

  let snapshot: { start: number; end: number } | null = null

  const action = editor.addAction({
    id: 'mao.quote-to-chat',
    label: '引用到对话',
    contextMenuGroupId: 'navigation',
    run: (ed) => {
      const range = lineRange(ed, true)
      if (!range) return
      const quote = buildQuote(ed, range, options.getFilePath(), options.getCapturedRevision())
      if (quote) options.onQuote(quote)
    },
  })

  const selectionSub = editor.onDidChangeCursorSelection(() => refreshButton())
  const scrollSub = editor.onDidScrollChange(() => refreshButton())
  const contentSub = editor.onDidChangeModelContent(() => {
    snapshot = null
    button.style.display = 'none'
  })

  button.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (!snapshot) return
    const quote = buildQuote(editor, snapshot, options.getFilePath(), options.getCapturedRevision())
    if (quote) options.onQuote(quote)
    button.style.display = 'none'
  })

  return () => {
    selectionSub.dispose()
    scrollSub.dispose()
    contentSub.dispose()
    action.dispose()
    button.remove()
  }

  function refreshButton(): void {
    const range = lineRange(editor, false)
    snapshot = range
    if (!range || !host) {
      button.style.display = 'none'
      return
    }
    const pos = editor.getScrolledVisiblePosition({ lineNumber: range.end, column: 1 })
    if (!pos || pos.top < 0 || pos.top > host.clientHeight) {
      button.style.display = 'none'
      return
    }
    const top = pos.top > 28 ? pos.top - 28 : pos.top + pos.height
    button.style.display = 'block'
    button.style.top = `${top}px`
    button.style.left = `${Math.max(8, pos.left)}px`
  }
}

function lineRange(
  editor: MonacoEditor.ICodeEditor,
  allowCursor: boolean,
): { start: number; end: number } | null {
  const model = editor.getModel()
  if (!model) return null
  const selection = editor.getSelection()
  if (!selection || selection.isEmpty()) {
    if (!allowCursor) return null
    const position = editor.getPosition()
    if (!position) return null
    const line = clampLine(position.lineNumber, model.getLineCount())
    return { start: line, end: line }
  }
  let start = selection.startLineNumber
  let end = selection.endLineNumber
  // 拖到下一行行首时，Monaco 的 endColumn 是 1，这一行并没有被选中。
  if (end > start && selection.endColumn === 1) end -= 1
  start = clampLine(start, model.getLineCount())
  end = clampLine(end, model.getLineCount())
  if (end < start) end = start
  return { start, end }
}

function clampLine(line: number, count: number): number {
  if (count < 1) return 1
  return Math.min(Math.max(1, line), count)
}

function buildQuote(
  editor: MonacoEditor.ICodeEditor,
  range: { start: number; end: number },
  filePath: string,
  capturedChangeCount: number,
): FileRangeQuotePayload | null {
  const model = editor.getModel()
  if (!model || !filePath) return null
  const parts: string[] = []
  for (let line = range.start; line <= range.end; line++) parts.push(model.getLineContent(line))
  const text = parts.join('\n')
  return {
    filePath,
    lineStart: range.start,
    lineEnd: range.end,
    snippet: snippetWithinLimit(text) ? text : null,
    languageId: model.getLanguageId() || '',
    capturedChangeCount,
  }
}
