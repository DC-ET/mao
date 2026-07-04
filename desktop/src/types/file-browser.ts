import type { FileChange } from './chat'

export interface FileNode {
  name: string
  path: string          // relative to workspace
  isDirectory: boolean
  isSymlink?: boolean
  size?: number
  children?: FileNode[]
  expanded?: boolean
  error?: string
}

export interface Tab {
  id: string            // 'chat' for chat tab, relative path for file tabs
  type: 'chat' | 'file' | 'diff' | 'side_task'
  title: string
  filePath?: string     // relative path within workspace
  fileChange?: FileChange
  version?: number      // increment on each re-open to force remount
  /** 边路任务子会话 ID（仅 type === 'side_task' 时有效） */
  sideSessionId?: number
}

export interface SessionTabState {
  tabs: Tab[]           // file tabs + side_task tabs only (chat tab is implicit)
  activeTabId: string   // 'chat' or file/side_task tab id
}
