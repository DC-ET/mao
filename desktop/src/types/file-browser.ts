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

/** 边路任务创建时的上下文继承方式：不继承 / 主会话摘要 / Fork 主会话（复制主会话历史消息） */
export type SideTaskContextMode = 'none' | 'summary' | 'fork'

/** 分叉来源：messageId 是被点击那一轮的助手最终回复 id（即切点），label 是该轮的来源摘录 */
export interface SideTaskForkSource {
  messageId: string
  label: string
}

export interface Tab {
  id: string            // 'chat' for chat tab, relative path for file tabs
  type: 'chat' | 'file' | 'diff' | 'side_task' | 'subagent'
  title: string
  filePath?: string     // relative path within workspace
  fileChange?: FileChange
  version?: number      // increment on each re-open to force remount
  /** 边路任务 / 子代理子会话 ID（type === 'side_task' | 'subagent'） */
  sideSessionId?: number
  /** 创建入口预置的上下文继承方式（占位 Tab 有意义：SideChatPanel 首条消息发出前展示并生效） */
  contextMode?: SideTaskContextMode
  /** 分叉来源（占位 Tab 有意义：首条消息发出时随 create_side_session 一起上报，之后不再变化） */
  forkFrom?: SideTaskForkSource
}

export interface SessionTabState {
  tabs: Tab[]           // file tabs + side_task tabs only (chat tab is implicit)
  activeTabId: string   // 'chat' or file/side_task tab id
}
