import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { harnessLog } from '../log.js';
import { GitCredentialService } from '../../user/git-credential.service.js';
import { ASKPASS } from '../../file/git-write-operation.service.js';

/** 已写入 stdin 但尚未读到结束标记的命令。 */
export interface PendingCommand {
  marker: string;
  keepSession: boolean;
  /** false 表示 cd/pwd 等协议命令，输出不落盘。 */
  persist: boolean;
  /** 非空表示读取权归该后台任务，其他调用方不得直接读缓冲区。 */
  taskId: string | null;
}

/** 缓冲区上限；超限时把最旧的一段落盘后丢出内存，输出文件仍然完整。 */
const MAX_BUFFER_CHARS = 262_144;
/** 裁剪时保留的尾部长度，确保结束标记不会被切成两半。 */
const BUFFER_KEEP_TAIL_CHARS = 8192;

export class ShellSession {
  readonly createdAt = Date.now();
  lastActiveAt = Date.now();
  alive = true;
  currentWorkdir: string;
  commandCount = 0;
  /** 未读完的命令；提前放行（wait_for 命中或超时）后仍然保留，供后续续等。 */
  pendingCommand: PendingCommand | null = null;
  /** 最近一次被 finishCommand 消费的 marker：防止过期调用方把它重新登记成永不出现的假 pending。 */
  private lastConsumedMarker: string | null = null;
  private buffer = '';
  private persistedUpTo = 0;
  private emittedUpTo = 0;
  private bufferTrimmed = false;
  private waiters: Array<() => void> = [];
  private commandQueue: Promise<void> = Promise.resolve();
  private readonly userEnvironmentKeys = new Set<string>();

  constructor(
    readonly sessionId: string,
    readonly conversationId: number | null,
    readonly process: ChildProcessWithoutNullStreams,
    readonly workspaceDir: string,
    readonly outputFile: string,
    initialUserEnvironmentKeys: Iterable<string> = [],
  ) {
    for (const key of initialUserEnvironmentKeys) this.userEnvironmentKeys.add(key);
    this.currentWorkdir = workspaceDir;
    this.process.stdout.setEncoding('utf8');
    this.process.stderr.setEncoding('utf8');
    this.process.stdin.on('error', (error) => this.handleProcessError('stdin', error));
    this.process.stdout.on('error', (error) => this.handleProcessError('stdout', error));
    this.process.stderr.on('error', (error) => this.handleProcessError('stderr', error));
    this.process.on('error', (error) => this.handleProcessError('process', error));
    // 常驻读取：读取者退出后 stdout 若无监听者，Node 会直接丢弃数据，
    // 提前放行后剩下的输出（含结束标记）就再也读不到了。
    this.process.stdout.on('data', (data: string | Buffer) => this.onData(data));
    this.process.stdout.on('end', () => this.wake());
    this.process.on('exit', () => this.wake());
  }

  private handleProcessError(source: string, error: Error): void {
    if (this.alive) {
      harnessLog('warn', `Shell session ${this.sessionId} ${source} error: ${error.message}`);
    }
  }

  touch(): void {
    this.lastActiveAt = Date.now();
  }

  /** 记录一条刚写入 stdin 的命令。persist=false 用于 cd/pwd 等协议命令，其输出不落盘。 */
  beginCommand(marker: string, keepSession: boolean, persist = true, taskId: string | null = null): void {
    this.pendingCommand = { marker, keepSession, persist, taskId };
  }

  /** 缓冲区当前内容（含尚未出现的结束标记之后的部分）。 */
  peekBuffer(): string {
    return this.buffer;
  }

  /** 已被 finishCommand 消费过的 marker（供 OutputManager 防止过期调用方重新登记假 pending）。 */
  consumedMarker(): string | null {
    return this.lastConsumedMarker;
  }

  /** 已经返回给调用方的前缀长度：提前放行后续等时从这里继续。 */
  emittedBoundary(): number {
    return this.emittedUpTo;
  }

  markEmitted(end: number): void {
    if (end > this.emittedUpTo) this.emittedUpTo = end;
  }

  /** 缓冲区因超限被裁剪过：读取者据此把结果标记为 truncated。 */
  wasBufferTrimmed(): boolean {
    return this.bufferTrimmed;
  }

