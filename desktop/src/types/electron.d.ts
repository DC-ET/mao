interface TerminalCreateOptions {
  cwd?: string
  cols?: number
  rows?: number
  shell?: string
}

interface TerminalCreateResult {
  id: string
  shell: string
  cwd: string
}

interface TerminalDataPayload {
  id: string
  data: string
}

interface TerminalExitPayload {
  id: string
  exitCode: number
}

interface WorkspaceFile {
  path: string
  name: string
  size: number
}

interface DirectoryEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  mtime: number
  isSymlink: boolean
}

interface DirectoryResult {
  entries?: DirectoryEntry[]
  error?: string
  truncated?: boolean
}

interface LocalSkillDoc {
  folderName: string
  name: string
  description: string
  folderPath: string
}

interface LocalSkillListResult {
  skills?: LocalSkillDoc[]
  skillsDir?: string
  error?: string
}

interface LocalSkillFileEntry {
  relativePath: string
  base64: string
}

interface LocalSkillFilesResult {
  folderName?: string
  files?: LocalSkillFileEntry[]
  error?: string
}

interface LocalSkillDetail {
  folderName: string
  name: string
  description: string
  body: string
  folderPath: string
  filePath: string
}

interface AuthTokens {
  token: string | null
  refreshToken: string | null
}

interface GitCommitGenerationInput {
  files: Array<{
    path: string
    changeType: string
    insertions: number
    deletions: number
    binary: boolean
    sensitive: boolean
    truncated: boolean
    diff?: string
  }>
  truncated: boolean
  diffBytes: number
  error?: string
}

interface GitStatusResult {
  isGit: boolean
  repoRoot?: string
  branch?: string
  insertions?: number
  deletions?: number
  changedFileCount?: number
  remotes?: string[]
  hasRemote?: boolean
  hasHead?: boolean
  detachedHead?: boolean
  upstream?: string
  remoteStatusAvailable: boolean
  remoteStatusError?: string
  aheadCount?: number
  behindCount?: number
  hasCommitsToPush?: boolean
  files?: Array<{
    path: string
    oldPath?: string
    changeType: string
    untracked?: boolean
    insertions?: number
    deletions?: number
    binary?: boolean
  }>
  error?: string
}

interface GitOperationResult {
  success: boolean
  operation: 'commit' | 'pull' | 'push' | 'fetch' | 'switch' | 'stash'
  message?: string
  error?: string
  branch?: string
  commitHash?: string
  commitTitle?: string
  stashRef?: string
  conflict?: boolean
}

interface GitLogEntry {
  hash: string
  shortHash: string
  title: string
  author: string
  date: string
  refs?: string
}

interface GitBranchInfo {
  name: string
  isCurrent: boolean
  isRemote: boolean
  upstream?: string
  ahead?: number
  behind?: number
  lastCommitHash?: string
  lastCommitTitle?: string
}

interface GitStashEntry {
  ref: string
  message: string
  date: string
}

interface GitRemoteInfo {
  name: string
  fetchUrl: string
  pushUrl: string
}

interface GitCommitFilesResult {
  hash: string
  files: Array<{
    path: string
    oldPath?: string
    changeType: string
    untracked?: boolean
    insertions?: number
    deletions?: number
    binary?: boolean
  }>
}

type GitStashAction = 'apply' | 'pop' | 'drop'

type RemoveListener = () => void

/** 桌面壳（P1/P2/P3）契约类型集中在 ./desktop.ts，这里用行内 import 引用（避免把本文件变成 module） */
type LocalCopyAttachmentParams = import('./desktop').LocalCopyAttachmentParams
type LocalCopyAttachmentResult = import('./desktop').LocalCopyAttachmentResult
type DesktopNotifyPayload = import('./desktop').DesktopNotifyPayload
type DesktopNotifyResult = import('./desktop').DesktopNotifyResult
type DesktopNotificationClickPayload = import('./desktop').DesktopNotificationClickPayload
type DesktopNotifyResultPayload = import('./desktop').DesktopNotifyResultPayload
type DesktopPrefs = import('./desktop').DesktopPrefs
type DesktopPrefsGetResult = import('./desktop').DesktopPrefsGetResult
type DesktopPrefsSetResult = import('./desktop').DesktopPrefsSetResult
type DesktopShortcutFailedPayload = import('./desktop').DesktopShortcutFailedPayload

interface AppUpdateInfo {
  version?: string
  releaseName?: string
  releaseNotes?: string | Array<{ version: string; note: string }>
  releaseDate?: string
  files?: Array<{ url: string; sha512: string; size?: number }>
}

interface AppUpdateProgress {
  percent?: number
  bytesPerSecond?: number
  transferred?: number
  total?: number
}

interface AppUpdateError {
  message: string
  stack?: string
}

type ServerUpdateFeedMode = 'follow-site' | 'package-default' | 'disabled'

