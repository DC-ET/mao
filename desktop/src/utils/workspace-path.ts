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
