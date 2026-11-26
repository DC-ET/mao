import { markedTextToEditorHtml } from '../../utils/editor-tags'

const HAS_TAG = /<[a-z]/i

/** 纯文本按编辑器 HTML 包一层。换行变成 br，标记还原成标签节点。 */
export function htmlFromPlainDraft(text: string): string {
  return `<p>${markedTextToEditorHtml(text)}</p>`
}

/**
 * setContent 只接受编辑器 HTML。纯文本里的换行会被当成 HTML 空白折成空格。
 * 已经是 HTML 的原样返回；否则用 text（没有则用 html 自己）合成。
 */
export function coerceDraftHtml(html: string, text: string): string {
  if (HAS_TAG.test(html)) return html
  const source = text || html
  if (!source) return html
  return htmlFromPlainDraft(source)
}

/**
 * 取出应写入草稿的 html。
 * 编辑器还能序列化时用 getHTML()。不能时沿用同文的已有 HTML（含标签节点）；
 * 没有再从纯文本合成，避免把「1\\n2」写进 html 字段。
 */
export function resolveDraftHtml(options: {
  liveHtml: string | null
  plainText: string
  storedHtml?: string
  storedText?: string
}): string {
  if (options.liveHtml != null) return options.liveHtml
  const storedHtml = options.storedHtml ?? ''
  if (storedHtml && options.storedText === options.plainText && HAS_TAG.test(storedHtml)) {
    return storedHtml
  }
  return htmlFromPlainDraft(options.plainText)
}
