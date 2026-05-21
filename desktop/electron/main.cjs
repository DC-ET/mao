const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const { join } = require('path')
const { exec } = require('child_process')
const fs = require('fs')
const path = require('path')
const WebSocket = require('ws')

let mainWindow = null
let wsClient = null
let wsReconnectTimer = null
let wsReconnectDelay = 1000
let wsExplicitDisconnect = false
let currentWorkspace = ''
const WS_MAX_RECONNECT_DELAY = 30000

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
    title: 'Agent 工作台',
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

// ========== Local tool execution IPC handlers ==========

ipcMain.handle('local-execute-bash', async (event, { command, timeout = 30, workdir }) => {
  // Show confirmation dialog
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '命令执行确认',
    message: 'Agent 请求执行以下命令：',
    detail: command,
    buttons: ['拒绝', '允许执行'],
    defaultId: 1,
    cancelId: 0
  })

  if (response === 0) {
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

  const wsUrl = `${backendUrl || 'ws://localhost:9080'}/ws/local-tool?sessionId=${sessionId}&token=${token}`
  console.log('Connecting WebSocket to:', wsUrl)
  connectWebSocket(wsUrl, sessionId, token, backendUrl)
})

ipcMain.handle('ws-disconnect', () => {
  wsExplicitDisconnect = true
  clearTimeout(wsReconnectTimer)
  wsReconnectTimer = null
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
  })

  wsClient.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString())

      if (msg.type === 'connected') {
        currentWorkspace = msg.workspace || ''
        console.log('WebSocket connected for session', msg.sessionId, 'workspace:', currentWorkspace)
        sendToRenderer('ws-connection-change', { connected: true, sessionId: msg.sessionId, workspace: currentWorkspace })
        return
      }

      if (msg.type === 'ping') {
        wsClient.send(JSON.stringify({ type: 'pong' }))
        return
      }

      if (msg.type === 'tool_execute') {
        const { requestId, toolName, arguments: args } = msg
        let parsedArgs
        try {
          parsedArgs = typeof args === 'string' ? JSON.parse(args) : args
        } catch {
          parsedArgs = {}
        }

        sendToRenderer('tool-request', { requestId, toolName, arguments: parsedArgs })

        try {
          let result
          switch (toolName) {
            case 'bash':
              result = await handleBashFromWebSocket(parsedArgs)
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

          wsClient.send(JSON.stringify({
            type: 'tool_result',
            requestId,
            result: JSON.stringify(result)
          }))
        } catch (e) {
          wsClient.send(JSON.stringify({
            type: 'tool_error',
            requestId,
            error: e.message
          }))
        }
      }
    } catch (e) {
      console.error('Failed to handle WebSocket message:', e)
    }
  })

  wsClient.on('close', () => {
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

async function handleBashFromWebSocket(args) {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '命令执行确认',
    message: 'Agent 请求执行以下命令：',
    detail: args.command,
    buttons: ['拒绝', '允许执行'],
    defaultId: 1,
    cancelId: 0
  })

  if (response === 0) {
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

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}
