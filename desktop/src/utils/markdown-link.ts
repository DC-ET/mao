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
