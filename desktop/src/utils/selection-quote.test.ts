/**
 * @vitest-environment jsdom
 *
 * 选区摘要在 Node 里是纯逻辑，表格摘要有真实 DOM 选区（plainTextFromRange），
 * 整个文件跑 jsdom。
 */
import { describe, expect, it } from 'vitest'
import {
  REPLY_QUOTE_MAX_CHARS,
  absorbFileRangeSuffix,
  capReplyQuote,
  plainTextFromRange,
  serializeFileRange,
  serializeReplyQuotes,
  splitLeadingReplyQuotes,
  splitUserMessageForDisplay,
  userAskExcerpt,
} from './selection-quote'
import { parseQuickCommandSegments } from './quick-command-parser'
import { stripInternalMarkers } from './internalMarkers'

describe('capReplyQuote', () => {
  it('刚好 2000 字不截断，并去掉首尾空行', () => {
    const text = 'a'.repeat(REPLY_QUOTE_MAX_CHARS)
    expect(capReplyQuote(`\n${text}\n`)).toEqual({ text, truncated: false })
  })

  it('超出时切在 2000 字以内最后一个换行；没有换行就硬切', () => {
    const cut = capReplyQuote(`${'a'.repeat(100)}\n${'b'.repeat(2000)}`)
    expect(cut.truncated).toBe(true)
    expect(cut.text).toBe('a'.repeat(100))

    const hard = capReplyQuote('b'.repeat(2001))
    expect(hard).toEqual({ text: 'b'.repeat(2000), truncated: true })
  })
})

describe('serializeReplyQuotes', () => {
  it('每行加引用前缀，引用之间空一行，末尾再空一行', () => {
    const text = serializeReplyQuotes([
      { id: '1', text: '第一行\n\n第二行', truncated: false },
      { id: '2', text: '另一段', truncated: true },
    ])
    expect(text).toBe('> 第一行\n>\n> 第二行\n\n> 另一段\n> …（已截断）\n\n')
  })
})

describe('serializeFileRange', () => {
  it('行号写在标记外面，片段里的长反引号会加长围栏', () => {
    const text = serializeFileRange({
      filePath: 'src/a.py',
      lineStart: 3,
      lineEnd: 3,
      snippet: '```\ncode\n```',
      languageId: 'plaintext',
    })
    expect(text.startsWith('@{src/a.py}@ 第 3 行：\n````\n')).toBe(true)
    expect(text.endsWith('\n````\n')).toBe(true)
    expect(text).not.toContain('```python')
  })

  it('超限只留行号，不写围栏', () => {
    const text = serializeFileRange({
      filePath: 'src/a.py',
      lineStart: 1,
      lineEnd: 8,
      snippet: null,
      languageId: 'python',
    })
    expect(text).toBe('@{src/a.py}@ 第 1-8 行（片段过长未内联，请按行号读取）\n')
  })
})

describe('display folding', () => {
  it('吸收行区间时不改动 @{path}@ 本身', () => {
    const raw = '@{src/a.py}@ 第 3-5 行：\n```python\nprint(1)\n```\n然后呢'
    const segments = absorbFileRangeSuffix(parseQuickCommandSegments(raw))
    expect(segments[0]).toEqual({ type: 'file', filePath: 'src/a.py', lineStart: 3, lineEnd: 5 })
    expect(segments[1]).toEqual({ type: 'text', content: '然后呢' })
    expect(stripInternalMarkers(raw)).toContain('src/a.py')
  })

  it('超限句同样折进行号，普通文件引用保持原样', () => {
    const raw = '@{src/a.py}@ 第 1-8 行（片段过长未内联，请按行号读取）\n看 @{readme.md}@'
    const segments = absorbFileRangeSuffix(parseQuickCommandSegments(raw))
    expect(segments[0]).toMatchObject({ type: 'file', filePath: 'src/a.py', lineStart: 1, lineEnd: 8 })
    expect(segments[2]).toEqual({ type: 'file', filePath: 'readme.md' })
  })

  it('气泡把开头的回复引用折掉，问题留在后面', () => {
    const view = splitUserMessageForDisplay('> 引用甲\n>\n> 第二行\n\n> 引用乙\n\n这是问题 @{src/a.py}@')
    expect(view.quotes).toEqual(['引用甲\n\n第二行', '引用乙'])
    const visible = view.segments.map(seg => {
      if (seg.type === 'text') return seg.content
      if (seg.type === 'file') return seg.filePath
      return seg.name
    }).join('')
    expect(visible).toContain('这是问题')
  })

  it('轮次摘要只留问题；只剩引用时用「引用」', () => {
    const raw = '> 很长的引用\n\n@{src/a.py}@ 第 1 行：\n```\nx\n```\n请解释 ${review}$'
    expect(userAskExcerpt(raw)).toBe('请解释 review')
    expect(userAskExcerpt('> 只有引用\n\n')).toBe('引用')
    expect(userAskExcerpt('@{src/a.py}@ 第 2-4 行（片段过长未内联，请按行号读取）\n')).toBe('引用')
    expect(userAskExcerpt('看 @{readme.md}@')).toBe('看 readme.md')
  })
})

describe('splitLeadingReplyQuotes', () => {
  it('遇到非引用行就停，中间空行把两段引用分开', () => {
    expect(splitLeadingReplyQuotes('> a\n\n> b\n问题')).toEqual({
      quotes: ['a', 'b'],
      rest: '问题',
    })
  })
})

describe('plainTextFromRange', () => {
  function rangeOver(root: HTMLElement): Range {
    const range = document.createRange()
    range.setStart(root, 0)
    range.setEnd(root, root.childNodes.length)
    return range
  }

  it('表格行：单元格之间一个「 | 」，行尾不留', () => {
    const table = document.createElement('table')
    table.innerHTML = '<tr><td>甲</td><td>乙</td><td>丙</td></tr>'
    expect(plainTextFromRange(rangeOver(table))).toBe('甲 | 乙 | 丙')
  })

  it('表头同样只留在单元格之间', () => {
    const table = document.createElement('table')
    table.innerHTML = '<tr><th>列一</th><th>列二</th></tr>'
    expect(plainTextFromRange(rangeOver(table))).toBe('列一 | 列二')
  })

  it('多行表格按行换行', () => {
    const table = document.createElement('table')
    table.innerHTML = '<tr><td>a1</td><td>a2</td></tr><tr><td>b1</td><td>b2</td></tr>'
    expect(plainTextFromRange(rangeOver(table))).toBe('a1 | a2\nb1 | b2')
  })
})