  /** 当前命令读到结束标记：落盘剩余可见输出，丢掉已消费的前缀。 */
  finishCommand(consumedEnd: number): void {
    if (this.pendingCommand) this.lastConsumedMarker = this.pendingCommand.marker;
    this.flushPersist(true);
    this.buffer = this.buffer.slice(consumedEnd);
    this.persistedUpTo = 0;
    this.emittedUpTo = 0;
    this.bufferTrimmed = false;
    this.pendingCommand = null;
  }

  /** 等待新输出、进程退出或超时。 */
  async waitForOutput(timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0 || !this.isAlive()) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.waiters.push(finish);
    });
  }

  private onData(data: string | Buffer): void {
    this.buffer += typeof data === 'string' ? data : data.toString('utf8');
    // 有输出即视为活跃，否则长时间只输出不被读取的命令会被空闲清理杀掉
    this.lastActiveAt = Date.now();
    this.flushPersist(false);
    this.trimBuffer();
    this.wake();
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  /**
   * 把缓冲区中「确定属于命令输出」的前缀落盘：结束标记本身及其后的退出码不能写进文件，
   * 因此未见到标记时按尾部与标记前缀的实际重叠长度回退，防止标记被切成两半后漏进文件。
   */
  private flushPersist(final: boolean): void {
    const pending = this.pendingCommand;
    if (pending && !pending.persist) return;
    const marker = pending?.marker;
    let visibleEnd: number;
    if (!marker) {
      visibleEnd = this.buffer.length;
    } else {
      const idx = this.buffer.indexOf(marker);
      visibleEnd = idx >= 0
        ? idx
        : final ? this.buffer.length : this.buffer.length - pendingMarkerTail(this.buffer, marker);
    }
    if (visibleEnd <= this.persistedUpTo) return;
    try {
      appendFileSync(this.outputFile, this.buffer.slice(this.persistedUpTo, visibleEnd));
      this.persistedUpTo = visibleEnd;
    } catch { /* ignore */ }
  }

  /** 无人读取的常驻命令（dev server）不能让缓冲区无限增长；已落盘部分可以丢，输出文件仍然完整。 */
  private trimBuffer(): void {
    if (this.buffer.length <= MAX_BUFFER_CHARS) return;
    const dropTo = Math.min(this.persistedUpTo, this.buffer.length - BUFFER_KEEP_TAIL_CHARS);
    if (dropTo <= 0) return;
    this.buffer = this.buffer.slice(dropTo);
    this.persistedUpTo -= dropTo;
    this.emittedUpTo = Math.max(0, this.emittedUpTo - dropTo);
    this.bufferTrimmed = true;
  }

  isAlive(): boolean {
    return this.alive && this.process.exitCode == null && !this.process.killed;
  }

  isIdleTimeout(timeoutMs: number): boolean {
    return Date.now() - this.lastActiveAt > timeoutMs;
  }

  isExpired(maxLifetimeMs: number): boolean {
    return Date.now() - this.createdAt > maxLifetimeMs;
  }

  incrementCommandCount(): void {
    this.commandCount++;
  }

  setCurrentWorkdir(workdir: string): void {
    this.currentWorkdir = workdir;
  }

  writeStdin(text: string): void {
    this.process.stdin.write(text);
  }

  refreshEnvironment(env: Record<string, string | null | undefined>): void {
    const nextKeys = new Set(Object.keys(env));
    const commands = [...this.userEnvironmentKeys]
      .filter((key) => !nextKeys.has(key))
      .map((key) => `unset ${key}`);
    for (const [key, value] of Object.entries(env)) {
      commands.push(value == null
        ? `unset ${key}`
        : `export ${key}='${value.replace(/'/g, "'\\''")}'`);
    }
    if (commands.length > 0) this.writeStdin(commands.join('\n') + '\n');
    this.userEnvironmentKeys.clear();
    for (const key of nextKeys) this.userEnvironmentKeys.add(key);
  }

  close(): void {
    if (!this.alive) return;
    this.alive = false;
    // 杀掉整个进程组而非仅 bash：若 bash 退出而后代（如 gradle）残留，
    // 管道不会 EOF，readUntilMarker 会一直空等。
    const pid = this.process.pid;
    if (pid != null) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch { /* group already gone */ }
    }
    try {
      this.process.kill('SIGKILL');
    } catch { /* ignore */ }
    try {
      this.process.stdin.end();
    } catch { /* ignore */ }
    // 立刻唤醒等待者，否则 readUntilMarker 会空等到 yield 超时才发现会话已关闭
    this.wake();
    harnessLog('info', `Closed shell session: ${this.sessionId}`);
  }

  async acquireCommand(): Promise<() => void> {
    const previous = this.commandQueue;
    let release!: () => void;
    this.commandQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    return release;
  }
}

