/** 工作区总览 VO（与后端 workspace-overview.service.ts 的 WorkspaceOverviewEntry 对齐） */

export type WorkspaceKind = 'temp' | 'project' | 'other'
export type SizeState = 'ready' | 'pending' | 'timeout' | 'failed'

export interface WorkspaceOverviewEntry {
  name: string
  path: string
  kind: WorkspaceKind
  isGit: boolean
  sizeBytes: number | null
  sizeState: SizeState
  activeSessions: number
  archivedSessions: number
  lastUsedAt: string | null
}

export interface WorkspaceOverviewResult {
  entries: WorkspaceOverviewEntry[]
  error: string | null
}

/** 目录的进行中引用（删除确认弹层展示用） */
export interface WorkspaceReference {
  id: number
  title: string | null
  phase: string | null
}
