/** 文件引用标签的展示文案：`名字` / `名字:N` / `名字:N-M`（过期时带「内容可能已变化」）。
 *  tiptap 节点渲染 HTML 与队列 / 气泡里的 FileReferenceTag 共用这一份——
 *  两处各写一遍，改格式时漏一边就对不上。与 selection-quote.ts 的
 *  `第 N-M 行：` 序列化格式是两套口径：一个给人看，一个进发送文本。 */

export function fileReferenceName(filePath: string): string {
  if (!filePath) return ''
  const parts = filePath.split(/[/\\]/)
  return parts[parts.length - 1] || filePath
}

export function fileReferenceLabel(attrs: {
  filePath?: string | null
  lineStart?: number | null
  lineEnd?: number | null
  stale?: string | null
}): string {
  const name = fileReferenceName(attrs.filePath || '')
  if (attrs.lineStart == null) return name
  const end = attrs.lineEnd ?? attrs.lineStart
  const ranged = end === attrs.lineStart ? `${name}:${attrs.lineStart}` : `${name}:${attrs.lineStart}-${end}`
  return attrs.stale === '1' ? `${ranged} · 内容可能已变化` : ranged
}
