export type GitChangeType = 'CREATED' | 'MODIFIED' | 'DELETED' | 'RENAMED' | 'COPIED'

export interface GitStatusSummary {
  isGit: boolean
  repoRoot?: string
  branch?: string
  insertions: number
  deletions: number
  changedFileCount: number
  remotes: string[]
  hasRemote: boolean
  hasHead: boolean
  detachedHead: boolean
  upstream?: string
  remoteStatusAvailable: boolean
  remoteStatusError?: string
  aheadCount?: number
  behindCount?: number
  hasCommitsToPush?: boolean
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

export type GitOperationType = 'commit' | 'pull' | 'push' | 'fetch' | 'switch' | 'stash'

export interface GitOperationResult {
  success: boolean
  operation: GitOperationType | string
  message?: string
  error?: string
  branch?: string
  commitHash?: string
  commitTitle?: string
  stashRef?: string
  conflict?: boolean
}

/** 提交历史条目（`git log --format=%H%x00%h%x00%s%x00%an%x00%aI%x00%D` 一行一提交）。 */
export interface GitLogEntry {
  hash: string
  shortHash: string
  title: string
  author: string
  /** ISO 8601（git %aI） */
  date: string
  /** 原始 %D refs 装饰串，如 'HEAD -> main, origin/main, tag: v1.0'；无装饰时缺省 */
  refs?: string
}

/** 分支条目：本地分支（isRemote=false）或远端跟踪分支（isRemote=true）。 */
export interface GitBranchInfo {
  name: string
  isCurrent: boolean
  isRemote: boolean
  upstream?: string
  ahead?: number
  behind?: number
  lastCommitHash?: string
  lastCommitTitle?: string
}

/** stash 条目：ref 形如 stash@{0}，message 含 On branch 摘要与 mao-auto-* 标识。 */
export interface GitStashEntry {
  ref: string
  message: string
  /** ISO 8601（git %aI） */
  date: string
}

/** 远端条目：URL 已在服务端 / Electron 侧脱敏（user:token@ → ***@）。 */
export interface GitRemoteInfo {
  name: string
  fetchUrl: string
  pushUrl: string
}

/** 单次提交的文件变更清单结果。 */
export interface GitCommitFilesResult {
  hash: string
  files: GitChangedFile[]
}

/**
 * 分支对比结果：`base → target` 两点差异的文件清单 + 两侧独有提交数。
 * 语义为两点 diff（`git diff <base> <target>`，直接比较两棵树的当前内容）：
 * 清单包含两侧全部差异；基准分支独有的改动会以「删除（D）/ 反向修改」形式出现，
 * 属两点语义的固有方向性（UI 用方向标注与「仅基准分支」标记承接）。
 */
export interface GitBranchCompareResult {
  base: string
  target: string
  /** 目标分支独有的提交数（rev-list --left-right --count base...target 的 right 段） */
  aheadCount: number
  /** 基准分支独有的提交数（同命令 left 段；等价于 rev-list --count target..base） */
  behindCount: number
  files: GitChangedFile[]
}

/** stash 操作类型（服务端 / Electron 侧白名单枚举）。 */
export type GitStashAction = 'apply' | 'pop' | 'drop'

/** LLM 生成的提交信息：title 为首行，message 为完整文本（两步提交第一步的产物）。 */
export interface GitCommitMessage {
  title: string
  message: string
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
