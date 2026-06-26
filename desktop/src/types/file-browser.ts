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
  type: 'chat' | 'file'
  title: string
  filePath?: string     // absolute path for file tabs
}

export interface SessionTabState {
  tabs: Tab[]           // file tabs only (chat tab is implicit)
  activeTabId: string   // 'chat' or file tab id
}
