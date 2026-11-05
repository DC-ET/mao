/**
 * grep_search 命中行内的匹配片段高亮：把一行文本按 pattern 切成「命中 / 非命中」片段。
 * pattern 可能是非法正则（模型写错时 rg 会报错，但 JS 回退路径同样要兜底），
 * 编译失败时退化为字面量子串匹配，保证展示层永远有高亮、不抛错。
 */

export interface HighlightSegment {
  text: string
  hit: boolean
}

/** 按 pattern 切片；pattern 为空或全无命中时返回单段不命中。 */
export function highlightPattern(text: string, pattern: string, ignoreCase: boolean): HighlightSegment[] {
  if (!pattern || text === '') return [{ text, hit: false }]

  let regex: RegExp | null = null
  try {
    regex = new RegExp(pattern, ignoreCase ? 'gi' : 'g')
  } catch {
    regex = null
  }
  if (!regex) return literalSegments(text, pattern, ignoreCase)

  const segments: HighlightSegment[] = []
  let last = 0
  for (const m of text.matchAll(regex)) {
    const index = m.index ?? 0
    // 零宽匹配（如 a*）不产生高亮片段，直接跳过
    if (m[0] === '') continue
    if (index > last) segments.push({ text: text.slice(last, index), hit: false })
    segments.push({ text: m[0], hit: true })
    last = index + m[0].length
  }
  if (last < text.length) segments.push({ text: text.slice(last), hit: false })
  return segments.length > 0 ? segments : [{ text, hit: false }]
}

/** 非法正则的字面量兜底：大小写不敏感时统一转小写比较。 */
function literalSegments(text: string, pattern: string, ignoreCase: boolean): HighlightSegment[] {
  const haystack = ignoreCase ? text.toLowerCase() : text
  const needle = ignoreCase ? pattern.toLowerCase() : pattern
  const segments: HighlightSegment[] = []
  let cursor = 0
  for (;;) {
    const at = haystack.indexOf(needle, cursor)
    if (at < 0) break
    if (at > cursor) segments.push({ text: text.slice(cursor, at), hit: false })
    segments.push({ text: text.slice(at, at + needle.length), hit: true })
    cursor = at + needle.length
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false })
  return segments.length > 0 ? segments : [{ text, hit: false }]
}
