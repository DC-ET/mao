/**
 * UTF-8 安全的 base64 编解码。
 * 与既有 encodeCodeForCopy（useMarkdown）/ decodeCode（codeCopy）同口径，独立成文件
 * 供 mermaid 占位 / math / table 三处复用；Node 20+ 与浏览器均内置 btoa/atob。
 */
export function encodeBase64Utf8(text: string): string {
  return btoa(unescape(encodeURIComponent(text)))
}

export function decodeBase64Utf8(encoded: string): string | null {
  try {
    return decodeURIComponent(escape(atob(encoded)))
  } catch {
    return null
  }
}
