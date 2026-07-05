/** Whether a path is absolute (Unix or Windows). */
export function isAbsolutePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  return /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/')
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
