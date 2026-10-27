import { parseQuickCommandSegments, type ParsedSegment } from './quick-command-parser'
import { userVisibleText } from './imageUrlAnnotation'

export const REPLY_QUOTE_MAX_CHARS = 2000
export const FILE_QUOTE_MAX_LINES = 200
export const FILE_QUOTE_MAX_BYTES = 8 * 1024
export const QUOTE_SUMMARY_CHARS = 80

export interface ReplyQuote {
  id: string
  text: string
  truncated: boolean
}

export interface FileRangeQuote {
  filePath: string
  lineStart: number
  lineEnd: number
  /** 未超限时的片段；超限时为 null */
  snippet: string | null
  /** monaco 语言 id；plaintext 或空则围栏不写语言 */
  languageId: string
}

export interface FileRangeQuotePayload extends FileRangeQuote {
  capturedChangeCount: number
}

export interface FileDisplaySegment {
  type: 'file'
  filePath: string
  lineStart?: number
  lineEnd?: number
}

export type DisplaySegment =
  | { type: 'text'; content: string }
  | { type: 'skill'; name: string }
  | { type: 'command'; name: string }
  | FileDisplaySegment

const OPENING_FENCE = /^(```+|~~~+)([^\s`]*)\s*$/

export function capReplyQuote(text: string): { text: string; truncated: boolean } {
  const normalized = trimEdgeBlankLines(text)
  if (normalized.length <= REPLY_QUOTE_MAX_CHARS) {
    return { text: normalized, truncated: false }
  }
  const slice = normalized.slice(0, REPLY_QUOTE_MAX_CHARS)
  const newlineAt = slice.lastIndexOf('\n')
  const cut = newlineAt > 0 ? slice.slice(0, newlineAt).replace(/\n+$/, '') : slice
  return { text: cut, truncated: true }
}

export function serializeReplyQuotes(quotes: ReplyQuote[]): string {
  if (quotes.length === 0) return ''
  return quotes.map(serializeOneReplyQuote).join('\n\n') + '\n\n'
}

export function measureSnippet(text: string): { lines: number; bytes: number } {
  return {
    lines: text.split('\n').length,
    bytes: new TextEncoder().encode(text).length,
  }
}

export function fenceLanguage(languageId: string): string {
  const id = (languageId || '').trim()
  if (!id || id === 'plaintext') return ''
  if (!/^[\w#+.-]+$/.test(id)) return ''
  return id
}

export function serializeFileRange(quote: FileRangeQuote): string {
  const rangeLabel = quote.lineStart === quote.lineEnd
    ? `第 ${quote.lineStart} 行`
    : `第 ${quote.lineStart}-${quote.lineEnd} 行`
  if (quote.snippet == null) {
    return `@{${quote.filePath}}@ ${rangeLabel}（片段过长未内联，请按行号读取）\n`
  }
  const fence = backtickFence(quote.snippet)
  const lang = fenceLanguage(quote.languageId)
  const open = lang ? `${fence}${lang}` : fence
  return `@{${quote.filePath}}@ ${rangeLabel}：\n${open}\n${quote.snippet}\n${fence}\n`
}

export function snippetWithinLimit(text: string): boolean {
  const measured = measureSnippet(text)
  return measured.lines <= FILE_QUOTE_MAX_LINES && measured.bytes <= FILE_QUOTE_MAX_BYTES
}

export function absorbFileRangeSuffix(segments: ParsedSegment[]): DisplaySegment[] {
  const out: DisplaySegment[] = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const next = segments[i + 1]
    if (seg.type === 'file' && next?.type === 'text') {
      const absorbed = takeFileRangeSuffix(next.content)
      if (absorbed) {
        out.push({
          type: 'file',
          filePath: seg.filePath,
          lineStart: absorbed.lineStart,
          lineEnd: absorbed.lineEnd,
        })
        if (absorbed.rest.length > 0) out.push({ type: 'text', content: absorbed.rest })
        i += 1
        continue
      }
    }
    if (seg.type === 'file') out.push({ type: 'file', filePath: seg.filePath })
    else out.push(seg)
  }
  return out
}

export function splitLeadingReplyQuotes(text: string): { quotes: string[]; rest: string } {
  const lines = text.split('\n')
  const quotes: string[][] = []
  let current: string[] | null = null
  let i = 0
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('>')) {
      const content = line.startsWith('> ') ? line.slice(2) : line.slice(1)
      if (!current) current = []
      current.push(content)
      continue
    }
    if (line.trim() === '') {
      if (current) {
        quotes.push(current)
        current = null
      }
      continue
    }
    break
  }
  if (current) quotes.push(current)
  return {
    quotes: quotes.map(linesOfQuote => linesOfQuote.join('\n').trim()).filter(Boolean),
    rest: lines.slice(i).join('\n'),
  }
}

