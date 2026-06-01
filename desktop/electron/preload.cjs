const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Original APIs
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (event, data) => callback(data)),
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (event, data) => callback(data)),
  onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', (event, data) => callback(data)),
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window-maximize'),
  closeWindow: () => ipcRenderer.invoke('window-close'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),

  // Tool execution via Streaming WS (called by renderer when server sends tool_execute)
  toolExecute: (toolName, args, requestId, workspace, sessionId) =>
    ipcRenderer.invoke('tool-execute', { toolName, args, requestId, workspace, sessionId }),

  // Local tool execution - direct IPC (for renderer-initiated calls)
  localExecuteBash: (args) => ipcRenderer.invoke('local-execute-bash', args),
  localReadFile: (args) => ipcRenderer.invoke('local-read-file', args),
  localWriteFile: (args) => ipcRenderer.invoke('local-write-file', args),
  localEditFile: (args) => ipcRenderer.invoke('local-edit-file', args),
  localHttpRequest: (args) => ipcRenderer.invoke('local-http-request', args),

  // Bash approval — renderer UI, main process waits for response
  onBashApprovalRequest: (callback) => {
    ipcRenderer.on('bash-approval-request', (event, data) => callback(data))
  },
  removeBashApprovalRequestListener: () => {
    ipcRenderer.removeAllListeners('bash-approval-request')
  },
  onBashApprovalDismiss: (callback) => {
    ipcRenderer.on('bash-approval-dismiss', (event, data) => callback(data))
  },
  removeBashApprovalDismissListener: () => {
    ipcRenderer.removeAllListeners('bash-approval-dismiss')
  },
  respondBashApproval: (requestId, approved) =>
    ipcRenderer.invoke('bash-approval-response', { requestId, approved }),

  // Skill sync — renderer triggers, main process downloads & extracts zip
  skillSync: (sessionId, syncUrl, token, workspace) =>
    ipcRenderer.invoke('skill-sync', { sessionId, syncUrl, token, workspace }),
  onSkillSyncComplete: (callback) => {
    ipcRenderer.on('skill-sync-complete', (event, data) => callback(data))
  },
  removeSkillSyncCompleteListener: () => {
    ipcRenderer.removeAllListeners('skill-sync-complete')
  }
})
