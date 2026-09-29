function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const isWindowsAbs = /^[a-zA-Z]:/.test(normalized)
  const isUnixAbs = normalized.startsWith('/')
  const parts = normalized.split('/')
  const stack: string[] = []

  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (stack.length > 0) stack.pop()
      continue
    }
    stack.push(part)
  }

  if (isWindowsAbs) {
    return stack.join('/')
  }
  if (isUnixAbs) {
    return '/' + stack.join('/')
  }
  return stack.join('/')
}

/** Resolve a markdown link href relative to the containing file path. Returns null for external/anchor links. */
export function resolveMarkdownLink(baseFilePath: string, href: string): string | null {
  const raw = href.trim()
  if (!raw || raw.startsWith('#')) return null
  if (/^(https?:\/\/|mailto:)/i.test(raw)) return null

  let pathPart = raw.split(/[#?]/)[0]
  if (!pathPart) return null

  if (pathPart.startsWith('file://')) {
    try {
      pathPart = decodeURIComponent(pathPart.replace(/^file:\/\/\/?/i, ''))
    } catch {
      return null
    }
  }

  const normalizedBase = baseFilePath.replace(/\\/g, '/')
  const normalizedHref = pathPart.replace(/\\/g, '/')
  const isAbsolute = /^[a-zA-Z]:/.test(normalizedHref) || normalizedHref.startsWith('/')

  if (isAbsolute) {
    return normalizePath(normalizedHref)
  }

  const slashIdx = normalizedBase.lastIndexOf('/')
  const baseDir = slashIdx >= 0 ? normalizedBase.slice(0, slashIdx) : ''
  const joined = baseDir ? `${baseDir}/${normalizedHref}` : normalizedHref
  return normalizePath(joined)
}

export function isExternalMarkdownLink(href: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(href.trim())
}

/** 由 document 委托接管、交给系统浏览器打开的协议。blob: 由本地下载逻辑自行管理，不在此列。 */
const EXTERNAL_PROTOCOL_RE = /^(https?|mailto):/i

/** 点击事件命中的锚点：外链内部可能包含 <code>、图片等子元素，要向上找到 <a>。 */
function findAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  const el = target as HTMLElement | null
  if (!el?.closest) return null
  return el.closest('a') as HTMLAnchorElement | null
}

/**
 * 取出点击目标对应的外链 URL；非外链点击（站内相对链接、锚点、
 * javascript:/blob: 等协议、无锚点）返回 null。
 * href 需 trim 后判空：空 href 的 <a> 点了也不该触发任何跳转。
 */
export function resolveExternalLinkHref(target: EventTarget | null): string | null {
  const href = findAnchor(target)?.getAttribute('href')
  if (!href) return null
  const trimmed = href.trim()
  return trimmed && EXTERNAL_PROTOCOL_RE.test(trimmed) ? trimmed : null
}