export function summarizeQuote(text: string, max = QUOTE_SUMMARY_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max)}…`
}

/** 气泡 / 队列：开头的回复引用折成摘要，剩下的正文再折叠文件行区间。 */
export function splitUserMessageForDisplay(text: string): { quotes: string[]; segments: DisplaySegment[] } {
  const { quotes, rest } = splitLeadingReplyQuotes(text)
  return {
    quotes,
    segments: absorbFileRangeSuffix(parseQuickCommandSegments(rest)),
  }
}

/** 轮次摘要 / 分叉标签：只留用户真正要问的那句。什么都不剩时用「引用」。 */
export function userAskExcerpt(raw: string): string {
  const visible = userVisibleText(raw ?? '')
  const { quotes, rest } = splitLeadingReplyQuotes(visible)
  const segments = absorbFileRangeSuffix(parseQuickCommandSegments(rest))
  let ranged = false
  let ask = ''
  for (const seg of segments) {
    if (seg.type === 'text') ask += seg.content
    else if (seg.type === 'file') {
      if (seg.lineStart == null) ask += seg.filePath
      else ranged = true
    } else ask += seg.name
  }
  ask = ask.replace(/\s+/g, ' ').trim()
  if (ask) return ask
  if (quotes.length > 0 || ranged) return '引用'
  return ''
}

/**
 * 选区纯文本。KaTeX 的 mathml 与可见 HTML 各有一份文本，这里只留用户看见的那份。
 * 供气泡选区浮钮使用；单测不依赖真实 DOM。
 */
export function plainTextFromRange(range: Range): string {
  const fragment = range.cloneContents()
  const chunks: string[] = []
  fragment.childNodes.forEach(node => appendSelectionNode(node, chunks))
  return finishSelectionText(chunks.join(''))
}

function serializeOneReplyQuote(quote: ReplyQuote): string {
  const lines = quote.text.split('\n').map(line => (line.length === 0 ? '>' : `> ${line}`))
  if (quote.truncated) lines.push('> …（已截断）')
  return lines.join('\n')
}

function trimEdgeBlankLines(text: string): string {
  const lines = text.replace(/\u00a0/g, ' ').split('\n')
  let start = 0
  let end = lines.length
  while (start < end && lines[start].trim() === '') start++
  while (end > start && lines[end - 1].trim() === '') end--
  return lines.slice(start, end).join('\n')
}

function backtickFence(snippet: string): string {
  let longest = 0
  for (const line of snippet.split('\n')) {
    const runs = line.match(/`+/g)
    if (!runs) continue
    for (const run of runs) longest = Math.max(longest, run.length)
  }
  const size = longest >= 3 ? longest + 1 : 3
  return '`'.repeat(size)
}

function takeFileRangeSuffix(text: string): { lineStart: number; lineEnd: number; rest: string } | null {
  const omitted = text.match(/^ 第 (\d+)(?:-(\d+))? 行（片段过长未内联，请按行号读取）/)
  if (omitted) {
    return {
      lineStart: Number(omitted[1]),
      lineEnd: Number(omitted[2] ?? omitted[1]),
      rest: dropOneLeadingNewline(text.slice(omitted[0].length)),
    }
  }
  const head = text.match(/^ 第 (\d+)(?:-(\d+))? 行：\n/)
  if (!head) return null
  const open = openingFence(text.slice(head[0].length))
  if (!open) return null
  const bodyStart = head[0].length + open.lineLength
  const closeAt = findClosingFence(text, bodyStart, open)
  if (closeAt == null) return null
  return {
    lineStart: Number(head[1]),
    lineEnd: Number(head[2] ?? head[1]),
    rest: dropOneLeadingNewline(text.slice(closeAt)),
  }
}

function dropOneLeadingNewline(text: string): string {
  return text.startsWith('\n') ? text.slice(1) : text
}

interface FenceOpen {
  char: string
  len: number
  /** 开围栏行含结尾换行的长度；调用方从正文起点算 */
  lineLength: number
}

function openingFence(text: string): FenceOpen | null {
  const lineEnd = text.indexOf('\n')
  if (lineEnd < 0) return null
  const line = text.slice(0, lineEnd)
  const matched = OPENING_FENCE.exec(line)
  if (!matched) return null
  return { char: matched[1][0], len: matched[1].length, lineLength: lineEnd + 1 }
}

function findClosingFence(text: string, from: number, open: { char: string; len: number }): number | null {
  let index = from
  while (index <= text.length) {
    const next = text.indexOf('\n', index)
    const line = text.slice(index, next === -1 ? text.length : next)
    if (isClosingFence(line, open)) {
      return next === -1 ? text.length : next + 1
    }
    if (next === -1) return null
    index = next + 1
  }
  return null
}

function isClosingFence(line: string, open: { char: string; len: number }): boolean {
  if (line.length < open.len) return false
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== open.char) return false
  }
  return true
}

const SKIP_SELECTION = '.katex-mathml, .code-copy-btn, .code-block-header, button'
const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'PRE', 'H1', 'H2', 'H3', 'H4', 'TR', 'BLOCKQUOTE'])

function appendSelectionNode(node: Node, chunks: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    chunks.push((node.textContent || '').replace(/\u00a0/g, ' '))
    return
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    node.childNodes.forEach(child => appendSelectionNode(child, chunks))
    return
  }
  const el = node as HTMLElement
  if (typeof el.matches === 'function' && el.matches(SKIP_SELECTION)) return
  const tag = el.tagName
  if (tag === 'TD' || tag === 'TH') {
    el.childNodes.forEach(child => appendSelectionNode(child, chunks))
    chunks.push(' | ')
    return
  }
  if (tag === 'BR' || BLOCK_TAGS.has(tag)) {
    el.childNodes.forEach(child => appendSelectionNode(child, chunks))
    chunks.push('\n')
    return
  }
  el.childNodes.forEach(child => appendSelectionNode(child, chunks))
}

function finishSelectionText(raw: string): string {
  const lines = raw.split('\n').map(line => line.replace(/[ \t]+$/, ''))
  let start = 0
  let end = lines.length
  while (start < end && lines[start] === '') start++
  while (end > start && lines[end - 1] === '') end--
  return lines.slice(start, end).join('\n')
}
