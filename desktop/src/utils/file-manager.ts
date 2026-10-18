import type { FileManagerPrefs, FileNode } from '../types/file-browser'

/** 文件管理器本地偏好的 localStorage key */
export const FILE_MANAGER_PREFS_KEY = 'mao.file-manager.prefs'

/** 管理器内部拖拽移动时 dataTransfer 使用的 MIME（与侧边栏 FileTreeNode 一致，便于互通） */
export const DRAG_PATHS_MIME = 'application/x-mao-paths'

/** 递归搜索的结果上限，与后端 MAX_SEARCH_RESULTS 对齐 */
export const SEARCH_RESULT_LIMIT = 100

export const DEFAULT_PREFS: FileManagerPrefs = {
  viewMode: 'grid',
  sortBy: 'name',
  sortOrder: 'asc',
}

export function parsePrefs(raw: string | null): FileManagerPrefs {
  if (!raw) return { ...DEFAULT_PREFS }
  try {
    const parsed = JSON.parse(raw) as Partial<FileManagerPrefs> | null
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_PREFS }
    return {
      viewMode: parsed.viewMode === 'list' ? 'list' : 'grid',
      sortBy: parsed.sortBy === 'size' || parsed.sortBy === 'mtime' ? parsed.sortBy : 'name',
      sortOrder: parsed.sortOrder === 'desc' ? 'desc' : 'asc',
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export function serializePrefs(prefs: FileManagerPrefs): string {
  return JSON.stringify(prefs)
}

/** 目录优先，再按指定字段排序；同值恒按名称升序 tie-break（稳定可预期） */
export function sortEntries(
  entries: FileNode[],
  sortBy: FileManagerPrefs['sortBy'],
  sortOrder: FileManagerPrefs['sortOrder'],
): FileNode[] {
  const dir = sortOrder === 'asc' ? 1 : -1
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    if (sortBy === 'name') return a.name.localeCompare(b.name) * dir
    let cmp = 0
    if (sortBy === 'size') cmp = (a.size ?? 0) - (b.size ?? 0)
    else if (sortBy === 'mtime') cmp = (a.mtime ?? 0) - (b.mtime ?? 0)
    if (cmp !== 0) return cmp * dir
    return a.name.localeCompare(b.name)
  })
}

/** 取相对路径的父目录；根下文件返回 '' */
export function parentDirOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/')
  return idx <= 0 ? '' : relPath.slice(0, idx)
}

/** 拼接工作区相对路径 */
export function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

/** 新建/重命名的名称校验：非空、不含 / 与 \0、不是 . / ..（允许点开头，.gitignore 合法） */
export function isValidEntryName(name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed) return false
  if (trimmed.includes('/') || trimmed.includes('\0')) return false
  if (trimmed === '.' || trimmed === '..') return false
  return true
}

/**
 * 拖拽落点预检：目标必须是目录（非符号链接），不能是源自身、
 * 不能是任何源的子孙目录，也不能是源当前所在的目录（同目录移动是无操作）。
 */
export function canDropTarget(sourcePaths: string[], targetPath: string, entries: FileNode[]): boolean {
  if (sourcePaths.length === 0 || !targetPath) return false
  const target = entries.find((e) => e.path === targetPath)
  if (!target || !target.isDirectory || target.isSymlink) return false
  return canDropTargetDir(sourcePaths, targetPath)
}

/**
 * 落点是「当前目录」时的预检：当前目录不在自己的子列表里，无从查表，
 * 只做自身/子孙/父子/同目录关系校验。root（''）对不在根下的源是合法落点。
 */
export function canDropTargetDir(sourcePaths: string[], targetPath: string): boolean {
  if (sourcePaths.length === 0) return false
  for (const src of sourcePaths) {
    if (!src || src === targetPath) return false
    if (targetPath.startsWith(`${src}/`)) return false
    if (src.startsWith(`${targetPath}/`)) return false
    // 源已在目标目录下：同目录移动是无操作，后端会以「不能移动到自身」拒绝
    if (parentDirOf(src) === targetPath) return false
  }
  return true
}

/** 多选一起拖时剔除被其他选中项包含的子孙路径，避免移动父项后子项已不存在 */
export function dedupeMoveSources(paths: string[]): string[] {
  return paths.filter((p) => !paths.some((other) => other !== p && p.startsWith(`${other}/`)))
}

/** 拖拽某条目时实际携带的源集合：若该条目已在多选集中则带整个选集，否则只带自己 */
export function effectiveDragSources(entryPath: string, selected: string[]): string[] {
  return selected.includes(entryPath) ? dedupeMoveSources(selected) : [entryPath]
}

export function parseDragPaths(data: string | null): string[] {
  if (!data) return []
  try {
    const parsed = JSON.parse(data)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((p): p is string => typeof p === 'string' && p.length > 0)
  } catch {
    return []
  }
}

export function formatSize(bytes?: number): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  // 展示前再判一次档：退出循环时 value ∈ [100, 1024)，下面 value >= 100 走 Math.round，
  // 进位到 1024 就会出现「1024 KB」这种跨档读数（与 usageFormat.pickTokenUnit 的 999.95 进位同口径）。
  // 阈值取 1023.5 而非 1000：这是 Math.round 实际进位到 1024 的起点，取 1000 会把 1000~1023.4
  // 这一段本应显示「1000 KB」~「1023 KB」的读数提前升档。
  if (value >= 1023.5 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

export function formatTime(mtimeMs?: number): string {
  if (!mtimeMs) return '—'
  const d = new Date(mtimeMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export type FileIconKind = 'folder' | 'link' | 'image' | 'doc'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])

/** 文件图标分类：符号链接 > 目录 > 图片 > 文档（与 FileTreeNode 的四类映射一致） */
export function iconKindOf(name: string, isDirectory: boolean, isSymlink?: boolean): FileIconKind {
  if (isSymlink) return 'link'
  if (isDirectory) return 'folder'
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return IMAGE_EXTENSIONS.has(ext) ? 'image' : 'doc'
}