interface ServerConfigInfo {
  serverBaseUrl: string
  updateFeedMode: ServerUpdateFeedMode
  allowHttp: boolean
  configured: boolean
  envOverride: boolean
  appVersion: string
  hostKey: string
  apiBase: string
  updateFeed: { mode: string; url: string | null }
}

interface ServerConfigSetResult {
  ok: boolean
  serverBaseUrl?: string
  hostChanged?: boolean
  updateFeedMode?: ServerUpdateFeedMode
  error?: string
  probe?: { ok: boolean; error?: string; detail?: string }
}

interface ServerConfigProbeResult {
  ok: boolean
  baseUrl?: string
  detail?: string
  error?: string
}

interface ElectronAPI {
  getAuthTokens(): Promise<AuthTokens>
  setAuthTokens(tokens: { token: string; refreshToken: string }): Promise<void>
  clearAuthTokens(): Promise<void>

  serverConfig: {
    get(): Promise<ServerConfigInfo>
    set(payload: {
      serverBaseUrl: string
      updateFeedMode?: ServerUpdateFeedMode
      allowHttp?: boolean
      skipProbe?: boolean
    }): Promise<ServerConfigSetResult>
    probe(serverBaseUrl: string, options?: { allowHttp?: boolean }): Promise<ServerConfigProbeResult>
    openPicker(): Promise<{ ok: boolean }>
  }

  getAppVersion(): Promise<string>
  getPlatform(): Promise<string>
  getEnvironmentInfo(workspace?: string): Promise<{
    isGit: boolean
    platform: string
    shell: string
    osVersion: string
  }>
  gitStatus(workspace?: string, repoPath?: string): Promise<GitStatusResult>
  refreshGitStatus(workspace?: string, repoPath?: string): Promise<GitStatusResult>
  gitFileDiff(workspace: string | undefined, repoPath: string | undefined, path: string): Promise<{
    path: string
    changeType: string
    beforeContent: string
    afterContent: string
    truncated?: boolean
    binary?: boolean
    unavailableReason?: string
  }>
  gitRepos(workspace?: string): Promise<{
    isRootGit: boolean
    repos: Array<{
      name: string
      path: string
      branch?: string
      changedFileCount: number
      insertions: number
      deletions: number
      unavailable?: boolean
    }>
    error?: string
  }>
  gitCommitInput(workspace?: string, repoPath?: string): Promise<GitCommitGenerationInput>
  gitCommit(workspace: string | undefined, repoPath: string | undefined, message: string): Promise<GitOperationResult>
  gitPull(workspace?: string, repoPath?: string): Promise<GitOperationResult>
  gitPush(workspace?: string, repoPath?: string): Promise<GitOperationResult>
  gitLog(workspace: string | undefined, repoPath: string | undefined, options?: { limit?: number; offset?: number; path?: string }): Promise<GitLogEntry[] | { error: string }>
  gitCommitFiles(workspace: string | undefined, repoPath: string | undefined, hash: string): Promise<GitCommitFilesResult | { error: string }>
  gitCommitFileDiff(workspace: string | undefined, repoPath: string | undefined, hash: string, path: string, oldPath?: string): Promise<{
    path: string
    changeType: string
    beforeContent: string
    afterContent: string
    truncated?: boolean
    binary?: boolean
    unavailableReason?: string
  }>
  gitBranchCompare(workspace: string | undefined, repoPath: string | undefined, base: string, target: string): Promise<{
    base: string
    target: string
    aheadCount: number
    behindCount: number
    files: Array<{
      path: string
      oldPath?: string
      changeType: string
      insertions: number
      deletions: number
      binary?: boolean
    }>
  } | { error: string }>
  gitBranchCompareFileDiff(workspace: string | undefined, repoPath: string | undefined, base: string, target: string, path: string, oldPath?: string): Promise<{
    path: string
    changeType: string
    beforeContent: string
    afterContent: string
    truncated?: boolean
    binary?: boolean
    unavailableReason?: string
  }>
  gitBranches(workspace: string | undefined, repoPath: string | undefined): Promise<GitBranchInfo[] | { error: string }>
  gitStashes(workspace: string | undefined, repoPath: string | undefined): Promise<GitStashEntry[] | { error: string }>
  gitRemotes(workspace: string | undefined, repoPath: string | undefined): Promise<GitRemoteInfo[] | { error: string }>
  gitFetch(workspace: string | undefined, repoPath: string | undefined): Promise<GitOperationResult>
  gitSwitchBranch(workspace: string | undefined, repoPath: string | undefined, branch: string, create?: boolean): Promise<GitOperationResult>
  gitStashOp(workspace: string | undefined, repoPath: string | undefined, action: GitStashAction, ref: string): Promise<GitOperationResult>
  checkForUpdate(): Promise<{ skipped?: boolean; reason?: string; updateInfo?: AppUpdateInfo | null }>
  installUpdate(): Promise<{ success: boolean; error?: string }>
  onUpdateChecking(callback: (data: { feedUrl?: string }) => void): RemoveListener
  onDownloadProgress(callback: (data: AppUpdateProgress) => void): RemoveListener
  onUpdateAvailable(callback: (data: AppUpdateInfo) => void): RemoveListener
  onUpdateNotAvailable(callback: (data: AppUpdateInfo) => void): RemoveListener
  onUpdateDownloaded(callback: (data: AppUpdateInfo) => void): RemoveListener
  onUpdateError(callback: (data: AppUpdateError) => void): RemoveListener
  minimizeWindow(): Promise<void>
  maximizeWindow(): Promise<void>
  closeWindow(): Promise<void>
  openExternal(url: string): Promise<void>
  openFeishuAuthWindow(authUrl: string, callbackPath?: string): Promise<{ state: string; code?: string }>
  selectDirectory(): Promise<string | null>
  openFolder(folderPath: string): Promise<void>
  openTerminal(folderPath: string): Promise<void>
  showItemInFolder(fullPath: string): Promise<void>

