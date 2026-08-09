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

/** 多仓库工作区中单个 git 仓库的轻量摘要（不含文件明细）。 */
export interface GitRepoSummary {
  /** 仓库目录名（如 project-a） */
  name: string
  /** 相对工作区根的目录路径（一级子目录名） */
  path: string
  branch?: string
  changedFileCount: number
  insertions: number
  deletions: number
  /** 统计失败/超时标记：为 true 时展示「不可用」，避免仓库静默消失。 */
  unavailable?: boolean
}

/** 多仓库发现结果：工作区自身是否 git 仓库 + 一级子目录 git 仓库列表。 */
export interface GitReposResult {
  isRootGit: boolean
  repos: GitRepoSummary[]
  error?: string
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
