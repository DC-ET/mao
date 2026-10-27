export interface FileChangeSessionLookup {
  workspace?: string
  parentSessionId?: string | null
}

/**
 * file_change 事件上的 sessionId 可能是主会话、边路或子代理。
 * 修订号按工作区记，所以要走到带 workspace 的根会话。
 * 找不到就返回 null：调用方不递增，避免用原始相对路径撞上另一个工作区。
 */
export function resolveFileChangeWorkspace(
  sessionId: string,
  lookup: {
    getSession: (id: string) => FileChangeSessionLookup | null | undefined
    findSideTaskRootKey: (id: number) => string | null
    findSubagentParentId: (id: number) => string | null
  },
): string | null {
  return walk(sessionId, lookup, new Set())
}

function walk(
  sessionId: string,
  lookup: {
    getSession: (id: string) => FileChangeSessionLookup | null | undefined
    findSideTaskRootKey: (id: number) => string | null
    findSubagentParentId: (id: number) => string | null
  },
  seen: Set<string>,
): string | null {
  if (!sessionId || seen.has(sessionId)) return null
  seen.add(sessionId)
  const entity = lookup.getSession(sessionId)
  if (entity?.workspace) return entity.workspace
  const parentId = entity?.parentSessionId ? String(entity.parentSessionId) : ''
  if (parentId) {
    const viaParent = walk(parentId, lookup, seen)
    if (viaParent) return viaParent
  }
  const numeric = Number(sessionId)
  if (Number.isSafeInteger(numeric) && numeric > 0) {
    const root = lookup.findSideTaskRootKey(numeric)
    if (root && root !== sessionId) {
      const viaRoot = walk(root, lookup, seen)
      if (viaRoot) return viaRoot
    }
    const subParent = lookup.findSubagentParentId(numeric)
    if (subParent && subParent !== sessionId) {
      const viaSub = walk(subParent, lookup, seen)
      if (viaSub) return viaSub
    }
  }
  return null
}
