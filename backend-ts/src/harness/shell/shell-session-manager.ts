import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { harnessLog } from '../log.js';
import { GitCredentialService } from '../../user/git-credential.service.js';
import { ASKPASS } from '../../file/git-write-operation.service.js';

export class ShellSession {
  readonly createdAt = Date.now();
  lastActiveAt = Date.now();
  alive = true;
  currentWorkdir: string;
  commandCount = 0;
  private leftover = '';

  constructor(
    readonly sessionId: string,
    readonly conversationId: number | null,
    readonly process: ChildProcessWithoutNullStreams,
    readonly workspaceDir: string,
    readonly outputFile: string,
  ) {
    this.currentWorkdir = workspaceDir;
    this.process.stdout.setEncoding('utf8');
    this.process.stderr.setEncoding('utf8');
    this.process.stdin.on('error', (error) => this.handleProcessError('stdin', error));
    this.process.stdout.on('error', (error) => this.handleProcessError('stdout', error));
    this.process.stderr.on('error', (error) => this.handleProcessError('stderr', error));
    this.process.on('error', (error) => this.handleProcessError('process', error));
  }

  private handleProcessError(source: string, error: Error): void {
    if (this.alive) {
      harnessLog('warn', `Shell session ${this.sessionId} ${source} error: ${error.message}`);
    }
  }

  touch(): void {
    this.lastActiveAt = Date.now();
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

  close(): void {
    if (!this.alive) return;
    this.alive = false;
    try {
      this.process.kill('SIGKILL');
    } catch { /* ignore */ }
    try {
      this.process.stdin.end();
    } catch { /* ignore */ }
    harnessLog('info', `Closed shell session: ${this.sessionId}`);
  }

  drainChunk(): string {
    const chunk = this.leftover;
    this.leftover = '';
    return chunk;
  }

  appendLeftover(text: string): void {
    this.leftover += text;
  }
}

export interface OutputResult {
  output: string;
  truncated: boolean;
  completed: boolean;
  elapsedMs: number;
}

export class OutputManager {
  constructor(
    private readonly maxPreviewLines = 100,
    private readonly maxPreviewChars = 10000,
  ) {}

  async readUntilMarker(
    session: ShellSession,
    marker: string,
    timeoutMs: number,
  ): Promise<OutputResult> {
    const start = Date.now();
    const deadline = start + timeoutMs;
    let full = session.drainChunk();
    let completed = false;

    const consume = (chunk: string) => {
      full += chunk;
      try {
        appendFileSync(session.outputFile, chunk);
      } catch { /* ignore */ }
    };

    if (full.includes(marker)) completed = true;

    await new Promise<void>((resolve) => {
      if (completed) {
        resolve();
        return;
      }
      const onData = (data: string | Buffer) => {
        consume(typeof data === 'string' ? data : data.toString('utf8'));
        if (full.includes(marker) || !session.isAlive()) {
          cleanup();
          resolve();
        }
      };
      const onEnd = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        session.process.stdout.off('data', onData);
        session.process.stdout.off('end', onEnd);
        session.process.off('exit', onEnd);
        clearInterval(timer);
      };
      session.process.stdout.on('data', onData);
      session.process.stdout.on('end', onEnd);
      session.process.on('exit', onEnd);
      const timer = setInterval(() => {
        if (Date.now() >= deadline || !session.isAlive()) {
          cleanup();
          resolve();
        }
      }, 50);
    });

    const idx = full.indexOf(marker);
    if (idx >= 0) {
      completed = true;
      const after = full.slice(idx + marker.length);
      full = full.slice(0, idx);
      if (after) session.appendLeftover(after.replace(/^\r?\n/, ''));
    }
    const preview = this.preview(full);
    return {
      output: preview.text,
      truncated: preview.truncated,
      completed,
      elapsedMs: Date.now() - start,
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
      shellSessionId = `sh-${conversationId}-${Date.now()}`;
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
        this.sessions.delete(sessionId);
        session.close();
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
    this.configureUserHome(env, userId);
    if (domainTokenMap && Object.keys(domainTokenMap).length > 0) {
      this.configureGitCredentials(env, uid, conversationId, domainTokenMap);
    }
    const child = spawn('bash', ['--norc', '--noprofile'], {
      cwd: workDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (child.stderr && child.stdout) {
      child.stderr.pipe(child.stdout as unknown as NodeJS.WritableStream);
    }
    return new ShellSession(shellSessionId, conversationId, child, workDir, outputFile);
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
