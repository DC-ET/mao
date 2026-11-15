/**
 * 经验库视图的展示工具：文件大小、日期与 keywords 拆分。
 *
 * splitKeywords / groupKeyOf 是后端 `agent-experience-library.routes.ts` 同名逻辑的
 * 前端镜像（分组展示按服务端返回的 groupCounts 顺序，键计算须同口径）。
 */

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** ISO 串 → YYYY-MM-DD（按 UTC+8 取日期，与 admin formatDateTime 的固定 +08:00 展示口径一致；用于库列表的最近更新日）。 */
export function formatDate(iso: string): string {
  if (iso === '') return '—'
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return iso.slice(0, 10)
  return new Date(time + 8 * 3600_000).toISOString().slice(0, 10)
}

/** 与后端一致的 keywords 拆分：中英文逗号/顿号/分号，去空保序去重。 */
export function splitKeywords(keywords: string): string[] {
  if (keywords === '') return []
  const out: string[] = []
  for (const part of keywords.split(/[\s]*[,，、;；][\s]*/)) {
    const tag = part.trim()
    if (tag !== '' && !out.includes(tag)) out.push(tag)
  }
  return out
}

export const NO_MONTH_GROUP = '未命名'
export const NO_KEYWORD_GROUP = '未分类'

/** 分组键（月 = 文件名日期前缀；关键词 = 第一个非空 tag），须与后端 groupKeyOf 同口径。 */
export function groupKeyOf(doc: { fileName: string; keywords: string }, groupBy: 'month' | 'keyword'): string {
  if (groupBy === 'month') {
    return /^(\d{4}-\d{2})/.exec(doc.fileName)?.[1] ?? NO_MONTH_GROUP
  }
  return splitKeywords(doc.keywords)[0] ?? NO_KEYWORD_GROUP
}

/** last_verified 距今超过 180 天视为久未验证（灰标提示，可选增强）。 */
export function isStaleVerified(lastVerified: string): boolean {
  if (lastVerified === '') return false
  const time = new Date(`${lastVerified}T00:00:00`).getTime()
  return Number.isFinite(time) && Date.now() - time > 180 * 86400_000
}

/**
 * 去掉首部 frontmatter（渲染态用：字段已在元数据卡展示，正文再渲染一遍会被
 * setext 规则把 `---` 前的段落解析成标题）。与后端 experience-frontmatter 的
 * findFrontmatterEnd 同口径：行锚定，值里的 `---` 不误切，无开栏时原文返回。
 */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content
  let offset = 0
  let seenOpening = false
  for (const line of content.split('\n')) {
    const start = offset
    offset += line.length + 1
    if (line.trim() !== '---') continue
    if (!seenOpening) {
      if (start !== 0) return content
      seenOpening = true
      continue
    }
    return content.slice(offset)
  }
  return content
}
