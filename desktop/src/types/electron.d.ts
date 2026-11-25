interface TerminalCreateOptions {
  cwd?: string
  cols?: number
  rows?: number
  shell?: string
}

/** 浏览器直播回放（V202）：与 @mao/contracts browser-replay 同构（electron.d.ts 自包含，不引入包依赖） */
interface BrowserReplayFrameMeta {
  seq: number
  ts: number
  pageUrl: string
  width: number
  height: number
  bytes: number
  file: string
}

interface BrowserReplayManifest {
  version: number
  liveId: string
  sessionId: number
  startedAt: number
  endedAt: number | null
  frameCount: number
  durationMs: number | null
  approxBytes: number
  cliSessions: string[]
  urls: string[]
  truncated: boolean
}

interface BrowserReplaySummary {
  liveId: string
  startedAt: number
  endedAt: number | null
  frameCount: number
  durationMs: number | null
  approxBytes: number
  truncated: boolean
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
  parents: string[]
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
  /** 提交正文：`git show -s --format=%B` 去除首行标题后的剩余部分（trim，空串表示无正文）。 */
  body: string
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
type DesktopDeviceInfo = import('./desktop').DesktopDeviceInfo
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

interface ServerConfigHistoryEntry {
  serverBaseUrl: string
  allowHttp: boolean
  lastConnectedAt: string | null
}

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
  history?: ServerConfigHistoryEntry[]
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
    closePicker(): Promise<{ ok: boolean }>
    removeHistory(serverBaseUrl: string): Promise<{ ok: boolean; error?: string; history?: ServerConfigHistoryEntry[]; authCleared?: boolean }>
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
  gitLog(workspace: string | undefined, repoPath: string | undefined, options?: { limit?: number; offset?: number; path?: string; keyword?: string; allBranches?: boolean }): Promise<GitLogEntry[] | { error: string }>
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
  gitDiscard(workspace: string | undefined, repoPath: string | undefined, paths: string[] | null, expectedDigest?: string): Promise<GitOperationResult>
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
  /** file_fetch 委托读取（方案 2026-11-18）：workspace + 相对路径，主进程 containment 校验后读字节。 */
  localReadWorkspaceBytes?(args: { workspace: string; path: string }): Promise<{ bytes?: Uint8Array; size?: number; error?: string }>
  /**
   * delivery_read 委托读取（2026-11-25 send_file 1GB R2）：open 校验路径并返回 size / mtimeMs，
   * read 按 offset 读一片（512KB），close 释放句柄。
   */
  localDeliveryOpen?(args: { workspace: string; path: string; maxBytes?: number }): Promise<{ ok?: boolean; openId?: string; size?: number; mtimeMs?: number; error?: string }>
  localDeliveryRead?(args: { openId: string; offset: number; length: number }): Promise<{ ok?: boolean; bytes?: Uint8Array; size?: number; mtimeMs?: number; error?: string }>
  localDeliveryDigest?(args: { openId: string }): Promise<{ ok?: boolean; sha256?: string; size?: number; mtimeMs?: number; error?: string }>
  localDeliveryClose?(args: { openId: string }): Promise<{ ok?: boolean; error?: string }>
  /** 大文件下载（R6）：票据 URL 交给 Chromium 下载，不 fetch 成 Blob。 */
  downloadUrl?(url: string): Promise<boolean>
  localWriteFile(args: any): Promise<any>
  localEditFile(args: any): Promise<any>
  listWorkspaceFiles(workspace: string, filter?: string, limit?: number): Promise<WorkspaceFile[]>
  listDirectory(dirPath: string, workspace: string): Promise<DirectoryResult>

  onToolApprovalRequest(callback: (data: any) => void): void
  removeToolApprovalRequestListener(): void
  onToolApprovalDismiss(callback: (data: any) => void): void
  removeToolApprovalDismissListener(): void
  respondToolApprovalRemote(requestId: string, approved: boolean, alwaysAllow?: boolean): Promise<boolean>

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
  /** 本机设备身份（稳定 deviceId + 主机名 + 平台）：WS auth 帧与建 LOCAL 会话使用 */
  getDeviceInfo(): Promise<DesktopDeviceInfo>
  desktopShortcutSet(accel: string | null): Promise<DesktopPrefsSetResult>
  onDesktopShortcutFailed(callback: (data: DesktopShortcutFailedPayload) => void): RemoveListener
  onTrayNewTask(callback: () => void): RemoveListener
  onTrayFirstCloseHint(callback: () => void): RemoveListener
  /** 浏览器直播（方案 2026-11-20 v2 D10）：画中画窗口与直播 Tab 的桥 */
  browserLive: {
    getState(): Promise<BrowserLiveStateSnapshot>
    /** CLOUD 帧：useStreamWS 收到 browser_live_* 事件后回灌主进程枢纽 */
    relayEvent(msg: { sessionId: number | null; type: string; data?: Record<string, unknown> }): void
    /** 停止浏览器：LOCAL 主进程直停 sidecar；CLOUD 主进程转请 renderer 发 WS 帧 */
    stop(sessionId: number): void
    /** LOCAL 会话终态：主进程向 sidecar 发停止（杀浏览器 + 收窗） */
    sessionEnded(sessionId: number, phase: string): void
    /** 画中画双击放大 → 主进程 hide 小窗并通知主窗开 Tab */
    expand(): void
    /** Tab 内还原画中画 */
    restore(): void
    /** 回放场次列表（V202）：fs 直读本机 runtime 目录，含未结算场；与 CLOUD API 同结构 */
    replayList(sessionId: number): Promise<BrowserReplaySummary[]>
    /** 回放 manifest + 全量帧索引 */
    replayTimeline(sessionId: number, liveId: string): Promise<{ manifest: BrowserReplayManifest; frames: BrowserReplayFrameMeta[] } | null>
    /** 单帧 JPEG 字节（invoke 结构化克隆直达，非法/缺失返回 null） */
    replayFrame(sessionId: number, liveId: string, seq: number): Promise<Uint8Array | null>
    onEvent(callback: (payload: { sessionId: number; type: string; data?: Record<string, unknown> }) => void): RemoveListener
    onActiveSession(callback: (payload: { sessionId: number | null }) => void): RemoveListener
    onExpand(callback: (payload: { sessionId: number | null }) => void): RemoveListener
    /** CLOUD 停止下行：主进程 → 主窗 renderer，由 useStreamWS 发 browser_live_stop 帧 */
    onStopRelay(callback: (payload: { sessionId: number }) => void): RemoveListener
  }
}

declare interface BrowserLiveStateSnapshot {
  activeSessionId: number | null
  sessions: Record<string, {
    isLive: boolean
    pageUrl: string
    width: number
    height: number
    cliSession: string
    stoppedReason: string | null
    lastSeq: number
    source: 'local' | 'cloud'
  }>
}

declare interface Window {
  electronAPI: ElectronAPI
}
