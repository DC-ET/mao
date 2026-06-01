const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const { join } = require('path')
const { exec } = require('child_process')
const fs = require('fs')
const path = require('path')
const WebSocket = require('ws')

let mainWindow = null
let wsClient = null
let wsReconnectTimer = null
let wsPingInterval = null
let wsReconnectDelay = 1000
let wsExplicitDisconnect = false
let currentWorkspace = ''
const WS_MAX_RECONNECT_DELAY = 30000
const WS_PING_INTERVAL_MS = 10000
/** @type {Map<string, (approved: boolean) => void>} */
const pendingBashApprovals = new Map()

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}

function requestBashApproval(command) {
  return new Promise((resolve) => {
    const requestId = `bash_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`

    pendingBashApprovals.set(requestId, (approved) => {
      pendingBashApprovals.delete(requestId)
      resolve(approved)
    })

    sendToRenderer('bash-approval-request', { requestId, command })
  })
}

ipcMain.handle('bash-approval-response', (event, { requestId, approved }) => {
  const resolve = pendingBashApprovals.get(requestId)
  if (resolve) {
    pendingBashApprovals.delete(requestId)
    resolve(!!approved)
  }
})

function getApiBaseUrl() {
  // Derive API base URL from the WebSocket URL or default to localhost
  return 'http://localhost:9080/api'
}

// ========== Skill sync IPC handler ==========

ipcMain.handle('skill-sync', async (event, { sessionId, syncUrl, token }) => {
  console.log('[skill-sync] IPC handler called:', { sessionId, syncUrl })
  try {
    const AdmZip = require('adm-zip')
    const skillsDir = path.join(currentWorkspace, '.workbench', 'skills')

    // Download zip from REST endpoint
    const baseUrl = getApiBaseUrl()
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {}
    const response = await fetch(`${baseUrl}${syncUrl}`, { method: 'POST', headers })
    if (!response.ok) {
      throw new Error(`Skill sync download failed: ${response.status}`)
    }

    // Extract zip to .workbench/skills/
    const zipBuffer = Buffer.from(await response.arrayBuffer())
    fs.mkdirSync(skillsDir, { recursive: true })
    const zip = new AdmZip(zipBuffer)
    zip.extractAllTo(skillsDir, true)

    console.log('Skills synced to', skillsDir)
    sendToRenderer('skill-sync-complete', { sessionId, success: true })
    return { success: true }
  } catch (e) {
    console.error('Skill sync failed:', e)
    sendToRenderer('skill-sync-complete', { sessionId, success: false, error: e.message })
    return { success: false, error: e.message }
  }
})

function resolveWorkspacePath(filePath) {
  if (!filePath || !currentWorkspace) return filePath
  if (path.isAbsolute(filePath)) return filePath
  return path.join(currentWorkspace, filePath)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Agent Workbench',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 12 },
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5201')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// ========== Window control IPC handlers ==========

ipcMain.handle('window-minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.minimize()
  }
})

ipcMain.handle('window-maximize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  }
})

ipcMain.handle('window-close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close()
  }
})

// ========== Original IPC handlers ==========

ipcMain.handle('get-app-version', () => {
  return app.getVersion()
})

ipcMain.handle('get-platform', () => {
  return process.platform
})

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择工作目录'
  })
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]
})

ipcMain.handle('open-folder', (event, folderPath) => {
  if (folderPath) shell.openPath(folderPath)
})

// ========== Local tool execution IPC handlers ==========

ipcMain.handle('local-execute-bash', async (event, { command, timeout = 30, workdir }) => {
  const approved = await requestBashApproval(command)
  if (!approved) {
    return { exit_code: -1, output: 'User denied command execution.' }
  }

  return new Promise((resolve) => {
    const options = {
      timeout: timeout * 1000,
      maxBuffer: 1024 * 1024 * 5 // 5MB
    }
    const resolvedWorkdir = workdir || currentWorkspace
    if (resolvedWorkdir) {
      options.cwd = resolvedWorkdir
    }

    exec(command, options, (error, stdout, stderr) => {
      if (error && error.killed) {
        resolve({ exit_code: -1, output: `Command timed out after ${timeout}s` })
      } else {
        resolve({
          exit_code: error ? error.code || 1 : 0,
          output: (stdout || '') + (stderr ? '\n' + stderr : '')
        })
      }
    })
  })
})