export interface OutputResult {
  output: string;
  truncated: boolean;
  completed: boolean;
  elapsedMs: number;
  /** 命令的 `$?`，仅当调用方在 marker 后回显了退出码时可用。 */
  exitCode: number | null;
  /** wait_for 命中的文本；命中即提前返回，命令仍在后台继续运行。 */
  matched: string | null;
}

/** 匹配紧跟在 marker 之后被回显的 `$?`。 */
const EXIT_STATUS_PATTERN = /^[ \t]*(-?\d+)[ \t]*\r?\n?/;
/** 轮询上限：waitForOutput 已由新输出唤醒，这里只兜底超时判定。 */
const WAIT_SLICE_MS = 200;

/**
 * 缓冲区末尾与 marker 前缀重叠的长度：这段可能是刚到一半的结束标记，
 * 既不能当正文交给模型也不能落盘，等剩余字节到达再判定。
 */
function pendingMarkerTail(buffer: string, marker: string): number {
  const max = Math.min(marker.length - 1, buffer.length);
  for (let k = max; k > 0; k--) {
    if (buffer.endsWith(marker.slice(0, k))) return k;
  }
  return 0;
}

export class OutputManager {
  constructor(
    private readonly maxPreviewLines = 100,
    private readonly maxPreviewChars = 10000,
  ) {}

  /**
   * 读到结束标记、`waitFor` 命中正文、进程退出或超时为止。
   * 输出取自会话常驻缓冲区，因此提前返回后剩余输出不会丢失，可再次调用继续读。
   */
  async readUntilMarker(
    session: ShellSession,
    marker: string,
    timeoutMs: number,
    waitFor: RegExp | null = null,
  ): Promise<OutputResult> {
    const start = Date.now();
    const deadline = start + timeoutMs;
    // 直接调用（协议命令、测试）没有登记 pending，按默认落盘补登记；
    // marker 已被其他调用方消费过（finishCommand 置空了 pending）时绝不能重新登记，
    // 否则等于造出一条永不结束的假命令，把会话永久卡死。
    if (session.pendingCommand?.marker !== marker) {
      if (session.consumedMarker() === marker) {
        return {
          output: '',
          truncated: false,
          completed: true,
          elapsedMs: 0,
          exitCode: null,
          matched: null,
        };
      }
      session.beginCommand(marker, true);
    }

    let matched: string | null = null;
    let markerIndex = -1;
    while (true) {
      const buffer = session.peekBuffer();
      markerIndex = buffer.indexOf(marker);
      if (markerIndex >= 0) break;
      if (waitFor) {
        // 只在尚未返回给调用方的部分里找，避免续等时被上一次已交付的输出立刻命中。
        const hit = waitFor.exec(buffer.slice(session.emittedBoundary()));
        if (hit) {
          matched = hit[0];
          break;
        }
      }
      if (!session.isAlive()) break;
      const remain = deadline - Date.now();
      if (remain <= 0) break;
      await session.waitForOutput(Math.min(remain, WAIT_SLICE_MS));
    }

    const buffer = session.peekBuffer();
    const emitted = session.emittedBoundary();
    if (markerIndex < 0) {
      // 尾部可能是被切成两半的结束标记，留到下一次读取再判定，否则标记会漏进正文；
      // 会话已结束时不会再有后续字节，只能原样交付。
      const tail = session.isAlive() ? pendingMarkerTail(buffer, marker) : 0;
      const end = Math.max(emitted, buffer.length - tail);
      const preview = this.preview(buffer.slice(emitted, end));
      session.markEmitted(end);
      return {
        output: preview.text,
        truncated: preview.truncated || session.wasBufferTrimmed(),
        completed: false,
        elapsedMs: Date.now() - start,
        exitCode: null,
        matched,
      };
    }

    let consumed = markerIndex + marker.length;
    let exitCode: number | null = null;
    const status = EXIT_STATUS_PATTERN.exec(buffer.slice(consumed));
    if (status) {
      exitCode = Number(status[1]);
      consumed += status[0].length;
    } else {
      const newline = /^\r?\n/.exec(buffer.slice(consumed));
      if (newline) consumed += newline[0].length;
    }
    const preview = this.preview(buffer.slice(emitted, markerIndex));
    const trimmed = session.wasBufferTrimmed();
    session.finishCommand(consumed);
    return {
      output: preview.text,
      truncated: preview.truncated || trimmed,
      completed: true,
      elapsedMs: Date.now() - start,
      exitCode,
      matched: null,
    };
  }

