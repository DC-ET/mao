const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const { join } = require('path')
const { exec, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { TerminalManager } = require('./terminalManager.cjs')


let mainWindow = null
let currentWorkspace = ''
/** @type {Map<string, (approved: boolean) => void>} */
const pendingApprovals = new Map()
/** @type {Map<string, {process: import('child_process').ChildProcess, cwd: string}>} */
const shellSessions = new Map()
const terminalManager = new TerminalManager()
terminalManager.setEnvProvider(buildShellEnv)

/**
 * Get the full user PATH by executing a login shell.
 * macOS GUI apps don't load shell configs, so we need to manually resolve the PATH
 * that includes all user-configured tools (nvm, brew, cargo, etc.)
 */
let cachedUserPath = null
async function resolveUserPath() {
  if (cachedUserPath) return cachedUserPath

  const shell = process.env.SHELL || '/bin/zsh'
  console.log('[env] Resolving user PATH, SHELL:', process.env.SHELL, 'Using shell:', shell)
  console.log('[env] Current PATH:', process.env.PATH)

  return new Promise((resolve) => {
    // Use login shell to get full user environment
    const cmd = `${shell} -l -c 'echo $PATH'`
    console.log('[env] Executing:', cmd)

    exec(cmd, {
      timeout: 10000,
      env: { ...process.env, TERM: 'dumb' } // Ensure basic env
    }, (error, stdout, stderr) => {
      if (error) {
        console.error('[env] Failed to resolve user PATH via login shell:', error.message)
        if (stderr) console.error('[env] stderr:', stderr)
        resolve(process.env.PATH)
      } else {
        const userPath = stdout.trim()
        if (userPath && userPath !== process.env.PATH) {
          cachedUserPath = userPath
          console.log('[env] Resolved user PATH via login shell:', userPath.substring(0, 100) + '...')
          resolve(userPath)
        } else {
          console.log('[env] Login shell PATH same as current, using current PATH')
          resolve(process.env.PATH)
        }
      }
    })
  })
}

/**
 * Build environment with user's full PATH
 */
async function buildShellEnv() {
  const userPath = await resolveUserPath()
  return {
    ...process.env,
    PATH: userPath,
    TERM: 'dumb',
    PS1: ''
  }
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}

function requestToolApproval(toolName, description, sessionId, dangerReason) {
  return new Promise((resolve) => {
    const requestId = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`

    pendingApprovals.set(requestId, (approved) => {
      pendingApprovals.delete(requestId)
      resolve(approved)
    })

    const payload = { requestId, toolName, description, sessionId }
    if (dangerReason) payload.dangerReason = dangerReason
    sendToRenderer('tool-approval-request', payload)
  })
}

ipcMain.handle('tool-approval-response', (event, { requestId, approved }) => {
  const resolve = pendingApprovals.get(requestId)
  if (resolve) {
    pendingApprovals.delete(requestId)
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
  if (!effectiveWorkspace) {
    const err = 'No workspace configured. Please set a workspace for this session.'
    sendToRenderer('skill-sync-complete', { sessionId, success: false, error: err })
    return { success: false, error: err }
  }
  try {
    const AdmZip = require('adm-zip')
    const skillsDir = path.join(effectiveWorkspace, '.workbench', 'skills')

    // Download zip from REST endpoint
    const baseUrl = getApiBaseUrl()
    const fullUrl = `${baseUrl}${syncUrl}`
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {}
    const response = await fetch(fullUrl, { method: 'POST', headers })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`Skill sync download failed: ${response.status} ${response.statusText} - ${body}`)
    }

    // Extract zip to .workbench/skills/
    const zipBuffer = Buffer.from(await response.arrayBuffer())
    fs.mkdirSync(skillsDir, { recursive: true })
    const zip = new AdmZip(zipBuffer)
    const entries = zip.getEntries()
    zip.extractAllTo(skillsDir, true)
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

function detectShell() {
  return process.env.SHELL || process.env.ComSpec || process.env.COMSPEC || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh')
}

function buildOsVersion() {
  if (process.platform === 'win32') {
    return `${os.version()} ${os.release()}`
  }
  return `${os.type()} ${os.release()}`
}

function isGitWorkspace(workspace) {
  if (!workspace) return false
  let current = path.resolve(workspace)
  while (current && current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return true
    }
    current = path.dirname(current)
  }
  return false
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Mao',
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

app.on('before-quit', () => {
  terminalManager.killAll()
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

ipcMain.handle('get-environment-info', (event, { workspace } = {}) => {
  return {
    isGit: isGitWorkspace(workspace || currentWorkspace),
    platform: process.platform,
    shell: detectShell(),
    osVersion: buildOsVersion()
  }
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

ipcMain.handle('show-item-in-folder', (event, fullPath) => {
  if (fullPath) shell.showItemInFolder(fullPath)
})

ipcMain.handle('open-terminal', (event, folderPath) => {
  if (!folderPath) return
  spawn('open', ['-a', 'Terminal', folderPath], { detached: true, stdio: 'ignore' }).unref()
})

// ========== Terminal IPC handlers (node-pty) ==========

ipcMain.handle('terminal:create', async (event, options) => {
  const result = await terminalManager.create(options)
  const session = terminalManager.sessions.get(result.id)

  session.pty.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:data', { id: result.id, data })
    }
  })

  session.pty.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:exit', { id: result.id, exitCode })
    }
    terminalManager.sessions.delete(result.id)
  })

  return result
})

ipcMain.on('terminal:data', (event, { id, data }) => {
  terminalManager.write(id, data)
})

ipcMain.on('terminal:resize', (event, { id, cols, rows }) => {
  terminalManager.resize(id, cols, rows)
})

ipcMain.handle('terminal:kill', (event, { id }) => {
  terminalManager.kill(id)
})

ipcMain.handle('terminal:list', () => {
  return terminalManager.list()
})

// ========== Local tool execution IPC handlers ==========

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
  const approved = await requestToolApproval('write_file', filePath)
  if (!approved) {
    return { success: false, error: 'User denied file write.' }
  }
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
  const approved = await requestToolApproval('edit_file', filePath)
  if (!approved) {
    return { success: false, error: 'User denied file edit.' }
  }
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

const IGNORED_DIRS = new Set(['node_modules', '__pycache__', '.git', 'target', 'dist', 'build', '.next', '.nuxt', '.venv', 'venv', '.idea', '.vscode'])

ipcMain.handle('list-workspace-files', async (event, { workspace, filter, limit }) => {
  try {
    if (!workspace || !fs.existsSync(workspace)) return []
    const maxResults = limit || 20
    const results = []

    function walkDir(dir, relativeBase) {
      if (results.length >= maxResults) return
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      // Sort entries: files first, then dirs, alphabetically
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? 1 : -1
        return a.name.localeCompare(b.name)
      })
      for (const entry of entries) {
        if (results.length >= maxResults) return
        if (entry.name.startsWith('.')) continue
        if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue
        const fullPath = path.join(dir, entry.name)
        const relPath = relativeBase ? relativeBase + '/' + entry.name : entry.name
        if (entry.isDirectory()) {
          walkDir(fullPath, relPath)
        } else {
          try {
            const stat = fs.statSync(fullPath)
            if (!filter || entry.name.toLowerCase().includes(filter.toLowerCase()) || relPath.toLowerCase().includes(filter.toLowerCase())) {
              results.push({ path: relPath, name: entry.name, size: stat.size, mtime: stat.mtimeMs })
            }
          } catch {
            // skip files we can't stat
          }
        }
      }
    }

    walkDir(workspace, '')
    // Sort by modification time descending
    results.sort((a, b) => b.mtime - a.mtime)
    // Remove mtime from response
    return results.map(({ mtime, ...rest }) => rest)
  } catch (e) {
    return []
  }
})

ipcMain.handle('list-directory', async (event, { dirPath, workspace }) => {
  try {
    if (!dirPath || !workspace) return { error: 'Missing dirPath or workspace' }
    const resolvedDir = path.resolve(dirPath)
    const resolvedWorkspace = path.resolve(workspace)
    if (!resolvedDir.startsWith(resolvedWorkspace + path.sep) && resolvedDir !== resolvedWorkspace) {
      return { error: 'Access denied: path outside workspace' }
    }
    if (!fs.existsSync(resolvedDir)) return { error: 'Directory does not exist' }

    const entries = fs.readdirSync(resolvedDir, { withFileTypes: true })
    const results = []
    const MAX_ENTRIES = 500

    for (const entry of entries) {
      if (results.length >= MAX_ENTRIES) break
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue

      const fullPath = path.join(resolvedDir, entry.name)
      const relPath = path.relative(resolvedWorkspace, fullPath)
      let isSymlink = false
      let size = 0
      let mtime = 0

      try {
        const lstat = fs.lstatSync(fullPath)
        isSymlink = lstat.isSymbolicLink()
        size = lstat.size
        mtime = lstat.mtimeMs
      } catch {
        // skip entries we can't stat
        continue
      }

      results.push({
        name: entry.name,
        path: relPath,
        isDirectory: entry.isDirectory() && !isSymlink,
        size,
        mtime,
        isSymlink
      })
    }

    // Sort: folders first alphabetically, then files alphabetically
    results.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    return { entries: results, truncated: entries.length > MAX_ENTRIES }
  } catch (e) {
    return { error: e.message }
  }
})

// ========== Tool execution via Streaming WS ==========

async function executeToolByName(toolName, parsedArgs, sessionId, workspace, needApproval, dangerReason) {
  switch (toolName) {
    case 'shell':
      return await handleShellFromWebSocket(parsedArgs, sessionId, workspace, needApproval, dangerReason)
    case 'read_file':
      return await handleLocalReadFile(parsedArgs, workspace)
    case 'write_file':
      return await handleLocalWriteFile(parsedArgs, workspace, sessionId, needApproval)
    case 'edit_file':
      return await handleLocalEditFile(parsedArgs, workspace, sessionId, needApproval)
    case 'glob_search':
      return await handleLocalGlobSearch(parsedArgs, workspace)
    case 'grep_search':
      return await handleLocalGrepSearch(parsedArgs, workspace)
    default:
      return { error: `Unknown tool: ${toolName}` }
  }
}

ipcMain.handle('tool-execute', async (event, { toolName, args, requestId, workspace, sessionId, needApproval, dangerReason }) => {
  // Use the workspace from this specific tool call, falling back to currentWorkspace
  const effectiveWorkspace = workspace || currentWorkspace
  console.log('[tool-execute] received workspace:', workspace, ', effectiveWorkspace:', effectiveWorkspace, ', currentWorkspace before:', currentWorkspace, ', needApproval:', needApproval, ', dangerReason:', dangerReason)
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
    const result = await executeToolByName(toolName, parsedArgs, sessionId, effectiveWorkspace, !!needApproval, dangerReason)
    return { requestId, result: JSON.stringify(result), error: null }
  } catch (e) {
    console.error(`Tool ${toolName} execution failed:`, e)
    return { requestId, result: null, error: e.message }
  }
})

const crypto = require('crypto')
const MARKER_PREFIX = '__CMD_DONE_'
const MARKER_SUFFIX = '__'
const MAX_PREVIEW_LINES = 100
const MAX_PREVIEW_CHARS = 10000
const SHELL_OUTPUT_DIR = '.workbench/shellOutput'

function generateMarker() {
  return crypto.randomBytes(4).toString('hex')
}

/**
 * 截断输出并落盘，返回预览 + 截断标记 + 文件路径
 */
function truncateAndSave(fullOutput, workspace, sessionId) {
  const lines = fullOutput.split('\n')
  const truncated = lines.length > MAX_PREVIEW_LINES || fullOutput.length > MAX_PREVIEW_CHARS

  // 生成预览：取尾部 MAX_PREVIEW_LINES 行
  const startIdx = Math.max(0, lines.length - MAX_PREVIEW_LINES)
  let preview = lines.slice(startIdx).join('\n')
  if (preview.length > MAX_PREVIEW_CHARS) {
    preview = preview.substring(preview.length - MAX_PREVIEW_CHARS)
  }

  // 落盘完整输出
  let outputFile = null
  if (workspace && sessionId && truncated) {
    try {
      const outputDir = path.join(workspace, SHELL_OUTPUT_DIR)
      fs.mkdirSync(outputDir, { recursive: true })
      const seq = Date.now()
      outputFile = path.join(outputDir, `${sessionId}_${seq}.out`)
      fs.writeFileSync(outputFile, fullOutput, 'utf-8')
    } catch (e) {
      console.error('[shell] Failed to write output file:', e.message)
    }
  }

  return { preview: preview.trim(), truncated, output_file: outputFile }
}

/**
 * 用 marker 机制读取 shell 进程输出，直到看到 marker 或超时
 */
function readUntilMarker(process, marker, timeoutMs) {
  return new Promise((resolve) => {
    let output = ''
    let resolved = false
    const fullMarker = MARKER_PREFIX + marker + MARKER_SUFFIX

    const onData = (data) => {
      output += data.toString()
      if (output.includes(fullMarker)) {
        finish(false)
      }
    }

    const timer = setTimeout(() => {
      finish(true)
    }, timeoutMs)

    function finish(timedOut) {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      process.stdout.removeListener('data', onData)

      // 移除 marker 行及之后的内容
      const markerIdx = output.indexOf(fullMarker)
      const cleanOutput = markerIdx >= 0 ? output.substring(0, markerIdx) : output

      resolve({
        output: cleanOutput.trim(),
        truncated: timedOut
      })
    }

    process.stdout.on('data', onData)
  })
}

async function handleShellFromWebSocket(args, sessionId, workspace, needApproval, dangerReason) {
  const { action, command, session_id, workdir, input } = args
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
      command_count: s.commandCount || 0
    }))
    return { sessions, count: sessions.length }
  }

  if (action === 'write_stdin') {
    const session = shellSessions.get(session_id)
    if (!session) {
      return { error: `Session not found: ${session_id}` }
    }
    const marker = generateMarker()
    session.process.stdin.write(input + '\n')
    session.process.stdin.write('echo ' + MARKER_PREFIX + marker + MARKER_SUFFIX + '\n')
    const result = await readUntilMarker(session.process, marker, args.yield_time_ms || 5000)
    session.lastActiveAt = Date.now()
    const saved = truncateAndSave(result.output, workspace, session_id)
    return {
      session_id,
      current_workdir: session.cwd,
      output: saved.preview,
      truncated: saved.truncated || result.truncated,
      ...(saved.output_file ? { output_file: saved.output_file } : {})
    }
  }

  // 复用已有会话
  if (session_id && shellSessions.has(session_id)) {
    const session = shellSessions.get(session_id)
    const marker = generateMarker()
    session.process.stdin.write(command + '\n')
    session.process.stdin.write('echo ' + MARKER_PREFIX + marker + MARKER_SUFFIX + '\n')
    const result = await readUntilMarker(session.process, marker, args.yield_time_ms || 10000)
    session.lastActiveAt = Date.now()
    session.commandCount = (session.commandCount || 0) + 1
    const saved = truncateAndSave(result.output, workspace, session_id)
    return {
      exit_code: 0,
      session_id,
      current_workdir: session.cwd,
      output: saved.preview,
      truncated: saved.truncated || result.truncated,
      ...(saved.output_file ? { output_file: saved.output_file } : {})
    }
  }

  // 新会话或一次性执行 — 根据后端下发的 needApproval 决定是否需要审批
  if (needApproval) {
    const approved = await requestToolApproval('shell', command, sessionId, dangerReason)
    if (!approved) {
      return { exit_code: -1, output: 'User denied command execution.' }
    }
  }

  // 创建持久化会话
  if (session_id) {
    const bashProcess = spawn('bash', ['--norc', '--noprofile'], {
      cwd: resolvedWorkdir || undefined,
      env: await buildShellEnv()
    })
    shellSessions.set(session_id, {
      process: bashProcess,
      cwd: resolvedWorkdir || '',
      commandCount: 0,
      createdAt: Date.now(),
      lastActiveAt: Date.now()
    })

    const marker = generateMarker()
    bashProcess.stdin.write(command + '\n')
    bashProcess.stdin.write('echo ' + MARKER_PREFIX + marker + MARKER_SUFFIX + '\n')
    const result = await readUntilMarker(bashProcess, marker, args.yield_time_ms || 10000)
    const session = shellSessions.get(session_id)
    session.lastActiveAt = Date.now()
    session.commandCount = 1
    const saved = truncateAndSave(result.output, workspace, session_id)
    return {
      exit_code: 0,
      session_id,
      current_workdir: resolvedWorkdir || '',
      output: saved.preview,
      truncated: saved.truncated || result.truncated,
      ...(saved.output_file ? { output_file: saved.output_file } : {})
    }
  }

  // 无 session_id，一次性执行
  const execEnv = await buildShellEnv()
  return new Promise((resolve) => {
    const options = {
      timeout: (args.timeout || 60) * 1000,
      maxBuffer: 1024 * 1024 * 5,
      env: execEnv
    }
    if (resolvedWorkdir) options.cwd = resolvedWorkdir

    exec(command, options, (error, stdout, stderr) => {
      if (error && error.killed) {
        resolve({ exit_code: -1, output: `Command timed out after ${args.timeout || 60}s` })
      } else {
        const fullOutput = (stdout || '') + (stderr ? '\n' + stderr : '')
        const saved = truncateAndSave(fullOutput, workspace, 'local')
        resolve({
          exit_code: error ? error.code || 1 : 0,
          session_id: 'local',
          current_workdir: resolvedWorkdir || '',
          output: saved.preview,
          truncated: saved.truncated,
          ...(saved.output_file ? { output_file: saved.output_file } : {})
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

async function handleLocalWriteFile(args, workspace, sessionId, needApproval) {
  if (needApproval) {
    const approved = await requestToolApproval('write_file', args.path, sessionId)
    if (!approved) {
      return { success: false, error: 'User denied file write.' }
    }
  }
  try {
    const resolvedPath = resolveWorkspacePath(args.path, workspace)
    // Snapshot before write for change tracking
    const fileExisted = fs.existsSync(resolvedPath)
    let oldLineCount = 0
    if (fileExisted) {
      oldLineCount = fs.readFileSync(resolvedPath, 'utf-8').split('\n').length
    }
    const dir = path.dirname(resolvedPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(resolvedPath, args.content, 'utf-8')
    // Compute file change stats
    const newLineCount = args.content.length === 0 ? 0 : args.content.split('\n').length
    const linesAdded = newLineCount
    const linesDeleted = fileExisted ? oldLineCount : 0
    return {
      success: true,
      bytes_written: Buffer.byteLength(args.content, 'utf-8'),
      file_change: {
        path: args.path,
        type: fileExisted ? 'MODIFIED' : 'CREATED',
        lines_added: linesAdded,
        lines_deleted: linesDeleted
      }
    }
  } catch (e) {
    return { error: e.message }
  }
}

async function handleLocalEditFile(args, workspace, sessionId, needApproval) {
  if (needApproval) {
    const approved = await requestToolApproval('edit_file', args.path, sessionId)
    if (!approved) {
      return { success: false, error: 'User denied file edit.' }
    }
  }
  try {
    const resolvedPath = resolveWorkspacePath(args.path, workspace)
    const content = fs.readFileSync(resolvedPath, 'utf-8')
    const count = content.split(args.old_string).length - 1
    if (count === 0) return { success: false, error: 'old_string not found in file' }
    fs.writeFileSync(resolvedPath, content.replaceAll(args.old_string, args.new_string), 'utf-8')
    // Compute file change stats
    const oldLines = args.old_string.split('\n').length
    const newLines = args.new_string.split('\n').length
    const linesAdded = newLines * count
    const linesDeleted = oldLines * count
    return {
      success: true,
      replacements: count,
      file_change: {
        path: args.path,
        type: 'MODIFIED',
        lines_added: linesAdded,
        lines_deleted: linesDeleted
      }
    }
  } catch (e) {
    return { error: e.message }
  }
}

// --- glob_search / grep_search ---

let rgAvailable = null
async function isRgAvailable() {
  if (rgAvailable !== null) return rgAvailable
  try {
    const { execFile } = require('child_process')
    await new Promise((resolve, reject) => {
      execFile('rg', ['--version'], (err) => err ? reject(err) : resolve())
    })
    rgAvailable = true
  } catch {
    rgAvailable = false
  }
  return rgAvailable
}

async function handleLocalGlobSearch(args, workspace) {
  const pattern = args.pattern
  if (!pattern) return { files: [], error: 'pattern is required' }

  const headLimit = args.head_limit || 100
  const searchRoot = args.path ? resolveWorkspacePath(args.path, workspace) : (workspace || currentWorkspace || '.')

  try {
    let files = []
    if (await isRgAvailable()) {
      files = await globWithRg(pattern, searchRoot, headLimit)
    } else {
      files = globWithNode(pattern, searchRoot, headLimit)
    }

    const truncated = files.length >= headLimit
    return {
      files,
      search_root: searchRoot,
      truncated,
      total_matched: files.length
    }
  } catch (e) {
    return { files: [], error: e.message }
  }
}

function globWithRg(pattern, searchRoot, headLimit) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process')
    execFile('rg', ['--files', '--glob', pattern, searchRoot], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return reject(err)
      const lines = (stdout || '').split('\n').filter(Boolean).slice(0, headLimit)
      resolve(lines.map(l => {
        const abs = path.resolve(l)
        return abs.startsWith(searchRoot) ? path.relative(searchRoot, abs) : abs
      }))
    })
  })
}

function globWithNode(pattern, searchRoot, headLimit) {
  const minimatch = require('minimatch')
  const files = []

  function walk(dir) {
    if (files.length >= headLimit) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (files.length >= headLimit) return
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        walk(fullPath)
      } else if (entry.isFile()) {
        const relative = path.relative(searchRoot, fullPath)
        if (minimatch(relative, pattern) || minimatch(entry.name, pattern)) {
          files.push(relative)
        }
      }
    }
  }

  walk(searchRoot)
  return files
}

async function handleLocalGrepSearch(args, workspace) {
  const pattern = args.pattern
  if (!pattern) return { matches: [], error: 'pattern is required' }

  const glob = args.glob || null
  const ignoreCase = args.ignore_case || false
  const contextLines = args.context_lines || 0
  const maxOutputChars = args.max_output_chars || 10000
  const searchRoot = args.path ? resolveWorkspacePath(args.path, workspace) : (workspace || currentWorkspace || '.')

  try {
    if (await isRgAvailable()) {
      return await grepWithRg(pattern, searchRoot, glob, ignoreCase, contextLines, maxOutputChars)
    } else {
      return grepWithNode(pattern, searchRoot, glob, ignoreCase, contextLines, maxOutputChars)
    }
  } catch (e) {
    return { matches: [], error: e.message }
  }
}

function grepWithRg(pattern, searchRoot, glob, ignoreCase, contextLines, maxOutputChars) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process')
    const cmd = ['--line-number', '--no-heading']
    if (ignoreCase) cmd.push('--ignore-case')
    if (contextLines > 0) { cmd.push('--context'); cmd.push(String(contextLines)) }
    if (glob) { cmd.push('--glob'); cmd.push(glob) }
    cmd.push(pattern)
    cmd.push(searchRoot)

    execFile('rg', cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve({ matches: [], truncated: false, total_matches: 0 })

      const lines = (stdout || '').split('\n').filter(Boolean)
      const matches = []
      let totalMatches = 0
      let charsUsed = 0
      let truncated = false

      for (const line of lines) {
        if (charsUsed + line.length + 1 > maxOutputChars) {
          truncated = true
          break
        }
        const parsed = parseRgLine(line, searchRoot)
        if (parsed) {
          matches.push(parsed)
          totalMatches++
          charsUsed += line.length + 1
        }
      }

      resolve({ matches, truncated, total_matches: totalMatches })
    })
  })
}

function parseRgLine(line, searchRoot) {
  const firstColon = line.indexOf(':')
  if (firstColon < 0) return null
  const secondColon = line.indexOf(':', firstColon + 1)
  if (secondColon < 0) return null

  const filePath = line.substring(0, firstColon)
  const lineNumStr = line.substring(firstColon + 1, secondColon)
  const content = line.substring(secondColon + 1)

  const lineNum = parseInt(lineNumStr, 10)
  if (isNaN(lineNum)) {
    const firstDash = line.indexOf('-')
    if (firstDash < 0) return null
    const secondDash = line.indexOf('-', firstDash + 1)
    if (secondDash < 0) return null
    const dashLineNum = parseInt(line.substring(firstDash + 1, secondDash), 10)
    if (isNaN(dashLineNum)) return null
    const abs = path.resolve(line.substring(0, firstDash))
    const rel = abs.startsWith(searchRoot) ? path.relative(searchRoot, abs) : abs
    return { file: rel, line: dashLineNum, content: line.substring(secondDash + 1) }
  }

  const abs = path.resolve(filePath)
  const rel = abs.startsWith(searchRoot) ? path.relative(searchRoot, abs) : abs
  return { file: rel, line: lineNum, content }
}

function grepWithNode(pattern, searchRoot, glob, ignoreCase, contextLines, maxOutputChars) {
  const minimatch = require('minimatch')
  const flags = ignoreCase ? 'i' : ''
  let regex
  try {
    regex = new RegExp(pattern, flags)
  } catch {
    return { matches: [], error: 'Invalid regex pattern: ' + pattern }
  }

  const matches = []
  let totalMatches = 0
  let charsUsed = 0
  let truncated = false

  function walk(dir) {
    if (truncated) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }

    for (const entry of entries) {
      if (truncated) return
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        walk(fullPath)
      } else if (entry.isFile()) {
        if (glob && !minimatch(entry.name, glob)) continue

        let lines
        try { lines = fs.readFileSync(fullPath, 'utf-8').split('\n') } catch { continue }

        const relative = path.relative(searchRoot, fullPath)

        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            const match = { file: relative, line: i + 1, content: lines[i] }

            if (contextLines > 0) {
              const before = []
              for (let c = Math.max(0, i - contextLines); c < i; c++) before.push(lines[c])
              const after = []
              for (let c = i + 1; c <= Math.min(lines.length - 1, i + contextLines); c++) after.push(lines[c])
              if (before.length > 0) match.context_before = before
              if (after.length > 0) match.context_after = after
            }

            const entrySize = JSON.stringify(match).length
            if (charsUsed + entrySize > maxOutputChars) {
              truncated = true
              break
            }

            matches.push(match)
            totalMatches++
            charsUsed += entrySize
          }
        }
      }
    }
  }

  walk(searchRoot)
  return { matches, truncated, total_matches: totalMatches }
}
