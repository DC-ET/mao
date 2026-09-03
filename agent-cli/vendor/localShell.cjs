'use strict'

const { spawn } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const MAX_COMMAND_LENGTH = 20000
const MARKER_PREFIX = '__CMD_DONE_'
const MARKER_SUFFIX = '__'
const WORKDIR_TIMEOUT_MS = 5000
const DEFAULT_EXEC_YIELD_MS = 300_000
const DEFAULT_STDIN_YIELD_MS = 5000
const DEFAULT_AWAIT_YIELD_MS = 60_000
const MAX_PREVIEW_LINES = 100
const MAX_PREVIEW_CHARS = 10000
const MAX_WAIT_FOR_LENGTH = 200
const DEFAULT_MAX_SESSIONS = 30
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000
const EXIT_STATUS_PATTERN = /^[ \t]*(-?\d+)[ \t]*\r?\n?/
/** 缓冲区上限；超限时把最旧的一段丢出内存，输出文件仍然完整。 */
const MAX_BUFFER_CHARS = 262_144
const BUFFER_KEEP_TAIL_CHARS = 8192
/** 轮询上限：有新输出会立即唤醒，这里只兜底超时判定。 */
const WAIT_SLICE_MS = 200

/**
 * 缓冲区末尾与 marker 前缀重叠的长度：这段可能是刚到一半的结束标记，
 * 既不能当正文交给模型也不能落盘，等剩余字节到达再判定。
 */
