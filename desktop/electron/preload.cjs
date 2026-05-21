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

  // Local tool execution - WebSocket connection
  connectLocalSession: (sessionId, token, backendUrl) =>
    ipcRenderer.invoke('ws-connect', { sessionId, token, backendUrl }),
  disconnectLocalSession: () => ipcRenderer.invoke('ws-disconnect'),
  onWsConnectionChange: (callback) => {
    ipcRenderer.on('ws-connection-change', (event, data) => callback(data))
  },
  removeWsConnectionChangeListener: () => {
    ipcRenderer.removeAllListeners('ws-connection-change')
  },

  // Local tool execution - direct IPC (for renderer-initiated calls)
  localExecuteBash: (args) => ipcRenderer.invoke('local-execute-bash', args),
  localReadFile: (args) => ipcRenderer.invoke('local-read-file', args),
  localWriteFile: (args) => ipcRenderer.invoke('local-write-file', args),
  localEditFile: (args) => ipcRenderer.invoke('local-edit-file', args),
  localHttpRequest: (args) => ipcRenderer.invoke('local-http-request', args),

  // Tool request notifications from WebSocket
  onToolRequest: (callback) => {
    ipcRenderer.on('tool-request', (event, data) => callback(data))
  },
  removeToolRequestListener: () => {
    ipcRenderer.removeAllListeners('tool-request')
  }
})
