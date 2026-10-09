/** 用户改名、移动、删除之后，中心区文件 / diff 页签如何跟着变。 */
export type WorkspacePathChange =
  | { kind: 'delete'; paths: string[] }
  | { kind: 'move'; from: string; to: string }

export type TabPathUpdate =
  | { action: 'keep' }
  | { action: 'close' }
  | { action: 'retarget'; path: string }

function isSameOrUnder(path: string, root: string): boolean {
  if (path === root) return true
  const prefix = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(prefix)
}

export function retargetTabPath(filePath: string, change: WorkspacePathChange): TabPathUpdate {
  if (change.kind === 'delete') {
    return change.paths.some((root) => isSameOrUnder(filePath, root))
      ? { action: 'close' }
      : { action: 'keep' }
  }
  if (filePath === change.from) return { action: 'retarget', path: change.to }
  const prefix = change.from.endsWith('/') ? change.from : `${change.from}/`
  if (!filePath.startsWith(prefix)) return { action: 'keep' }
  const base = change.to.replace(/\/$/, '')
  return { action: 'retarget', path: `${base}/${filePath.slice(prefix.length)}` }
}