function pendingMarkerTail(buffer, marker) {
  const max = Math.min(marker.length - 1, buffer.length)
  for (let k = max; k > 0; k--) {
    if (buffer.endsWith(marker.slice(0, k))) return k
  }
  return 0
}

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
    this.buffer = ''
    this.persistedUpTo = 0
    this.emittedUpTo = 0
    this.bufferTrimmed = false
    this.waiters = []
    /** 已写入 stdin 但尚未读到结束标记的命令：{ marker, keepSession, persist, background } */
    this.pendingCommand = null
    /** 最近一次被 finishCommand 消费的 marker：防止过期调用方把它重新登记成永不出现的假 pending。 */
    this.lastConsumedMarker = null
    this.process.stdout.setEncoding('utf8')
    this.process.stderr.setEncoding('utf8')
    this.process.stderr.resume()
    // 常驻读取：没有监听者时 Node 会直接丢弃 stdout 数据，
    // 提前放行（wait_for 命中 / 超时）后剩余输出与结束标记就再也读不到了。
    this.process.stdout.on('data', (data) => this.onData(data))
    this.process.stdout.on('end', () => this.wake())
    this.process.on('exit', () => this.wake())
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

  /**
   * persist=false 用于 cd/pwd 等协议命令，其输出不进落盘文件。
   * background=true 表示命令由 async 提交，读取权归 await_async。
   */
  beginCommand(marker, keepSession, persist = true, background = false) {
    this.pendingCommand = { marker, keepSession, persist, background }
  }

  peekBuffer() {
    return this.buffer
  }

  emittedBoundary() {
    return this.emittedUpTo
  }

  markEmitted(end) {
    if (end > this.emittedUpTo) this.emittedUpTo = end
  }

  wasBufferTrimmed() {
    return this.bufferTrimmed
  }

  finishCommand(consumedEnd) {
    if (this.pendingCommand) this.lastConsumedMarker = this.pendingCommand.marker
    this.flushPersist(true)
    this.buffer = this.buffer.slice(consumedEnd)
    this.persistedUpTo = 0
    this.emittedUpTo = 0
    this.bufferTrimmed = false
    this.pendingCommand = null
  }

  async waitForOutput(timeoutMs) {
    if (timeoutMs <= 0 || !this.isAlive()) return
    await new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.waiters = this.waiters.filter((w) => w !== finish)
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      this.waiters.push(finish)
    })
  }

  onData(data) {
    this.buffer += typeof data === 'string' ? data : data.toString('utf8')
    // 有输出即视为活跃，否则只输出不被读取的常驻命令会被空闲清理杀掉
    this.lastActiveAt = Date.now()
    this.flushPersist(false)
    this.trimBuffer()
    this.wake()
  }

  wake() {
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter()
  }

  /** 结束标记本身与其后的退出码不能写进输出文件，未见到标记时按尾部实际重叠长度回退，避免标记被切两半。 */
  flushPersist(final) {
    const pending = this.pendingCommand
    if (pending && !pending.persist) return
    const marker = pending?.marker
    let visibleEnd
    if (!marker) {
      visibleEnd = this.buffer.length
    } else {
      const idx = this.buffer.indexOf(marker)
      visibleEnd = idx >= 0
        ? idx
        : final ? this.buffer.length : this.buffer.length - pendingMarkerTail(this.buffer, marker)
    }
    if (visibleEnd <= this.persistedUpTo) return
    try {
      fs.appendFileSync(this.outputFile, this.buffer.slice(this.persistedUpTo, visibleEnd))
      this.persistedUpTo = visibleEnd
    } catch { /* ignore */ }
  }

  trimBuffer() {
    if (this.buffer.length <= MAX_BUFFER_CHARS) return
    const dropTo = Math.min(this.persistedUpTo, this.buffer.length - BUFFER_KEEP_TAIL_CHARS)
    if (dropTo <= 0) return
    this.buffer = this.buffer.slice(dropTo)
    this.persistedUpTo -= dropTo
    this.emittedUpTo = Math.max(0, this.emittedUpTo - dropTo)
    this.bufferTrimmed = true
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
    // 立刻唤醒等待者，否则读取者会空等到 yield 超时才发现会话已关闭
    this.wake()
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

  /**
   * 读到结束标记、waitFor 命中正文、进程退出或超时为止。
   * 输出取自会话常驻缓冲区，因此提前返回后剩余输出不会丢失，可再次调用继续读。
   */
  async function readUntilMarker(session, marker, timeoutMs, waitFor = null) {
    const start = Date.now()
    const deadline = start + timeoutMs
    // 直接调用（协议命令、测试）没有登记 pending，按默认落盘补登记；
    // marker 已被其他调用方消费过（finishCommand 置空了 pending）时绝不能重新登记，
    // 否则等于造出一条永不结束的假命令，把会话永久卡死。
    if (session.pendingCommand?.marker !== marker) {
      if (session.lastConsumedMarker === marker) {
        return {
          output: '',
          truncated: false,
          completed: true,
          elapsedMs: 0,
          exitCode: null,
          matched: null,
        }
      }
      session.beginCommand(marker, true)
    }

    let matched = null
    let markerIndex = -1
    for (;;) {
      const buffer = session.peekBuffer()
      markerIndex = buffer.indexOf(marker)
      if (markerIndex >= 0) break
      if (waitFor) {
        // 只在尚未返回给调用方的部分里找，避免续等时被上一次已交付的输出立刻命中。
        const hit = waitFor.exec(buffer.slice(session.emittedBoundary()))
        if (hit) {
          matched = hit[0]
          break
        }
      }
      if (!session.isAlive()) break
      const remain = deadline - Date.now()
      if (remain <= 0) break
      await session.waitForOutput(Math.min(remain, WAIT_SLICE_MS))
    }

    const buffer = session.peekBuffer()
    const emitted = session.emittedBoundary()
    if (markerIndex < 0) {
      // 尾部可能是被切成两半的结束标记，留到下一次读取再判定，否则标记会漏进正文；
      // 会话已结束时不会再有后续字节，只能原样交付。
      const tail = session.isAlive() ? pendingMarkerTail(buffer, marker) : 0
      const end = Math.max(emitted, buffer.length - tail)
      const shown = preview(buffer.slice(emitted, end))
      session.markEmitted(end)
      return {
        output: shown.text,
        truncated: shown.truncated || session.wasBufferTrimmed(),
        completed: false,
        elapsedMs: Date.now() - start,
        exitCode: null,
        matched,
      }
    }

    let consumed = markerIndex + marker.length
    let exitCode = null
    const status = EXIT_STATUS_PATTERN.exec(buffer.slice(consumed))
    if (status) {
      exitCode = Number(status[1])
      consumed += status[0].length
    } else {
      const newline = /^\r?\n/.exec(buffer.slice(consumed))
      if (newline) consumed += newline[0].length
    }
    const shown = preview(buffer.slice(emitted, markerIndex))
    const trimmed = session.wasBufferTrimmed()
    session.finishCommand(consumed)
    return {
      output: shown.text,
      truncated: shown.truncated || trimmed,
      completed: true,
      elapsedMs: Date.now() - start,
      exitCode,
      matched: null,
    }
  }

  /** cd 等协议命令：输出不落盘，也不参与 keep_session 判定。 */
  async function executeWithMarker(session, command, timeoutMs) {
    const marker = newMarker()
    session.beginCommand(marker, true, false)
    session.writeStdin(command + '\necho ' + marker + ' $?\n')
    return readUntilMarker(session, marker, timeoutMs)
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
      // pwd 属协议命令，输出不进落盘文件
      session.beginCommand(marker, true, false)
      session.writeStdin('pwd\necho ' + marker + '\n')
      const pwd = await readUntilMarker(session, marker, WORKDIR_TIMEOUT_MS)
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

  function formatExecResult(session, result, currentWorkdir) {
    const payload = {
      exit_code: resolveExitCode(result),
      session_id: session.sessionId,
      output: result.output,
      truncated: result.truncated,
      completed: result.completed,
      current_workdir: currentWorkdir ?? session.currentWorkdir,
      output_file: session.displayPath,
    }
    if (result.matched != null) payload.matched = result.matched
    if (!result.completed) {
      payload.message = result.matched != null
        ? `wait_for 已命中，命令仍在运行。用 action:'await_async' + session_id:'${session.sessionId}' 继续等待。`
        : `等待超时，命令仍在运行。用 action:'await_async' + session_id:'${session.sessionId}' 继续等待。`
    }
    return payload
  }

  /** wait_for 由模型提供，非法正则要作为参数错误反馈而不是抛异常。 */
  function parseWaitFor(args) {
    const raw = asText(args.wait_for)
    if (!raw || raw === '') return null
    if (raw.length > MAX_WAIT_FOR_LENGTH) return `wait_for 过长（最多 ${MAX_WAIT_FOR_LENGTH} 个字符）`
    try {
      return new RegExp(raw)
    } catch (e) {
      return `wait_for 不是合法正则：${e.message}`
    }
  }

  /** 写入命令并登记为等待中；提前返回后仍能凭 marker 继续读。 */
  function writeCommand(session, command, marker, keepSession, background) {
    session.beginCommand(marker, keepSession, true, background)
    session.writeStdin(command + '\necho ' + marker + ' $?\n')
    session.incrementCommandCount()
    session.touch()
  }

  /**
   * 命令已结束才按 keep_session 决定是否回收；仍在运行时必须保留会话，
   * 否则关闭会 SIGKILL 掉进程组，模型再也拿不到剩余输出。
   */
  function settleSession(session, result, keepSession) {
    if (result.completed && !keepSession) removeSession(session.sessionId)
  }

  async function handleExec(args, ctx) {
    const command = asText(args.command)
    if (!command || command.trim() === '') return { error: 'exec 动作必须提供 command' }
    if (command.length > MAX_COMMAND_LENGTH) {
      return { error: `命令过长（最多 ${MAX_COMMAND_LENGTH} 个字符）` }
    }
    const waitFor = parseWaitFor(args)
    if (typeof waitFor === 'string') return { error: waitFor }
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
    // 上一条命令未结束时再写新命令会让两条命令的输出交织，且新命令要排在它之后才执行
    if (session.pendingCommand) {
      return {
        error: (session.pendingCommand.background ? '会话仍有未完成的异步命令' : '会话仍有未结束的命令')
          + `，请先用 action:'await_async' 收取结果：${session.sessionId}`,
      }
    }
    injectToken(session)
    if (workdirArg && workdir) {
      await executeWithMarker(session, 'cd ' + shellSingleQuote(workdir), WORKDIR_TIMEOUT_MS)
    }
    const marker = newMarker()
    if (args.async === true) {
      // 输出留在会话缓冲区，由 await_async 领取；此处不能挂 promise，否则读取者退出后输出会丢
      writeCommand(session, command, marker, keepSession, true)
      return {
        async: true,
        session_id: session.sessionId,
        output_file: session.displayPath,
        message: '命令已提交到后台执行。',
      }
    }
    writeCommand(session, command, marker, keepSession, false)
    const result = await readUntilMarker(session, marker, yieldTimeMs, waitFor)
    const currentWorkdir = await resolveCurrentWorkdir(session, result)
    const payload = formatExecResult(session, result, currentWorkdir)
    settleSession(session, result, keepSession)
    return payload
  }

  /** 继续等待会话中未结束的命令：凭 pendingCommand 的 marker 从常驻缓冲区续读。 */
  async function handleAwaitAsync(args) {
    const shellId = asText(args.session_id)
    if (!shellId) return { error: 'await_async 必须提供 session_id' }
    const waitFor = parseWaitFor(args)
    if (typeof waitFor === 'string') return { error: waitFor }
    const session = sessions.get(shellId)
    if (!session) return { error: '会话不存在或已关闭：' + shellId }
    const pending = session.pendingCommand
    if (!pending) return { error: '该会话没有未结束的命令：' + shellId }
    const yieldTimeMs = resolveYieldTimeMs(args, DEFAULT_AWAIT_YIELD_MS)
    let result
    try {
      result = await readUntilMarker(session, pending.marker, yieldTimeMs, waitFor)
    } finally {
      // 读取权交还会话，否则命令未结束时 write_stdin 会被永久挡住
      if (session.pendingCommand) session.pendingCommand.background = false
    }
    if (!result.completed && !session.pendingCommand) {
      // 等待期间命令的结果已被并行调用方收取：按错误返回，避免把空输出误报成「仍在运行」
      return { error: '该命令的结果已被并行调用收取：' + shellId }
    }
    session.touch()
    const currentWorkdir = await resolveCurrentWorkdir(session, result)
    const payload = formatExecResult(session, result, currentWorkdir)
    settleSession(session, result, pending.keepSession)
    return payload
  }

  async function handleWriteStdin(args, ctx) {
    const shellId = asText(args.session_id)
    const input = asText(args.input) ?? ''
    if (!shellId) return { error: 'write_stdin 必须提供 session_id' }
    const waitFor = parseWaitFor(args)
    if (typeof waitFor === 'string') return { error: waitFor }
    const session = sessions.get(shellId)
    if (!session?.isAlive()) return { error: '会话不存在或已关闭：' + shellId }
    const pending = session.pendingCommand
    if (pending?.background) {
      return { error: `会话仍有未完成的异步命令，请先用 action:'await_async' 收取结果：${shellId}` }
    }
    const approved = await ensureApproved(ctx, input)
    if (!approved) {
      return { error: 'User denied command execution.', session_id: shellId }
    }
    const yieldTimeMs = resolveYieldTimeMs(args, DEFAULT_STDIN_YIELD_MS)
    // 审批可能等待很久，进审批前的快照可能已过期，必须以审批后的实时状态为准
    const livePending = session.pendingCommand
    if (livePending) {
      if (session.peekBuffer().includes(livePending.marker)) {
        // 命令已结束但结果尚未被收取：此时写入的输入会被 bash 当作新命令执行，
        // 而续读会立刻命中旧 marker，把旧输出误当成输入的应答
        return { error: `上一条命令已结束但结果尚未收取：${shellId}。请先 action:'await_async' 收取结果，再发送新输入。`, session_id: shellId }
      }
      // 有命令正在运行：输入交给它，不能再插入 marker（marker 只会排在该命令之后被执行）
      session.writeStdin(input.endsWith('\n') ? input : input + '\n')
      session.touch()
      const answered = await readUntilMarker(session, livePending.marker, yieldTimeMs, waitFor)
      const workdirNow = await resolveCurrentWorkdir(session, answered)
      const payload = formatExecResult(session, answered, workdirNow)
      settleSession(session, answered, livePending.keepSession)
      return payload
    }
    injectToken(session)
    // 输入本身不带结束标记，必须额外回显 marker，否则只能空等到超时
    const marker = newMarker()
    writeCommand(session, input, marker, true, false)
    const result = await readUntilMarker(session, marker, yieldTimeMs, waitFor)
    const currentWorkdir = await resolveCurrentWorkdir(session, result)
    return formatExecResult(session, result, currentWorkdir)
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