  private preview(full: string): { text: string; truncated: boolean } {
    const lines = full.split('\n');
    let truncated = false;
    let text = full;
    if (lines.length > this.maxPreviewLines) {
      text = lines.slice(-this.maxPreviewLines).join('\n');
      truncated = true;
    }
    if (text.length > this.maxPreviewChars) {
      text = text.slice(text.length - this.maxPreviewChars);
      truncated = true;
    }
    return { text, truncated };
  }
}

export class ShellSessionManager {
  private readonly sessions = new Map<string, ShellSession>();
  private readonly conversationSessions = new Map<number, Set<string>>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly pathSandbox: { getEffectiveWorkspaceRoot(ws?: string | null): string; addAllowedRoot(root: string): void },
    private readonly runtimeDataResolver: {
      resolveShellOutputDir(userId: number, sessionId: number): string;
      resolveSessionRuntimeDir(userId: number, sessionId: number): string;
      resolveGitAskpassScript(userId: number, sessionId: number): string;
      resolveUserHomeDir(userId: number | null | undefined): string | null;
    },
    private readonly maxSessionsPerConversation = 30,
    private readonly sessionIdleTimeoutMinutes = 30,
    private readonly sessionMaxLifetimeHours = 2,
  ) {}

  refreshUserEnvironment(
    session: ShellSession,
    userId: number | null,
    domainTokenMap: Record<string, string>,
  ): void {
    const env: Record<string, string | null> = {};
    this.configureUserHome(env as NodeJS.ProcessEnv, userId);
    for (const [domain, token] of Object.entries(domainTokenMap)) {
      env[GitCredentialService.envVarNameForDomain(domain)] = token;
    }
    const uid = userId ?? 0;
    if (Object.keys(domainTokenMap).length > 0) {
      const askPassScript = this.runtimeDataResolver.resolveGitAskpassScript(uid, session.conversationId ?? 0);
      mkdirSync(path.dirname(askPassScript), { recursive: true });
      writeFileSync(askPassScript, ASKPASS, 'utf8');
      try { chmodSync(askPassScript, 0o700); } catch { /* non-posix */ }
      env.GIT_ASKPASS = askPassScript;
      env.GIT_TERMINAL_PROMPT = '0';
    } else {
      env.GIT_ASKPASS = null;
      env.GIT_TERMINAL_PROMPT = null;
    }
    session.refreshEnvironment(env);
  }

  getOrCreate(
    conversationId: number,
    shellSessionId: string | null,
    userId: number | null,
    workspace: string | null,
    domainTokenMap?: Record<string, string>,
  ): ShellSession {
    if (shellSessionId && this.sessions.has(shellSessionId)) {
      const existing = this.sessions.get(shellSessionId)!;
      if (existing.isAlive()) {
        existing.touch();
        return existing;
      }
      this.removeSession(shellSessionId);
    }
    const convSessions = this.conversationSessions.get(conversationId)
      ?? new Set<string>();
    this.conversationSessions.set(conversationId, convSessions);
    if (convSessions.size >= this.maxSessionsPerConversation) {
      throw new Error(`Maximum number of shell sessions (${this.maxSessionsPerConversation}) reached for conversation ${conversationId}. Close existing sessions first.`);
    }
    if (!shellSessionId) {
      // 毫秒时间戳在并行工具调用下会同毫秒撞车，追加随机段保证唯一
      shellSessionId = `sh-${conversationId}-${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    }
    const session = this.createSession(shellSessionId, conversationId, userId, workspace, domainTokenMap);
    this.sessions.set(shellSessionId, session);
    convSessions.add(shellSessionId);
    harnessLog('info', `Created shell session: ${shellSessionId} for conversation: ${conversationId}`);
    return session;
  }

  getSession(sessionId: string): ShellSession | null {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isAlive()) return null;
    session.touch();
    return session;
  }

  close(sessionId: string): void {
    this.removeSession(sessionId);
  }

  closeByConversation(conversationId: number): void {
    const convSessions = this.conversationSessions.get(conversationId);
    this.conversationSessions.delete(conversationId);
    if (!convSessions) return;
    for (const sessionId of convSessions) {
      const session = this.sessions.get(sessionId);
      this.sessions.delete(sessionId);
      session?.close();
    }
    harnessLog('info', `Closed ${convSessions.size} shell sessions for conversation: ${conversationId}`);
  }

  listByConversation(conversationId: number): ShellSession[] {
    const convSessions = this.conversationSessions.get(conversationId);
    if (!convSessions) return [];
    const result: ShellSession[] = [];
    for (const sessionId of convSessions) {
      const session = this.sessions.get(sessionId);
      if (session?.isAlive()) result.push(session);
    }
    return result;
  }

  startCleanup(intervalMs = 60_000): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), intervalMs);
  }

  stopCleanup(): void {
    if (!this.cleanupTimer) return;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  cleanupExpiredSessions(): void {
    const idleTimeout = this.sessionIdleTimeoutMinutes * 60_000;
    const maxLifetime = this.sessionMaxLifetimeHours * 3600_000;
    let cleaned = 0;
    for (const [sessionId, session] of [...this.sessions.entries()]) {
      if (!session.isAlive() || session.isIdleTimeout(idleTimeout) || session.isExpired(maxLifetime)) {
        this.removeSession(sessionId);
        cleaned++;
      }
    }
    if (cleaned > 0) harnessLog('info', `Cleaned up ${cleaned} expired shell sessions`);
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  private createSession(
    shellSessionId: string,
    conversationId: number,
    userId: number | null,
    workspace: string | null,
    domainTokenMap?: Record<string, string>,
  ): ShellSession {
    const workDir = this.pathSandbox.getEffectiveWorkspaceRoot(workspace);
    const uid = userId ?? 0;
    const outputDir = this.runtimeDataResolver.resolveShellOutputDir(uid, conversationId);
    mkdirSync(outputDir, { recursive: true });
    this.pathSandbox.addAllowedRoot(this.runtimeDataResolver.resolveSessionRuntimeDir(uid, conversationId));
    const outputFile = path.join(outputDir, `${shellSessionId}.out`);
    writeFileSync(outputFile, '');
    const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'dumb', PS1: '' };
    const initialUserEnvironmentKeys = new Set<string>(['HOME']);
    this.configureUserHome(env, userId);
    if (domainTokenMap && Object.keys(domainTokenMap).length > 0) {
      this.configureGitCredentials(env, uid, conversationId, domainTokenMap);
      initialUserEnvironmentKeys.add('GIT_ASKPASS');
      initialUserEnvironmentKeys.add('GIT_TERMINAL_PROMPT');
      for (const domain of Object.keys(domainTokenMap)) initialUserEnvironmentKeys.add(GitCredentialService.envVarNameForDomain(domain));
    }
    const child = spawn('bash', ['-c', 'exec 2>&1; exec bash --norc --noprofile'], {
      cwd: workDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // 独立进程组，close() 才能一次性回收 bash 的所有后代进程
      detached: true,
    });
    return new ShellSession(shellSessionId, conversationId, child, workDir, outputFile, initialUserEnvironmentKeys);
  }

  private configureUserHome(env: NodeJS.ProcessEnv, userId: number | null): void {
    const userHome = this.runtimeDataResolver.resolveUserHomeDir(userId);
    if (!userHome) return;
    mkdirSync(userHome, { recursive: true });
    try {
      chmodSync(userHome, 0o700);
    } catch { /* non-posix */ }
    env.HOME = userHome;
    this.pathSandbox.addAllowedRoot(userHome);
  }

  private configureGitCredentials(
    env: NodeJS.ProcessEnv,
    userId: number,
    sessionId: number,
    domainTokenMap: Record<string, string>,
  ): void {
    for (const [domain, token] of Object.entries(domainTokenMap)) {
      env[GitCredentialService.envVarNameForDomain(domain)] = token;
    }
    const askPassScript = this.runtimeDataResolver.resolveGitAskpassScript(userId, sessionId);
    mkdirSync(path.dirname(askPassScript), { recursive: true });
    writeFileSync(askPassScript, ASKPASS, 'utf8');
    try {
      chmodSync(askPassScript, 0o700);
    } catch { /* non-posix */ }
    env.GIT_ASKPASS = askPassScript;
    env.GIT_TERMINAL_PROMPT = '0';
  }

  private removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (session) {
      session.close();
      if (session.conversationId != null) {
        this.conversationSessions.get(session.conversationId)?.delete(sessionId);
      }
    }
  }
}
