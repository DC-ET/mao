const { contextBridge, ipcRenderer } = require('electron')

function onIpc(channel, callback) {
  const handler = (_event, data) => callback(data)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('electronAPI', {
  // Auth token persistence (Electron userData/auth.json, all load protocols)
  getAuthTokens: () => ipcRenderer.invoke('auth-get-tokens'),
  setAuthTokens: (tokens) => ipcRenderer.invoke('auth-set-tokens', tokens),
  clearAuthTokens: () => ipcRenderer.invoke('auth-clear-tokens'),

  // Multi-server baseUrl configuration
  serverConfig: {
    get: () => ipcRenderer.invoke('server-config-get'),
    set: (payload) => ipcRenderer.invoke('server-config-set', payload),
    probe: (serverBaseUrl, options) =>
      ipcRenderer.invoke('server-config-probe', {
        serverBaseUrl,
        allowHttp: options?.allowHttp === true,
      }),
    openPicker: () => ipcRenderer.invoke('server-config-open-picker'),
  },

  // Original APIs
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getEnvironmentInfo: (workspace) => ipcRenderer.invoke('get-environment-info', { workspace }),
  gitStatus: (workspace, repoPath) => ipcRenderer.invoke('git-status', { workspace, repoPath }),
  refreshGitStatus: (workspace, repoPath) => ipcRenderer.invoke('git-status-refresh', { workspace, repoPath }),
  gitFileDiff: (workspace, repoPath, filePath) => ipcRenderer.invoke('git-file-diff', { workspace, repoPath, path: filePath }),
  gitRepos: (workspace) => ipcRenderer.invoke('git-repos', { workspace }),
  gitCommitInput: (workspace, repoPath) => ipcRenderer.invoke('git-commit-input', { workspace, repoPath }),
  gitCommit: (workspace, repoPath, message) => ipcRenderer.invoke('git-commit', { workspace, repoPath, message }),
  gitPull: (workspace, repoPath) => ipcRenderer.invoke('git-pull', { workspace, repoPath }),
  gitPush: (workspace, repoPath) => ipcRenderer.invoke('git-push', { workspace, repoPath }),
  gitLog: (workspace, repoPath, options) => ipcRenderer.invoke('git-log', { workspace, repoPath, options }),
  gitCommitFiles: (workspace, repoPath, hash) => ipcRenderer.invoke('git-commit-files', { workspace, repoPath, hash }),
  gitCommitFileDiff: (workspace, repoPath, hash, path, oldPath) => ipcRenderer.invoke('git-commit-file-diff', { workspace, repoPath, hash, path, oldPath }),
  gitBranches: (workspace, repoPath) => ipcRenderer.invoke('git-branches', { workspace, repoPath }),
  gitStashes: (workspace, repoPath) => ipcRenderer.invoke('git-stashes', { workspace, repoPath }),
  gitRemotes: (workspace, repoPath) => ipcRenderer.invoke('git-remotes', { workspace, repoPath }),
  gitFetch: (workspace, repoPath) => ipcRenderer.invoke('git-fetch', { workspace, repoPath }),
  gitSwitchBranch: (workspace, repoPath, branch, create) => ipcRenderer.invoke('git-switch-branch', { workspace, repoPath, branch, create }),
  gitStashOp: (workspace, repoPath, action, ref) => ipcRenderer.invoke('git-stash-op', { workspace, repoPath, action, ref }),
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateChecking: (callback) => onIpc('update-checking', callback),
  onDownloadProgress: (callback) => onIpc('download-progress', callback),
  onUpdateAvailable: (callback) => onIpc('update-available', callback),
  onUpdateNotAvailable: (callback) => onIpc('update-not-available', callback),
  onUpdateDownloaded: (callback) => onIpc('update-downloaded', callback),
  onUpdateError: (callback) => onIpc('update-error', callback),
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window-maximize'),
  closeWindow: () => ipcRenderer.invoke('window-close'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openFeishuAuthWindow: (authUrl, callbackPath) => ipcRenderer.invoke('open-feishu-auth-window', { authUrl, callbackPath }),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  openTerminal: (folderPath) => ipcRenderer.invoke('open-terminal', folderPath),
  showItemInFolder: (fullPath) => ipcRenderer.invoke('show-item-in-folder', fullPath),

  // Tool execution via Streaming WS (called by renderer when server sends tool_execute)
  // approvalHint（V135）为第 8 参：服务端生成的「总是允许」模式提示，透传给审批卡片；旧调用缺省 null
  toolExecute: (toolName, args, requestId, workspace, sessionId, needApproval, dangerReason, approvalHint) =>
    ipcRenderer.invoke('tool-execute', { toolName, args, requestId, workspace, sessionId, needApproval, dangerReason, approvalHint: approvalHint ?? null }),

  // Local tool execution - direct IPC (for renderer-initiated calls)
  localReadFile: (args) => ipcRenderer.invoke('local-read-file', args),
  localReadBytes: (args) => ipcRenderer.invoke('local-read-bytes', args),
  localWriteFile: (args) => ipcRenderer.invoke('local-write-file', args),
  localEditFile: (args) => ipcRenderer.invoke('local-edit-file', args),

  // Workspace file listing for file references
  listWorkspaceFiles: (workspace, filter, limit) =>
    ipcRenderer.invoke('list-workspace-files', { workspace, filter, limit }),

  // Directory listing for file browser (non-recursive, single level)
  listDirectory: (dirPath, workspace) =>
    ipcRenderer.invoke('list-directory', { dirPath, workspace }),

  // Tool approval — renderer UI, main process waits for response
  onToolApprovalRequest: (callback) => {
    ipcRenderer.on('tool-approval-request', (event, data) => callback(data))
  },
  removeToolApprovalRequestListener: () => {
    ipcRenderer.removeAllListeners('tool-approval-request')
  },
  onToolApprovalDismiss: (callback) => {
    ipcRenderer.on('tool-approval-dismiss', (event, data) => callback(data))
  },
  removeToolApprovalDismissListener: () => {
    ipcRenderer.removeAllListeners('tool-approval-dismiss')
  },
  // alwaysAllow（V135）为第 3 参：仅布尔位，规则 pattern 由服务端自行取回，客户端不可注入
  respondToolApproval: (requestId, approved, alwaysAllow) =>
    ipcRenderer.invoke('tool-approval-response', { requestId, approved, alwaysAllow: alwaysAllow === true }),

  // Skill sync — renderer triggers, main process downloads & extracts zip
  skillSync: (sessionId, syncUrl, token, workspace, apiBase) =>
    ipcRenderer.invoke('skill-sync', { sessionId, syncUrl, token, workspace, apiBase }),
  onSkillSyncComplete: (callback) => {
    ipcRenderer.on('skill-sync-complete', (event, data) => callback(data))
  },
  removeSkillSyncCompleteListener: () => {
    ipcRenderer.removeAllListeners('skill-sync-complete')
  },

  // MCP — renderer triggers, main process connects & lists tools
  mcpSync: (sessionId, servers) =>
    ipcRenderer.invoke('mcp-sync', { sessionId, servers }),
  mcpClose: (sessionId) =>
    ipcRenderer.invoke('mcp-close', { sessionId }),

  // Local skills in ~/.agents/skills
  listLocalSkills: () => ipcRenderer.invoke('list-local-skills'),
  getLocalSkillDetail: (folderName) => ipcRenderer.invoke('get-local-skill-detail', { folderName }),
  readLocalSkillFiles: (folderName) => ipcRenderer.invoke('read-local-skill-files', { folderName }),

  // Read AGENTS.md from workspace root (for LOCAL mode system prompt injection)
  readAgentsMd: (workspace) => ipcRenderer.invoke('read-agents-md', { workspace }),

  // Terminal (node-pty) — embedded terminal panel
  terminal: {
    create: (options) => ipcRenderer.invoke('terminal:create', options),
    write: (id, data) => ipcRenderer.send('terminal:data', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('terminal:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.invoke('terminal:kill', { id }),
    list: () => ipcRenderer.invoke('terminal:list'),
    onData: (callback) => {
      const handler = (_event, payload) => callback(payload)
      ipcRenderer.on('terminal:data', handler)
      return () => ipcRenderer.removeListener('terminal:data', handler)
    },
    onExit: (callback) => {
      const handler = (_event, payload) => callback(payload)
      ipcRenderer.on('terminal:exit', handler)
      return () => ipcRenderer.removeListener('terminal:exit', handler)
    },
  },

  // LOCAL attachments (P1) — copy a machine-local file into ~/.mao/attachments/<host>/<sid>/
  localCopyAttachment: (payload) => ipcRenderer.invoke('local-copy-attachment', payload),
  // Electron 32.0 removes File.path; webUtils.getPathForFile (same version) replaces it.
  // Implemented in the preload (a File object cannot cross structured-clone IPC); 28-31 keep
  // using file.path and never call this. Renderer compat: file.path ?? electronAPI.getPathForFile(file).
  getPathForFile: (file) => {
    try {
      const { webUtils } = require('electron')
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file) || ''
      }
    } catch {
      // Electron < 32: webUtils missing — caller falls back to File.path
    }
    return ''
  },

  // Desktop shell (P2/P3) — main-process notification / badge / prefs / shortcut / tray
  desktopNotify: (payload) => ipcRenderer.invoke('desktop-notify', payload),
  onDesktopNotificationClick: (callback) => onIpc('desktop-notification-click', callback),
  // 桥接就绪后主动拉取主进程积存的点击深链（点击时监听未注册会丢）；收到后 ack 清除
  consumePendingDesktopNotificationClick: () => ipcRenderer.invoke('desktop-notification-click-consume'),
  ackDesktopNotificationClick: () => ipcRenderer.invoke('desktop-notification-click-ack'),
  onDesktopNotifyResult: (callback) => onIpc('desktop-notify-result', callback),
  desktopBadge: (count) => ipcRenderer.invoke('desktop-badge', { count }),
  desktopPrefsGet: () => ipcRenderer.invoke('desktop-prefs-get'),
  desktopPrefsSet: (patch) => ipcRenderer.invoke('desktop-prefs-set', patch),
  desktopShortcutSet: (accel) => ipcRenderer.invoke('desktop-shortcut-set', accel),
  onDesktopShortcutFailed: (callback) => onIpc('desktop-shortcut-failed', callback),
  onTrayNewTask: (callback) => onIpc('tray-new-task', callback),
  onTrayFirstCloseHint: (callback) => onIpc('tray-first-close-hint', callback),
})
