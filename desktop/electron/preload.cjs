const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Auth token persistence (file:// localStorage does not survive restarts)
  getAuthTokens: () => ipcRenderer.invoke('auth-get-tokens'),
  setAuthTokens: (tokens) => ipcRenderer.invoke('auth-set-tokens', tokens),
  clearAuthTokens: () => ipcRenderer.invoke('auth-clear-tokens'),

  // Original APIs
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getEnvironmentInfo: (workspace) => ipcRenderer.invoke('get-environment-info', { workspace }),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (event, data) => callback(data)),
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (event, data) => callback(data)),
  onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', (event, data) => callback(data)),
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window-maximize'),
  closeWindow: () => ipcRenderer.invoke('window-close'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  openTerminal: (folderPath) => ipcRenderer.invoke('open-terminal', folderPath),
  showItemInFolder: (fullPath) => ipcRenderer.invoke('show-item-in-folder', fullPath),

  // Tool execution via Streaming WS (called by renderer when server sends tool_execute)
  toolExecute: (toolName, args, requestId, workspace, sessionId, needApproval, dangerReason) =>
    ipcRenderer.invoke('tool-execute', { toolName, args, requestId, workspace, sessionId, needApproval, dangerReason }),

  // Local tool execution - direct IPC (for renderer-initiated calls)
  localReadFile: (args) => ipcRenderer.invoke('local-read-file', args),
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
  respondToolApproval: (requestId, approved) =>
    ipcRenderer.invoke('tool-approval-response', { requestId, approved }),

  // Skill sync — renderer triggers, main process downloads & extracts zip
  skillSync: (sessionId, syncUrl, token, workspace) =>
    ipcRenderer.invoke('skill-sync', { sessionId, syncUrl, token, workspace }),
  onSkillSyncComplete: (callback) => {
    ipcRenderer.on('skill-sync-complete', (event, data) => callback(data))
  },
  removeSkillSyncCompleteListener: () => {
    ipcRenderer.removeAllListeners('skill-sync-complete')
  },

  // Local skills in ~/.agents/skills
  listLocalSkills: () => ipcRenderer.invoke('list-local-skills'),
  getLocalSkillDetail: (folderName) => ipcRenderer.invoke('get-local-skill-detail', { folderName }),
  readLocalSkillFiles: (folderName) => ipcRenderer.invoke('read-local-skill-files', { folderName }),

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
  }
})
