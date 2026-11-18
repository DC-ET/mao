/** Whether a path is absolute (Unix or Windows). */
export function isAbsolutePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  return /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/')
}

/** Join workspace root with a relative path, or pass through absolute paths unchanged. */
export function resolveWorkspaceFilePath(workspace: string, filePath: string): string {
  if (!filePath) return filePath
  if (isAbsolutePath(filePath)) return filePath
  if (!workspace) return filePath
  const sep = workspace.includes('\\') ? '\\' : '/'
  return workspace.replace(/[\\/]+$/, '') + sep + filePath.replace(/^[\\/]+/, '')
}

/** Convert an absolute path under workspace to a relative path when possible. */
export function toRelativeWorkspacePath(workspace: string, filePath: string): string {
  if (!workspace || !filePath) return filePath
  const ws = workspace.replace(/\\/g, '/').replace(/\/+$/, '')
  const fp = filePath.replace(/\\/g, '/')
  if (fp === ws) return ''
  if (fp.startsWith(ws + '/')) {
    return fp.slice(ws.length + 1)
  }
  return filePath
}

/**
 * 词法解析 filePath 相对 workspace 的绝对路径并校验包含关系（技术方案 2026-11-17 §4.2-2）。
 * `..` 越出 workspace（或盘符 / UNC 根）、绝对路径落在 workspace 之外、workspace 退化为
 * 根目录（'/'，包含性失去意义）时返回 null。渲染进程无 node path 模块，这里做纯词法
 * 归一（不触盘、不解析符号链接），分隔符跟随 workspace；大小写不归一（Windows 上大小写
 * 变体按越界拒绝，fail closed）。
 */
export function resolveWithinWorkspace(workspace: string, filePath: string): string | null {
  if (!workspace || !filePath) return null
  const sep = workspace.includes('\\') ? '\\' : '/'
  // 只替换另一种分隔符、保留重复序列：UNC 的前导 \\ 不能被折叠
  const toSep = (p: string) => p.replace(sep === '\\' ? /\//g : /\\/g, sep)
  const base = toSep(workspace).replace(/[\\/]+$/, '')
  const raw = toSep(isAbsolutePath(filePath) ? filePath : base + sep + filePath)
  // 头部三态：UNC（\\server\share）、盘符（C:\）、POSIX 根（/）——拼接时必须带上分隔符
  let head = ''
  let rest = raw
  if (sep === '\\' && raw.startsWith('\\\\')) {
    head = '\\\\'
    rest = raw.slice(2)
  } else if (/^[A-Za-z]:/.test(raw)) {
    head = raw.slice(0, 2) + sep
    rest = raw.slice(2)
  } else if (raw.startsWith(sep)) {
    head = sep
    rest = raw.slice(1)
  }
  const stack: string[] = []
  for (const part of rest.split(sep)) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (stack.length === 0) return null
      stack.pop()
      continue
    }
    stack.push(part)
  }
  const resolved = head + stack.join(sep)
  // 包含性比较统一到正斜杠规范形（分隔符数量在头部/中间可能不一致）
  const canon = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  const baseCanon = canon(base)
  if (!baseCanon) return null
  const resolvedCanon = canon(resolved)
  if (resolvedCanon === baseCanon || resolvedCanon.startsWith(baseCanon + '/')) return resolved
  return null
}
