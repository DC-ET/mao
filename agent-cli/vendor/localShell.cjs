'use strict'

const { spawn } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const MAX_COMMAND_LENGTH = 10000
const MARKER_PREFIX = '__CMD_DONE_'
const MARKER_SUFFIX = '__'
const WORKDIR_TIMEOUT_MS = 5000
const DEFAULT_EXEC_YIELD_MS = 300_000
const DEFAULT_STDIN_YIELD_MS = 5000
const MAX_PREVIEW_LINES = 100
const MAX_PREVIEW_CHARS = 10000
const DEFAULT_MAX_SESSIONS = 30
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000
const EXIT_STATUS_PATTERN = /^[ \t]*(-?\d+)[ \t]*\r?\n?/

function shellSingleQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

function asText(value) {
  if (value == null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function asInt(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return Math.trunc(n)
  }
  return fallback
}

function expandHome(filePath) {
  if (!filePath) return filePath
  if (filePath === '~') return os.homedir()
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2))
  return filePath
}

function newMarker() {
  return MARKER_PREFIX + crypto.randomBytes(6).toString('hex') + MARKER_SUFFIX
}

function preview(full) {
  const lines = full.split('\n')
  let truncated = false
  let text = full
  if (lines.length > MAX_PREVIEW_LINES) {
    text = lines.slice(-MAX_PREVIEW_LINES).join('\n')
    truncated = true
  }
  if (text.length > MAX_PREVIEW_CHARS) {
    text = text.slice(text.length - MAX_PREVIEW_CHARS)
    truncated = true
  }
  return { text, truncated }
}

function resolveYieldTimeMs(args, defaultMs) {
  if (args.yield_time_ms != null) return asInt(args.yield_time_ms, defaultMs)
  if (args.timeout != null) {
    const sec = asInt(args.timeout, 0)
    if (sec > 0) return sec * 1000
  }
  return defaultMs
}

function resolveExitCode(result) {
  if (result.exitCode != null) return result.exitCode
  return result.completed ? 0 : -1
}

class LocalShellSession {
  constructor(sessionId, conversationId, child, workdir, outputFile, displayPath) {
    this.sessionId = sessionId
    this.conversationId = conversationId
    this.process = child
    this.currentWorkdir = workdir
    this.outputFile = outputFile
    this.displayPath = displayPath
    this.commandCount = 0
    this.createdAt = Date.now()
    this.lastActiveAt = Date.now()
    this.alive = true
    this.leftover = ''
    this.pendingAsync = null
    this.process.stdout.setEncoding('utf8')
    this.process.stderr.setEncoding('utf8')
    this.process.stderr.resume()
  }

  touch() {
    this.lastActiveAt = Date.now()
  }

  isAlive() {
    return this.alive && this.process.exitCode == null && !this.process.killed
  }

  isIdleTimeout(timeoutMs) {
    return Date.now() - this.lastActiveAt > timeoutMs
  }

  isExpired(maxLifetimeMs) {
    return Date.now() - this.createdAt > maxLifetimeMs
  }

  incrementCommandCount() {
    this.commandCount++
  }

  setCurrentWorkdir(workdir) {
    this.currentWorkdir = workdir
  }

  writeStdin(text) {
    this.process.stdin.write(text)
  }

  drainChunk() {
    const chunk = this.leftover
    this.leftover = ''
    return chunk
  }

  appendLeftover(text) {
    this.leftover += text
  }

  close() {
    if (!this.alive) return
    this.alive = false
    const pid = this.process.pid
    if (pid != null) {
      try { process.kill(-pid, 'SIGKILL') } catch { /* group already gone or unsupported */ }
    }
    try { this.process.kill('SIGKILL') } catch { /* ignore */ }
    try { this.process.stdin.end() } catch { /* ignore */ }
  }
}