  toolExecute(toolName: string, args: any, requestId: string, workspace: string, sessionId: string, needApproval: boolean, dangerReason?: string): Promise<any>
  localReadFile(args: any): Promise<any>
  /** LOCAL 二进制字节读取（技术方案 §5.2）：zip / xlsx / docx / 媒体预览取数，返回 Buffer（结构化克隆为 Uint8Array）。 */
  localReadBytes(args: { path: string }): Promise<{ bytes?: Uint8Array; size?: number; error?: string }>
  localWriteFile(args: any): Promise<any>
  localEditFile(args: any): Promise<any>
  listWorkspaceFiles(workspace: string, filter?: string, limit?: number): Promise<WorkspaceFile[]>
  listDirectory(dirPath: string, workspace: string): Promise<DirectoryResult>

  onToolApprovalRequest(callback: (data: any) => void): void
  removeToolApprovalRequestListener(): void
  onToolApprovalDismiss(callback: (data: any) => void): void
  removeToolApprovalDismissListener(): void
  respondToolApproval(requestId: string, approved: boolean): Promise<void>

  skillSync(sessionId: number, syncUrl: string, token: string, workspace: string, apiBase?: string): Promise<any>
  onSkillSyncComplete(callback: (data: any) => void): void
  removeSkillSyncCompleteListener(): void

  listLocalSkills(): Promise<LocalSkillListResult>
  getLocalSkillDetail(folderName: string): Promise<LocalSkillDetail | { error: string }>
  readLocalSkillFiles(folderName: string): Promise<LocalSkillFilesResult>

  terminal: {
    create(options: TerminalCreateOptions): Promise<TerminalCreateResult>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): Promise<void>
    list(): Promise<Array<{ id: string; shell: string; cwd: string; createdAt: number }>>
    onData(callback: (payload: TerminalDataPayload) => void): () => void
    onExit(callback: (payload: TerminalExitPayload) => void): () => void
  }

  // LOCAL attachments (P1)
  localCopyAttachment(params: LocalCopyAttachmentParams): Promise<LocalCopyAttachmentResult>
  /** Electron 32+ 的 webUtils.getPathForFile 兜底（28-31 恒走 File.path）；取不到返回空串 */
  getPathForFile(file: File): string

  // Desktop shell (P2/P3)
  desktopNotify(payload: DesktopNotifyPayload): Promise<DesktopNotifyResult>
  onDesktopNotificationClick(callback: (data: DesktopNotificationClickPayload) => void): RemoveListener
  /** 桥接就绪后拉取主进程积存的点击深链（无积存返回 null）；取出即清空 */
  consumePendingDesktopNotificationClick(): Promise<DesktopNotificationClickPayload | null>
  /** 已收到立即派发的点击深链：通知主进程清除待派发队列，防陈旧跳转 */
  ackDesktopNotificationClick(): Promise<{ ok: boolean }>
  onDesktopNotifyResult(callback: (data: DesktopNotifyResultPayload) => void): RemoveListener
  desktopBadge(count: number): Promise<{ ok: boolean }>
  desktopPrefsGet(): Promise<DesktopPrefsGetResult>
  desktopPrefsSet(patch: Partial<DesktopPrefs>): Promise<DesktopPrefsSetResult>
  desktopShortcutSet(accel: string | null): Promise<DesktopPrefsSetResult>
  onDesktopShortcutFailed(callback: (data: DesktopShortcutFailedPayload) => void): RemoveListener
  onTrayNewTask(callback: () => void): RemoveListener
  onTrayFirstCloseHint(callback: () => void): RemoveListener
}

declare interface Window {
  electronAPI: ElectronAPI
}
