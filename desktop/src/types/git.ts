export type GitChangeType = 'CREATED' | 'MODIFIED' | 'DELETED' | 'RENAMED' | 'COPIED'

export interface GitStatusSummary {
  isGit: boolean
  repoRoot?: string
  branch?: string
  insertions: number
  deletions: number
  changedFileCount: number
  error?: string
}

export interface GitChangedFile {
  path: string
  oldPath?: string
  changeType: GitChangeType | string
  untracked?: boolean
  insertions: number
  deletions: number
  binary?: boolean
}

export interface GitStatusResult extends GitStatusSummary {
  files: GitChangedFile[]
}

export interface GitFileDiff {
  path: string
  changeType: GitChangeType | string
  beforeContent: string
  afterContent: string
  truncated?: boolean
  binary?: boolean
  unavailableReason?: string
}

export type GitTreeNode =
  | {
      kind: 'dir'
      name: string
      path: string
      children: GitTreeNode[]
    }
  | {
      kind: 'file'
      name: string
      path: string
      file: GitChangedFile
    }
