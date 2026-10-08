import type { FileChange } from '../types/chat'

/**
 * 同一路径的多次改动合并成一行：增删行数相加。
 * 任一记录是新建则类型保持 CREATED，与聊天里的文件变更面板一致。
 */
export function mergeFileChangesByPath(changes: FileChange[]): FileChange[] {
  const byPath = new Map<string, FileChange>()
  for (const change of changes) {
    if (!change.path) continue
    const existing = byPath.get(change.path)
    if (!existing) {
      byPath.set(change.path, { ...change })
      continue
    }
    existing.linesAdded += change.linesAdded
    existing.linesDeleted += change.linesDeleted
    if (change.type === 'CREATED') existing.type = 'CREATED'
  }
  return [...byPath.values()]
}
