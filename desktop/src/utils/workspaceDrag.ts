import { DRAG_PATHS_MIME, parseDragPaths } from './file-manager'

/** 跨面板拖拽载荷 MIME：JSON `[{path, isDirectory}]`，聊天输入框 / 中心 Tab 栏等落点消费 */
export const WORKSPACE_ENTRIES_MIME = 'application/x-mao-entries'

export interface WorkspaceDragEntry {
  path: string
  isDirectory: boolean
}

/** 三处 dragstart 的唯一写入点：entries（跨面板落点）+ paths（面板内部移动既有消费）双载荷。 */
export function setWorkspaceDragPayload(e: DragEvent, entries: WorkspaceDragEntry[]): void {
  if (!e.dataTransfer) return
  e.dataTransfer.setData(WORKSPACE_ENTRIES_MIME, JSON.stringify(entries))
  e.dataTransfer.setData(DRAG_PATHS_MIME, JSON.stringify(entries.map((it) => it.path)))
  // 'move' 限定下浏览器对 copy 目标显示禁止光标；放宽后面板内部目标显式 dropEffect='move' 语义不变
  e.dataTransfer.effectAllowed = 'copyMove'
}

/** entries 元素形状校验：path 非空字符串、isDirectory 布尔，不符即整条剔除 */
function isValidEntry(value: unknown): value is WorkspaceDragEntry {
  if (typeof value !== 'object' || value === null) return false
  const it = value as Partial<WorkspaceDragEntry>
  return typeof it.path === 'string' && it.path.length > 0 && typeof it.isDirectory === 'boolean'
}

/**
 * 跨面板落点统一入口：entries 优先，回退旧 paths 载荷（按文件处理）；
 * 坏 JSON / 空入参返回 []（落点据此放行走 OS 文件上传 / 浏览器默认行为）。
 */
export function parseWorkspaceDrag(dt: DataTransfer | null): WorkspaceDragEntry[] {
  if (!dt) return []
  const raw = dt.getData(WORKSPACE_ENTRIES_MIME)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) return parsed.filter(isValidEntry)
    } catch {
      // 坏 JSON：回退旧 paths 载荷
    }
    return []
  }
  return parseDragPaths(dt.getData(DRAG_PATHS_MIME)).map((path) => ({ path, isDirectory: false }))
}

/** 过滤掉目录；输入框与 Tab 栏落点都用它（目录在跨面板落点一律忽略）。 */
export function fileEntriesOf(entries: WorkspaceDragEntry[]): WorkspaceDragEntry[] {
  return entries.filter((it) => !it.isDirectory)
}

/**
 * dragover 事件的 dataTransfer 处于 protected mode：getData 一律返回空串，只能查 types。
 * drop 事件才可读数据（届时用 parseWorkspaceDrag）。目录 / 文件无法在 dragover 阶段区分。
 */
export function hasWorkspaceDragPayload(dt: DataTransfer | null): boolean {
  return !!dt && (dt.types.includes(WORKSPACE_ENTRIES_MIME) || dt.types.includes(DRAG_PATHS_MIME))
}
