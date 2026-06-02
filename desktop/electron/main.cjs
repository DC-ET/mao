const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const { join } = require('path')
const { exec, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

let mainWindow = null
let currentWorkspace = ''
/** @type {Map<string, (approved: boolean) => void>} */
const pendingBashApprovals = new Map()
/** @type {Map<string, {process: import('child_process').ChildProcess, cwd: string}>} */
const shellSessions = new Map()

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}

function requestBashApproval(command, sessionId) {
  return new Promise((resolve) => {
    const requestId = `bash_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`

    pendingBashApprovals.set(requestId, (approved) => {
      pendingBashApprovals.delete(requestId)
      resolve(approved)
    })

    sendToRenderer('bash-approval-request', { requestId, command, sessionId })
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

ipcMain.handle('skill-sync', async (event, { sessionId, syncUrl, token, workspace }) => {
  // Use workspace parameter if provided, otherwise fall back to currentWorkspace
  const effectiveWorkspace = workspace || currentWorkspace
  console.log('[skill-sync] IPC handler called:', { sessionId, syncUrl, workspace, currentWorkspace, effectiveWorkspace })
  if (!effectiveWorkspace) {
    const err = 'No workspace configured. Please set a workspace for this session.'
    console.error('[skill-sync]', err)
    sendToRenderer('skill-sync-complete', { sessionId, success: false, error: err })
    return { success: false, error: err }
  }
  try {
    const AdmZip = require('adm-zip')
    const skillsDir = path.join(effectiveWorkspace, '.workbench', 'skills')
    console.log('[skill-sync] resolved skillsDir:', skillsDir, 'isAbsolute:', path.isAbsolute(skillsDir))

    // Download zip from REST endpoint
    const baseUrl = getApiBaseUrl()
    const fullUrl = `${baseUrl}${syncUrl}`
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {}
    console.log('[skill-sync] downloading from:', fullUrl)
    const response = await fetch(fullUrl, { method: 'POST', headers })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`Skill sync download failed: ${response.status} ${response.statusText} - ${body}`)
    }

    // Extract zip to .workbench/skills/
    const zipBuffer = Buffer.from(await response.arrayBuffer())
    console.log('[skill-sync] downloaded zip size:', zipBuffer.length, 'bytes')
    fs.mkdirSync(skillsDir, { recursive: true })
    const zip = new AdmZip(zipBuffer)
    const entries = zip.getEntries()
    console.log('[skill-sync] zip entries:', entries.map(e => e.entryName))
    zip.extractAllTo(skillsDir, true)
    console.log('[skill-sync] extracted to:', skillsDir, 'abs:', path.resolve(skillsDir))
    sendToRenderer('skill-sync-complete', { sessionId, success: true })
    return { success: true }
  } catch (e) {
    console.error('Skill sync failed:', e)
    sendToRenderer('skill-sync-complete', { sessionId, success: false, error: e.message })
    return { success: false, error: e.message }
  }
})

function resolveWorkspacePath(filePath, workspace) {
  const effectiveWorkspace = workspace || currentWorkspace
  if (!filePath || !effectiveWorkspace) return filePath
  if (path.isAbsolute(filePath)) return filePath
  return path.join(effectiveWorkspace, filePath)
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

ipcMain.handle('open-terminal', (event, folderPath) => {
  if (!folderPath) return
  spawn('open', ['-a', 'Terminal', folderPath], { detached: true, stdio: 'ignore' }).unref()
})

// ========== Local tool execution IPC handlers ==========

ipcMain.handle('local-execute-bash', async (event, { command, timeout = 30, workdir, workspace }) => {
  const approved = await requestBashApproval(command)
  if (!approved) {
    return { exit_code: -1, output: 'User denied command execution.' }
  }

  return new Promise((resolve) => {
    const options = {
      timeout: timeout * 1000,
      maxBuffer: 1024 * 1024 * 5 // 5MB
    }
    // Use workspace parameter if provided, otherwise fall back to currentWorkspace
    const resolvedWorkdir = workdir || workspace || currentWorkspace
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

// ========== Tool execution via Streaming WS ==========

async function executeToolByName(toolName, parsedArgs, sessionId, workspace) {
  switch (toolName) {
    case 'bash':
      return await handleBashFromWebSocket(parsedArgs, sessionId, workspace)
    case 'shell':
      return await handleShellFromWebSocket(parsedArgs, sessionId, workspace)
    case 'read_file':
      return await handleLocalReadFile(parsedArgs, workspace)
    case 'write_file':
      return await handleLocalWriteFile(parsedArgs, workspace)
    case 'edit_file':
      return await handleLocalEditFile(parsedArgs, workspace)
    case 'http_request':
      return await handleLocalHttpRequest(parsedArgs)
    default:
      return { error: `Unknown tool: ${toolName}` }
  }
}

ipcMain.handle('tool-execute', async (event, { toolName, args, requestId, workspace, sessionId }) => {
  // Use the workspace from this specific tool call, falling back to currentWorkspace
  const effectiveWorkspace = workspace || currentWorkspace
  console.log('[tool-execute] received workspace:', workspace, ', effectiveWorkspace:', effectiveWorkspace, ', currentWorkspace before:', currentWorkspace)
  if (workspace) {
    console.log('[tool-execute] setting currentWorkspace:', workspace, '(was:', currentWorkspace, ')')
    currentWorkspace = workspace
  }

  let parsedArgs
  try {
    parsedArgs = typeof args === 'string' ? JSON.parse(args) : args
  } catch {
    parsedArgs = {}
  }

  try {
    const result = await executeToolByName(toolName, parsedArgs, sessionId, effectiveWorkspace)
    return { requestId, result: JSON.stringify(result), error: null }
  } catch (e) {
    console.error(`Tool ${toolName} execution failed:`, e)
    return { requestId, result: null, error: e.message }
  }
})

async function handleBashFromWebSocket(args, sessionId, workspace) {
  console.log('[handleBash] received workspace:', workspace, ', args.workdir:', args.workdir)
  const approved = await requestBashApproval(args.command, sessionId)
  if (!approved) {
    return { exit_code: -1, output: 'User denied command execution.' }
  }

  return new Promise((resolve) => {
    const options = {
      timeout: (args.timeout || 30) * 1000,
      maxBuffer: 1024 * 1024 * 5
    }
    // Resolve working directory: use workspace as base, apply workdir if provided
    let resolvedWorkdir = workspace
    if (args.workdir && args.workdir !== '.') {
      // If workdir is absolute, use it directly; otherwise resolve relative to workspace
      resolvedWorkdir = path.isAbsolute(args.workdir) ? args.workdir : path.join(workspace || process.cwd(), args.workdir)
    }
    console.log('[handleBash] resolvedWorkdir:', resolvedWorkdir)
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

async function handleShellFromWebSocket(args, sessionId, workspace) {
  const { action, command, session_id, workdir, input } = args
  // Resolve working directory: use workspace as base, apply workdir if provided
  let resolvedWorkdir = workspace
  if (workdir && workdir !== '.') {
    resolvedWorkdir = path.isAbsolute(workdir) ? workdir : path.join(workspace || process.cwd(), workdir)
  }

  if (action === 'close') {
    const session = shellSessions.get(session_id)
    if (session) {
      session.process.kill()
      shellSessions.delete(session_id)
    }
    return { session_id, status: 'closed' }
  }

  if (action === 'list') {
    const sessions = Array.from(shellSessions.entries()).map(([id, s]) => ({
      session_id: id,
      current_workdir: s.cwd,
      command_count: 0
    }))
    return { sessions, count: sessions.length }
  }

  if (action === 'write_stdin') {
    const session = shellSessions.get(session_id)
    if (!session) {
      return { error: `Session not found: ${session_id}` }
    }
    return new Promise((resolve) => {
      let output = ''
      const onData = (data) => { output += data.toString() }
      session.process.stdout.on('data', onData)
      session.process.stdin.write(input)
      setTimeout(() => {
        session.process.stdout.removeListener('data', onData)
        resolve({
          session_id,
          current_workdir: session.cwd,
          output: output.trim(),
          truncated: false
        })
      }, args.yield_time_ms || 5000)
    })
  }

  if (action !== 'exec') {
    return { error: `Unknown action: ${action}` }
  }

  // 复用已有会话
  if (session_id && shellSessions.has(session_id)) {
    const session = shellSessions.get(session_id)
    return new Promise((resolve) => {
      let output = ''
      const onData = (data) => { output += data.toString() }
      session.process.stdout.on('data', onData)
      session.process.stdin.write(command + '\n')
      setTimeout(() => {
        session.process.stdout.removeListener('data', onData)
        resolve({
          exit_code: 0,
          session_id,
          current_workdir: session.cwd,
          output: output.trim(),
          truncated: false
        })
      }, args.yield_time_ms || 10000)
    })
  }

  const approved = await requestBashApproval(command, sessionId)
  if (!approved) {
    return { exit_code: -1, output: 'User denied command execution.' }
  }

  // 创建持久化会话
  if (session_id) {
    const bashProcess = spawn('bash', ['--norc', '--noprofile'], {
      cwd: resolvedWorkdir || undefined,
      env: { ...process.env, TERM: 'dumb', PS1: '' }
    })
    shellSessions.set(session_id, { process: bashProcess, cwd: resolvedWorkdir || '' })

    return new Promise((resolve) => {
      let output = ''
      const onData = (data) => { output += data.toString() }
      bashProcess.stdout.on('data', onData)
      bashProcess.stderr.on('data', onData)
      bashProcess.stdin.write(command + '\n')
      setTimeout(() => {
        bashProcess.stdout.removeListener('data', onData)
        bashProcess.stderr.removeListener('data', onData)
        resolve({
          exit_code: 0,
          session_id,
          current_workdir: resolvedWorkdir || '',
          output: output.trim(),
          truncated: false
        })
      }, args.yield_time_ms || 10000)
    })
  }

  // 无 session_id，一次性执行
  return new Promise((resolve) => {
    const options = {
      timeout: (args.timeout || 30) * 1000,
      maxBuffer: 1024 * 1024 * 5
    }
    if (resolvedWorkdir) options.cwd = resolvedWorkdir

    exec(command, options, (error, stdout, stderr) => {
      if (error && error.killed) {
        resolve({ exit_code: -1, output: `Command timed out after ${args.timeout || 30}s` })
      } else {
        resolve({
          exit_code: error ? error.code || 1 : 0,
          session_id: 'local',
          current_workdir: resolvedWorkdir || '',
          output: (stdout || '') + (stderr ? '\n' + stderr : '')
        })
      }
    })
  })
}

async function handleLocalReadFile(args, workspace) {
  try {
    const resolvedPath = resolveWorkspacePath(args.path, workspace)
    const content = fs.readFileSync(resolvedPath, 'utf-8')
    const lines = content.split('\n')
    const start = args.offset || 0
    const end = args.limit ? Math.min(start + args.limit, lines.length) : lines.length
    return { content: lines.slice(start, end).join('\n'), total_lines: lines.length }
  } catch (e) {
    return { error: e.message }
  }
}

async function handleLocalWriteFile(args, workspace) {
  try {
    const resolvedPath = resolveWorkspacePath(args.path, workspace)
    const dir = path.dirname(resolvedPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(resolvedPath, args.content, 'utf-8')
    return { success: true, bytes_written: Buffer.byteLength(args.content, 'utf-8') }
  } catch (e) {
    return { error: e.message }
  }
}

async function handleLocalEditFile(args, workspace) {
  try {
    const resolvedPath = resolveWorkspacePath(args.path, workspace)
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
