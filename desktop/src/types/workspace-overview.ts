/**
 * 工作区总览 VO（与后端 workspace-overview.service.ts 的 WorkspaceOverviewEntry 对齐）。
 * 枚举（WorkspaceKind 等）下沉 @mao/contracts，两端共用同一份联合（AGENTS.md 跨端枚举规范）。
 */

import type { WorkspaceChannel, WorkspaceChatType, WorkspaceKind } from '@mao/contracts'

export type { WorkspaceKind, WorkspaceChannel, WorkspaceChatType } from '@mao/contracts'
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
  /** 机器人通道类型（kind === 'channel' 时存在）：飞书 / 钉钉。 */
  channel?: WorkspaceChannel
  /** 通道会话类型（kind === 'channel' 时存在）：群聊（多人共享）/ 私聊（本人）。 */
  chatType?: WorkspaceChatType
  /** 机器人账号 id（kind === 'channel' 时存在）：飞书 app_id / 钉钉 botId。 */
  accountId?: string
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