function createLocalShellRuntime(options = {}) {
  const buildEnv = options.buildEnv || (async () => ({ ...process.env, TERM: 'dumb', PS1: '' }))
  const refreshToken = options.refreshToken || (() => {})
  const resolveOutput = options.resolveOutput
  const maxSessions = options.maxSessionsPerConversation ?? DEFAULT_MAX_SESSIONS
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const maxLifetimeMs = options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS
  const spawnFn = options.spawn || spawn
  const sessions = new Map()
  const conversationSessions = new Map()
  let cleanupTimer = null

  function outputFor(conversationId, shellId) {
    if (resolveOutput) return resolveOutput(conversationId, shellId)
    const dir = path.join(os.tmpdir(), 'mao-local-shell', String(conversationId ?? 0))
    fs.mkdirSync(dir, { recursive: true })
    const absPath = path.join(dir, `${shellId}.out`)
    return { absPath, displayPath: absPath }
  }

  function pruneConversation(conversationId) {
    const conv = conversationSessions.get(conversationId)
    if (!conv) return
    for (const id of [...conv]) {
      const session = sessions.get(id)
      if (session?.isAlive()) continue
      conv.delete(id)
      sessions.delete(id)
      session?.close()
    }
    if (conv.size === 0) conversationSessions.delete(conversationId)
  }

  function removeSession(sessionId) {
    const session = sessions.get(sessionId)
    sessions.delete(sessionId)
    if (!session) return
    session.close()
    if (session.conversationId != null) {
      conversationSessions.get(session.conversationId)?.delete(sessionId)
    }
  }

  async function createSession(shellId, conversationId, workdir) {
    const { absPath, displayPath } = outputFor(conversationId, shellId)
    fs.mkdirSync(path.dirname(absPath), { recursive: true })
    fs.writeFileSync(absPath, '')
    const env = { ...(await buildEnv()), TERM: 'dumb', PS1: '' }
    const child = spawnFn('bash', ['-c', 'exec 2>&1; exec bash --norc --noprofile'], {
      cwd: workdir || undefined,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    return new LocalShellSession(shellId, conversationId, child, workdir || '', absPath, displayPath)
  }

  async function getOrCreate(conversationId, shellSessionId, workdir) {
    if (shellSessionId && sessions.has(shellSessionId)) {
      const existing = sessions.get(shellSessionId)
      if (existing.isAlive()) {
        existing.touch()
        return existing
      }
      removeSession(shellSessionId)
    }
    pruneConversation(conversationId)
    const conv = conversationSessions.get(conversationId) ?? new Set()
    conversationSessions.set(conversationId, conv)
    if (conv.size >= maxSessions) {
      throw new Error(`Maximum number of shell sessions (${maxSessions}) reached for conversation ${conversationId}. Close existing sessions first.`)
    }
    if (!shellSessionId) {
      shellSessionId = `sh-${conversationId}-${Date.now()}`
    }
    const session = await createSession(shellSessionId, conversationId, workdir)
    sessions.set(shellSessionId, session)
    conv.add(shellSessionId)
    return session
  }

  async function readUntilMarker(session, marker, timeoutMs, persistOutput = true) {
    const start = Date.now()
    const deadline = start + timeoutMs
    let full = session.drainChunk()
    let persistedUntil = 0
    let completed = false

    const persistVisibleOutput = (final = false) => {
      if (!persistOutput) return
      const markerIndex = full.indexOf(marker)
      const visibleEnd = markerIndex >= 0
        ? markerIndex
        : final ? full.length : Math.max(0, full.length - marker.length + 1)
      if (visibleEnd <= persistedUntil) return
      try {
        fs.appendFileSync(session.outputFile, full.slice(persistedUntil, visibleEnd))
        persistedUntil = visibleEnd
      } catch { /* ignore */ }
    }

    persistVisibleOutput()
    if (full.includes(marker)) completed = true

    await new Promise((resolve) => {
      if (completed) {
        resolve()
        return
      }
      const onData = (data) => {
        full += typeof data === 'string' ? data : data.toString('utf8')
        persistVisibleOutput()
        if (full.includes(marker) || !session.isAlive()) {
          cleanup()
          resolve()
        }
      }
      const onEnd = () => {
        cleanup()
        resolve()
      }
      const cleanup = () => {
        session.process.stdout.off('data', onData)
        session.process.stdout.off('end', onEnd)
        session.process.off('exit', onEnd)
        clearInterval(timer)
      }
      session.process.stdout.on('data', onData)
      session.process.stdout.on('end', onEnd)
      session.process.on('exit', onEnd)
      const timer = setInterval(() => {
        if (Date.now() >= deadline || !session.isAlive()) {
          cleanup()
          resolve()
        }
      }, 50)
    })

    persistVisibleOutput(true)
    const idx = full.indexOf(marker)
    let exitCode = null
    if (idx >= 0) {
      completed = true
      let after = full.slice(idx + marker.length)
      const status = EXIT_STATUS_PATTERN.exec(after)
      if (status) {
        exitCode = Number(status[1])
        after = after.slice(status[0].length)
      }
      full = full.slice(0, idx)
      if (after) session.appendLeftover(after.replace(/^\r?\n/, ''))
    }
    const shown = preview(full)
    return {
      output: shown.text,
      truncated: shown.truncated,
      completed,
      elapsedMs: Date.now() - start,
      exitCode,
    }
  }

  async function executeWithMarker(session, command, timeoutMs, persistOutput = true) {
    const marker = newMarker()
    session.writeStdin(command + '\necho ' + marker + ' $?\n')
    return readUntilMarker(session, marker, timeoutMs, persistOutput)
  }

  function injectToken(session) {
    try {
      refreshToken(session)
    } catch (e) {
      console.warn('[shell] Failed to refresh MAO_TOKEN:', e.message)
    }
  }

  function resolveWorkdir(workdirArg, workspace) {
    if (!workdirArg) return null
    const expanded = expandHome(workdirArg)
    if (path.isAbsolute(expanded)) return expanded
    return path.join(workspace || process.cwd(), expanded)
  }

  async function resolveCurrentWorkdir(session, result) {
    if (!result.completed) return session.currentWorkdir
    try {
      const marker = newMarker()
      session.writeStdin('pwd\necho ' + marker + '\n')
      const pwd = await readUntilMarker(session, marker, WORKDIR_TIMEOUT_MS, false)
      if (pwd.completed) {
        const lines = pwd.output.split('\n').map((l) => l.trim()).filter((l) => l !== '')
        const last = lines[lines.length - 1]
        if (last && (last.startsWith('/') || /^[A-Za-z]:[\\/]/.test(last))) {
          session.setCurrentWorkdir(last)
          return last
        }
      }
    } catch (e) {
      console.warn('[shell] Failed to refresh workdir:', e.message)
    }
    return session.currentWorkdir
  }

  async function ensureApproved(ctx, description) {
    if (!ctx.needApproval) return true
    if (typeof ctx.approve !== 'function') return true
    return ctx.approve(description)
  }

  function formatExecResult(session, result) {
    return {
      exit_code: resolveExitCode(result),
      session_id: session.sessionId,
      output: result.output,
      truncated: result.truncated,
      completed: result.completed,
      current_workdir: session.currentWorkdir,
      output_file: session.displayPath,
    }
  }

  async function handleExec(args, ctx) {
    const command = asText(args.command)
    if (!command || command.trim() === '') return { error: 'exec 动作必须提供 command' }
    if (command.length > MAX_COMMAND_LENGTH) {
      return { error: `命令过长（最多 ${MAX_COMMAND_LENGTH} 个字符）` }
    }
    const approved = await ensureApproved(ctx, command)
    if (!approved) {
      return { exit_code: -1, output: 'User denied command execution.', session_id: asText(args.session_id) }
    }
    const keepSession = args.keep_session === true
    const yieldTimeMs = resolveYieldTimeMs(args, DEFAULT_EXEC_YIELD_MS)
    const workdirArg = asText(args.workdir)
    const workdir = resolveWorkdir(workdirArg, ctx.workspace) || ctx.workspace || ''
    const conversationId = ctx.conversationId ?? 0
    let session
    try {
      session = await getOrCreate(conversationId, asText(args.session_id), workdir)
    } catch (e) {
      return { error: e.message }
    }
    if (session.pendingAsync) {
      return { error: '会话仍有未完成的异步命令，请先等待结束：' + session.sessionId }
    }
    injectToken(session)
    if (workdirArg && workdir) {
      await executeWithMarker(session, 'cd ' + shellSingleQuote(workdir), WORKDIR_TIMEOUT_MS)
    }
    if (args.async === true) {
      const marker = newMarker()
      session.writeStdin(command + '\necho ' + marker + ' $?\n')
      session.incrementCommandCount()
      session.touch()
      session.pendingAsync = {
        keepSession,
        promise: readUntilMarker(session, marker, yieldTimeMs),
      }
      return {
        async: true,
        session_id: session.sessionId,
        output_file: session.displayPath,
        message: '命令已提交到后台执行。',
      }
    }
    const result = await executeWithMarker(session, command, yieldTimeMs)
    session.incrementCommandCount()
    session.touch()
    const currentWorkdir = await resolveCurrentWorkdir(session, result)
    const payload = formatExecResult(session, result)
    payload.current_workdir = currentWorkdir
    if (!keepSession) removeSession(session.sessionId)
    return payload
  }

  async function handleAwaitAsync(args) {
    const shellId = asText(args.session_id)
    if (!shellId) return { error: 'await_async 必须提供 session_id' }
    const session = sessions.get(shellId)
    if (!session) return { error: '会话不存在或已关闭：' + shellId }
    const pending = session.pendingAsync
    if (!pending) return { error: '没有待收取的异步输出：' + shellId }
    session.pendingAsync = null
    const result = await pending.promise
    session.touch()
    const currentWorkdir = await resolveCurrentWorkdir(session, result)
    const payload = formatExecResult(session, result)
    payload.current_workdir = currentWorkdir
    if (!pending.keepSession) removeSession(session.sessionId)
    return payload
  }

  async function handleWriteStdin(args, ctx) {
    const shellId = asText(args.session_id)
    const input = asText(args.input) ?? ''
    if (!shellId) return { error: 'write_stdin 必须提供 session_id' }
    const session = sessions.get(shellId)
    if (!session?.isAlive()) return { error: '会话不存在或已关闭：' + shellId }
    if (session.pendingAsync) {
      return { error: '会话仍有未完成的异步命令，请先等待结束：' + shellId }
    }
    const approved = await ensureApproved(ctx, input)
    if (!approved) {
      return { error: 'User denied command execution.', session_id: shellId }
    }
    injectToken(session)
    const yieldTimeMs = args.yield_time_ms != null ? asInt(args.yield_time_ms, DEFAULT_STDIN_YIELD_MS) : DEFAULT_STDIN_YIELD_MS
    const result = await executeWithMarker(session, input, yieldTimeMs)
    session.touch()
    const currentWorkdir = await resolveCurrentWorkdir(session, result)
    const payload = formatExecResult(session, result)
    payload.current_workdir = currentWorkdir
    return payload
  }

  function handleClose(args) {
    const shellId = asText(args.session_id)
    if (!shellId) return { error: 'close 必须提供 session_id' }
    removeSession(shellId)
    return { success: true, session_id: shellId }
  }

  function handleList(ctx) {
    const conversationId = ctx.conversationId ?? 0
    pruneConversation(conversationId)
    const conv = conversationSessions.get(conversationId)
    const list = []
    if (conv) {
      for (const id of conv) {
        const session = sessions.get(id)
        if (session?.isAlive()) {
          list.push({
            session_id: session.sessionId,
            current_workdir: session.currentWorkdir,
            alive: true,
          })
        }
      }
    }
    return { sessions: list }
  }

  async function handle(args, ctx = {}) {
    try {
      let action = asText(args?.action) ?? 'exec'
      if (action.trim() === '') action = 'exec'
      switch (action) {
        case 'exec': return await handleExec(args || {}, ctx)
        case 'write_stdin': return await handleWriteStdin(args || {}, ctx)
        case 'await_async': return await handleAwaitAsync(args || {})
        case 'close': return handleClose(args || {})
        case 'list': return handleList(ctx)
        default: return { error: '未知动作：' + action }
      }
    } catch (e) {
      console.error('[shell] execution failed:', e)
      return { error: '错误：' + e.message }
    }
  }

  function cleanupExpiredSessions() {
    let cleaned = 0
    for (const [sessionId, session] of [...sessions.entries()]) {
      if (!session.isAlive() || session.isIdleTimeout(idleTimeoutMs) || session.isExpired(maxLifetimeMs)) {
        removeSession(sessionId)
        cleaned++
      }
    }
    if (cleaned > 0) {
      console.log(`[shell] Cleaned up ${cleaned} expired shell sessions`)
    }
  }

  function startCleanup(intervalMs = 60_000) {
    if (cleanupTimer) return
    cleanupTimer = setInterval(() => cleanupExpiredSessions(), intervalMs)
    if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref()
  }

  function stopCleanup() {
    if (!cleanupTimer) return
    clearInterval(cleanupTimer)
    cleanupTimer = null
  }

  function closeAll() {
    for (const sessionId of [...sessions.keys()]) {
      removeSession(sessionId)
    }
    conversationSessions.clear()
  }

  function getActiveSessionCount() {
    return sessions.size
  }

  if (options.autoCleanup !== false) startCleanup()

  return {
    handle,
    closeAll,
    startCleanup,
    stopCleanup,
    cleanupExpiredSessions,
    getActiveSessionCount,
  }
}

module.exports = {
  createLocalShellRuntime,
  shellSingleQuote,
  MAX_COMMAND_LENGTH,
  DEFAULT_EXEC_YIELD_MS,
}