ipcMain.handle('local-read-file', async (event, { path: filePath, offset, limit }) => {
  try {
    const resolvedPath = resolveWorkspacePath(filePath)
    const content = fs.readFileSync(resolvedPath, 'utf-8')
    const lines = content.split('\n')
    const totalLines = lines.length
    const start = offset || 0
    const end = limit ? Math.min(start + limit, totalLines) : totalLines
    const sliced = lines.slice(start, end).join('\n')
    return { content: sliced, total_lines: totalLines }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('local-write-file', async (event, { path: filePath, content }) => {
  try {
    const resolvedPath = resolveWorkspacePath(filePath)
    const dir = path.dirname(resolvedPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(resolvedPath, content, 'utf-8')
    return { success: true, bytes_written: Buffer.byteLength(content, 'utf-8') }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('local-edit-file', async (event, { path: filePath, old_string, new_string }) => {
  try {
    const resolvedPath = resolveWorkspacePath(filePath)
    const content = fs.readFileSync(resolvedPath, 'utf-8')
    const count = content.split(old_string).length - 1
    if (count === 0) {
      return { success: false, error: 'old_string not found in file' }
    }
    const updated = content.replaceAll(old_string, new_string)
    fs.writeFileSync(resolvedPath, updated, 'utf-8')
    return { success: true, replacements: count }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('local-http-request', async (event, { url, method = 'GET', headers, body }) => {
  try {
    const options = { method, headers: headers || {} }
    if (body) options.body = body
    const resp = await fetch(url, options)
    const text = await resp.text()
    return { status: resp.status, body: text }
  } catch (e) {
    return { error: e.message }
  }
})

// ========== WebSocket client for local tool session ==========

ipcMain.handle('ws-connect', (event, { sessionId, token, backendUrl }) => {
  console.log('ws-connect called:', { sessionId, backendUrl })
  wsExplicitDisconnect = false
  if (wsClient) {
    wsClient.close()
    wsClient = null
  }
  clearTimeout(wsReconnectTimer)
  clearInterval(wsPingInterval)
  wsPingInterval = null

  const wsUrl = `${backendUrl || 'ws://localhost:9080'}/ws/local-tool?sessionId=${sessionId}&token=${token}`
  console.log('Connecting WebSocket to:', wsUrl)
  connectWebSocket(wsUrl, sessionId, token, backendUrl)
})

ipcMain.handle('ws-disconnect', () => {
  wsExplicitDisconnect = true
  clearTimeout(wsReconnectTimer)
  wsReconnectTimer = null
  clearInterval(wsPingInterval)
  wsPingInterval = null
  if (wsClient) {
    wsClient.close()
    wsClient = null
  }
  sendToRenderer('ws-connection-change', { connected: false })
})

function connectWebSocket(wsUrl, sessionId, token, backendUrl) {
  console.log('connectWebSocket: creating connection to', wsUrl)
  wsClient = new WebSocket(wsUrl)

  wsClient.on('open', () => {
    console.log('WebSocket open for session', sessionId)
    wsReconnectDelay = 1000 // Reset backoff
    sendToRenderer('ws-connection-change', { connected: true, sessionId })

    // Start heartbeat: send ping every 10s (server idle timeout is 90s)
    clearInterval(wsPingInterval)
    wsPingInterval = setInterval(() => {
      if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({ type: 'ping' }))
      }
    }, WS_PING_INTERVAL_MS)
  })

  wsClient.on('message', (data) => {
    let msg
    try {
      msg = JSON.parse(data.toString())
    } catch (e) {
      console.error('Failed to parse WS message:', e)
      return
    }

    if (msg.type === 'connected') {
      currentWorkspace = msg.workspace || ''
      console.log('WebSocket connected for session', msg.sessionId, 'workspace:', currentWorkspace)
      sendToRenderer('ws-connection-change', { connected: true, sessionId: msg.sessionId, workspace: currentWorkspace })
      return
    }

    if (msg.type === 'pong') {
      return
    }

    if (msg.type === 'tool_execute') {
      const { requestId, toolName, arguments: args, workspace: ws } = msg
      if (ws) currentWorkspace = ws
      let parsedArgs
      try {
        parsedArgs = typeof args === 'string' ? JSON.parse(args) : args
      } catch {
        parsedArgs = {}
      }

      // Fire-and-forget: run tool in independent async context so the message
      // handler returns immediately and can process the next incoming message.
      // Without this, a pending bash approval blocks all subsequent tool calls.
      handleToolExecute(toolName, parsedArgs, requestId)
    }
  })

  wsClient.on('close', () => {
    clearInterval(wsPingInterval)
    wsPingInterval = null
    sendToRenderer('ws-connection-change', { connected: false })
    wsClient = null

    // Auto-reconnect with exponential backoff
    if (wsExplicitDisconnect) return
    wsReconnectTimer = setTimeout(() => {
      wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_MAX_RECONNECT_DELAY)
      connectWebSocket(wsUrl, sessionId, token, backendUrl)
    }, wsReconnectDelay)
  })

  wsClient.on('error', (err) => {
    console.error('WebSocket error:', err.message)
    sendToRenderer('ws-connection-change', { connected: false, error: err.message })
  })
}

async function handleToolExecute(toolName, parsedArgs, requestId) {
  try {
    let result
    switch (toolName) {
      case 'bash':
        result = await handleBashFromWebSocket(parsedArgs)
        break
      case 'shell':
        result = await handleShellFromWebSocket(parsedArgs)
        break
      case 'read_file':
        result = await handleLocalReadFile(parsedArgs)
        break
      case 'write_file':
        result = await handleLocalWriteFile(parsedArgs)
        break
      case 'edit_file':
        result = await handleLocalEditFile(parsedArgs)
        break
      case 'http_request':
        result = await handleLocalHttpRequest(parsedArgs)
        break
      default:
        result = { error: `Unknown tool: ${toolName}` }
    }

    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.send(JSON.stringify({
        type: 'tool_result',
        requestId,
        result: JSON.stringify(result)
      }))
    }
  } catch (e) {
    console.error(`Tool ${toolName} execution failed:`, e)
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.send(JSON.stringify({
        type: 'tool_error',
        requestId,
        error: e.message
      }))
    }
  }
}

async function handleBashFromWebSocket(args) {
  const approved = await requestBashApproval(args.command)
  if (!approved) {
    return { exit_code: -1, output: 'User denied command execution.' }
  }

  return new Promise((resolve) => {
    const options = {
      timeout: (args.timeout || 30) * 1000,
      maxBuffer: 1024 * 1024 * 5
    }
    const resolvedWorkdir = args.workdir || currentWorkspace
    if (resolvedWorkdir) options.cwd = resolvedWorkdir

    exec(args.command, options, (error, stdout, stderr) => {
      if (error && error.killed) {
        resolve({ exit_code: -1, output: `Command timed out after ${args.timeout || 30}s` })
      } else {
        resolve({
          exit_code: error ? error.code || 1 : 0,
          output: (stdout || '') + (stderr ? '\n' + stderr : '')
        })
      }
    })
  })
}

async function handleShellFromWebSocket(args) {
  const { action, command, session_id, workdir } = args

  if (action === 'close' || action === 'list') {
    return { session_id, status: action === 'close' ? 'closed' : 'listed', sessions: [] }
  }

  if (action === 'write_stdin') {
    return { error: 'write_stdin is not supported in local mode without session persistence' }
  }

  if (action !== 'exec') {
    return { error: `Unknown action: ${action}` }
  }

  const approved = await requestBashApproval(command)
  if (!approved) {
    return { exit_code: -1, output: 'User denied command execution.' }
  }

  return new Promise((resolve) => {
    const options = {
      timeout: (args.timeout || 30) * 1000,
      maxBuffer: 1024 * 1024 * 5
    }
    const resolvedWorkdir = workdir || currentWorkspace
    if (resolvedWorkdir) options.cwd = resolvedWorkdir

    exec(command, options, (error, stdout, stderr) => {
      if (error && error.killed) {
        resolve({ exit_code: -1, output: `Command timed out after ${args.timeout || 30}s` })
      } else {
        resolve({
          exit_code: error ? error.code || 1 : 0,
          session_id: session_id || 'local',
          current_workdir: resolvedWorkdir || '',
          output: (stdout || '') + (stderr ? '\n' + stderr : '')
        })
      }
    })
  })
}

async function handleLocalReadFile(args) {
  try {
    const resolvedPath = resolveWorkspacePath(args.path)
    const content = fs.readFileSync(resolvedPath, 'utf-8')
    const lines = content.split('\n')
    const start = args.offset || 0
    const end = args.limit ? Math.min(start + args.limit, lines.length) : lines.length
    return { content: lines.slice(start, end).join('\n'), total_lines: lines.length }
  } catch (e) {
    return { error: e.message }
  }
}

async function handleLocalWriteFile(args) {
  try {
    const resolvedPath = resolveWorkspacePath(args.path)
    const dir = path.dirname(resolvedPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(resolvedPath, args.content, 'utf-8')
    return { success: true, bytes_written: Buffer.byteLength(args.content, 'utf-8') }
  } catch (e) {
    return { error: e.message }
  }
}

async function handleLocalEditFile(args) {
  try {
    const resolvedPath = resolveWorkspacePath(args.path)
    const content = fs.readFileSync(resolvedPath, 'utf-8')
    const count = content.split(args.old_string).length - 1
    if (count === 0) return { success: false, error: 'old_string not found in file' }
    fs.writeFileSync(resolvedPath, content.replaceAll(args.old_string, args.new_string), 'utf-8')
    return { success: true, replacements: count }
  } catch (e) {
    return { error: e.message }
  }
}

async function handleLocalHttpRequest(args) {
  try {
    const options = { method: args.method || 'GET', headers: args.headers || {} }
    if (args.body) options.body = args.body
    const resp = await fetch(args.url, options)
    return { status: resp.status, body: await resp.text() }
  } catch (e) {
    return { error: e.message }
  }
}
