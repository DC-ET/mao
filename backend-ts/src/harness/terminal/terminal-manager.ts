import { existsSync, mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { harnessLog } from '../log.js';
import { GitCredentialService } from '../../user/git-credential.service.js';
import { ASKPASS } from '../../file/git-write-operation.service.js';
import { RemoteTerminal, nodePtyFactory, type PtyFactory, type RemoteTerminalInfo } from './remote-terminal.js';

export const DEFAULT_TERMINAL_SHELL = '/bin/bash';
export const DEFAULT_TERMINAL_COLS = 80;
export const DEFAULT_TERMINAL_ROWS = 24;
export const MIN_TERMINAL_COLS = 1;
export const MAX_TERMINAL_COLS = 500;
export const MIN_TERMINAL_ROWS = 1;
export const MAX_TERMINAL_ROWS = 200;

/** 首次创建终端时写入虚拟 HOME 的默认 rc（已存在则不覆盖）。 */
export const DEFAULT_BASHRC = `# Mao 云端终端默认配置（首次创建终端时自动生成，可自行修改；删除后会重新生成）
PS1='\\[\\e[36m\\][mao \${MAO_TASK_NAME:-task}]\\[\\e[0m\\] \\w \\$ '
alias ll='ls -alF'
alias la='ls -A'
alias ls='ls --color=auto'
alias grep='grep --color=auto'
export HISTSIZE=5000
export HISTFILESIZE=10000
`;

export interface TerminalManagerConfig {
  maxSessionsPerTask: number;
  maxSessionsGlobal: number;
  idleTimeoutMinutes: number;
  maxLifetimeHours: number;
  outputBufferBytes: number;
}

export interface TerminalPathSandbox {
  getEffectiveWorkspaceRoot(ws?: string | null): string;
  addAllowedRoot(root: string): void;
}

export interface TerminalRuntimeResolver {
  resolveGitAskpassScript(userId: number, sessionId: number): string;
  resolveUserHomeDir(userId: number | null | undefined): string | null;
}

export interface TerminalGitCredentialLookup {
  getTokenMapByUser(userId: number): Promise<Record<string, string>>;
}

export interface TerminalShellTokenIssuer {
  generateShellToken(userId: number, username: string): string;
}

export interface TerminalUserLookup {
  findById(id: number): Promise<{ id?: number; username: string } | null>;
}

/** 终端生命周期审计事件类型。 */
export type TerminalAuditEvent = 'CREATE' | 'CLOSE' | 'ATTACH' | 'RECLAIM' | 'SESSION_DELETED';

/** 终端被服务端关闭的原因，用于向仍连着的前端说明。 */
export type TerminalCloseReason = 'CLOSE' | 'RECLAIM' | 'SESSION_DELETED';

export interface TerminalAuditContext {
  ip?: string | null;
  username?: string | null;
  errorMessage?: string | null;
}

export type TerminalAuditRecorder = (
  event: TerminalAuditEvent,
  terminal: { terminalId: string; sessionId: number; userId: number },
  ctx?: TerminalAuditContext,
) => void;

/** 审计字段约定：audit_log 的 action/object_type/method/path 均 NOT NULL，SYSTEM 路径用内部伪路径。 */
export const TERMINAL_AUDIT_META: Record<
  TerminalAuditEvent,
  { action: string; method: string; path: (sessionId: number, terminalId: string) => string }
> = {
  CREATE: { action: 'CREATE', method: 'POST', path: (sessionId) => `/v1/sessions/${sessionId}/terminals` },
  CLOSE: {
    action: 'DELETE',
    method: 'DELETE',
    path: (sessionId, terminalId) => `/v1/sessions/${sessionId}/terminals/${terminalId}`,
  },
  ATTACH: { action: 'EXECUTE', method: 'WS', path: () => '/ws/terminal/attach' },
  RECLAIM: { action: 'DELETE', method: 'SYSTEM', path: () => '/internal/terminal/reclaim' },
  SESSION_DELETED: { action: 'DELETE', method: 'SYSTEM', path: () => '/internal/terminal/session-deleted' },
};

export interface CreateTerminalParams {
  sessionId: number;
  userId: number;
  workspace: string | null | undefined;
  taskName?: string | null;
  cols?: number | null;
  rows?: number | null;
  ip?: string | null;
  username?: string | null;
}

export class TerminalLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalLimitError';
  }
}

export class TerminalSpawnError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'TerminalSpawnError';
  }
}

export interface TerminalManagerDeps {
  pathSandbox: TerminalPathSandbox;
  runtimeResolver: TerminalRuntimeResolver;
  gitCredentials?: TerminalGitCredentialLookup;
  shellToken?: TerminalShellTokenIssuer;
  userLookup?: TerminalUserLookup;
  config: TerminalManagerConfig;
  audit?: TerminalAuditRecorder;
  ptyFactory?: PtyFactory;
  shell?: string;
}

/**
 * 云端终端注册表与生命周期管理。
 * 与 ShellSessionManager 并列：后者是 Agent 的非交互管道 shell，本类是用户的交互式 PTY。
 */
export class TerminalManager {
  private readonly terminals = new Map<string, RemoteTerminal>();
  private readonly sessionTerminals = new Map<number, Set<string>>();
  private readonly closeListeners: Array<(info: RemoteTerminalInfo, reason: TerminalCloseReason) => void> = [];
  /** 已占位但尚未注册成功的 terminalId：create 内有 await，靠占位避免并发突破上限。 */
  private readonly pendingCreates = new Set<string>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly ptyFactory: PtyFactory;
  private readonly shell: string;

  constructor(private readonly deps: TerminalManagerDeps) {
    this.ptyFactory = deps.ptyFactory ?? nodePtyFactory;
    this.shell = deps.shell ?? DEFAULT_TERMINAL_SHELL;
  }

  get config(): TerminalManagerConfig {
    return this.deps.config;
  }

  async create(params: CreateTerminalParams): Promise<RemoteTerminal> {
    const { sessionId, userId } = params;
    this.pruneDead();

    const perTask = this.sessionTerminals.get(sessionId)?.size ?? 0;
    if (perTask >= this.deps.config.maxSessionsPerTask) {
      throw new TerminalLimitError(`该任务的终端数量已达上限 ${this.deps.config.maxSessionsPerTask}，请先关闭已有终端`);
    }
    if (this.terminals.size + this.pendingCreates.size >= this.deps.config.maxSessionsGlobal) {
      throw new TerminalLimitError(`服务器终端总数已达上限 ${this.deps.config.maxSessionsGlobal}，请稍后再试`);
    }

    const cols = clampInt(params.cols, DEFAULT_TERMINAL_COLS, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS);
    const rows = clampInt(params.rows, DEFAULT_TERMINAL_ROWS, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS);
    const terminalId = `term-${sessionId}-${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    // 下面有 await，先占位计入上限，否则并发创建会同时通过上面的检查
    this.reserve(sessionId, terminalId);

    let pty;
    let cwd: string;
    try {
      cwd = this.deps.pathSandbox.getEffectiveWorkspaceRoot(params.workspace);
      const env = await this.buildEnv(params);
      pty = this.ptyFactory({ shell: this.shell, args: ['-i'], cwd, cols, rows, env });
    } catch (e) {
      this.release(sessionId, terminalId);
      harnessLog('error', `Failed to spawn terminal PTY for session ${sessionId}`, e);
      this.deps.audit?.('CREATE', { terminalId, sessionId, userId }, {
        ip: params.ip,
        username: params.username,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      throw new TerminalSpawnError('终端启动失败，请检查服务器日志', e);
    }

    const terminal = new RemoteTerminal({
      terminalId, sessionId, userId,
      shell: this.shell, cwd, cols, rows, pty,
      outputBufferBytes: this.deps.config.outputBufferBytes,
    });
    // 占位在创建期间被撤销（任务已删除 / 全局关停）：不再注册，直接回收刚拉起的 PTY
    if (!this.pendingCreates.delete(terminalId)) {
      terminal.close();
      throw new TerminalSpawnError('终端已被关闭，请重试');
    }
    // PTY 自行退出（用户 exit / 进程被杀）时从注册表摘除，避免僵尸条目占用上限
    terminal.onExit(() => this.forget(terminalId));

    this.terminals.set(terminalId, terminal);
    harnessLog('info', `Created remote terminal ${terminalId} (session=${sessionId}, user=${userId}, pid=${terminal.pid})`);
    this.deps.audit?.('CREATE', terminal, { ip: params.ip, username: params.username });
    return terminal;
  }

  get(terminalId: string): RemoteTerminal | null {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return null;
    if (!terminal.isAlive()) {
      this.forget(terminalId);
      return null;
    }
    return terminal;
  }

  /** 归属校验后取终端：sessionId 与 userId 都必须匹配。 */
  getOwned(terminalId: string, sessionId: number, userId: number): RemoteTerminal | null {
    const terminal = this.get(terminalId);
    if (!terminal) return null;
    if (terminal.sessionId !== sessionId || terminal.userId !== userId) return null;
    return terminal;
  }

  getOwnedByUser(terminalId: string, userId: number): RemoteTerminal | null {
    const terminal = this.get(terminalId);
    if (!terminal) return null;
    if (terminal.userId !== userId) return null;
    return terminal;
  }

  list(sessionId: number): RemoteTerminalInfo[] {
    const ids = this.sessionTerminals.get(sessionId);
    if (!ids) return [];
    const result: RemoteTerminalInfo[] = [];
    for (const id of [...ids]) {
      const terminal = this.get(id);
      if (terminal) result.push(terminal.toInfo());
    }
    return result.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 关闭终端；reason 同时决定审计事件与通知前端的原因（默认主动关闭）。 */
  close(terminalId: string, ctx?: TerminalAuditContext & { event?: TerminalCloseReason }): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return false;
    // close() 会清空 sink，快照必须在关闭前取
    const info = terminal.toInfo();
    this.forget(terminalId);
    terminal.close();
    harnessLog('info', `Closed remote terminal ${terminalId}`);
    const reason = ctx?.event ?? 'CLOSE';
    this.deps.audit?.(reason, info, ctx);
    // 主动关闭不会触发 PTY 的 onExit（kill 前已清监听器），统一由此通知 WS handler
    this.notifyClosed(info, reason);
    return true;
  }

  /** 任务被删除时级联关闭该任务的全部终端。 */
  closeBySession(sessionId: number): number {
    const ids = this.sessionTerminals.get(sessionId);
    if (!ids || ids.size === 0) return 0;
    let closed = 0;
    for (const id of [...ids]) {
      if (this.close(id, { event: 'SESSION_DELETED' })) closed++;
      // 正在创建中的占位：撤销后 create 会自行回收 PTY
      else if (this.pendingCreates.delete(id)) ids.delete(id);
    }
    if (ids.size === 0) this.sessionTerminals.delete(sessionId);
    if (closed > 0) harnessLog('info', `Closed ${closed} remote terminals for session ${sessionId}`);
    return closed;
  }

  closeAll(): void {
    for (const id of [...this.terminals.keys()]) {
      const terminal = this.terminals.get(id);
      this.terminals.delete(id);
      terminal?.close();
    }
    this.sessionTerminals.clear();
    this.pendingCreates.clear();
  }

  startCleanup(intervalMs = 60_000): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), intervalMs);
    // 定时清理不应阻止进程退出
    this.cleanupTimer.unref?.();
  }

  stopCleanup(): void {
    if (!this.cleanupTimer) return;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  /** 回收空闲超时 / 超最长存活 / 已死的终端；返回被回收的终端信息用于通知前端。 */
  cleanupExpired(): RemoteTerminalInfo[] {
    const idleTimeout = this.deps.config.idleTimeoutMinutes * 60_000;
    const maxLifetime = this.deps.config.maxLifetimeHours * 3600_000;
    const reclaimed: RemoteTerminalInfo[] = [];
    for (const [terminalId, terminal] of [...this.terminals.entries()]) {
      if (!terminal.isAlive()) {
        this.forget(terminalId);
        continue;
      }
      if (terminal.isIdleTimeout(idleTimeout) || terminal.isExpired(maxLifetime)) {
        reclaimed.push(terminal.toInfo());
        // close 内部会 notifyClosed，WS handler 据此向仍连着的前端发 TERMINAL_RECLAIMED
        this.close(terminalId, { event: 'RECLAIM' });
      }
    }
    if (reclaimed.length > 0) {
      harnessLog('info', `Reclaimed ${reclaimed.length} idle/expired remote terminals`);
    }
    return reclaimed;
  }

  /** 终端被服务端关闭时通知前端的钩子（由 WS handler 注入）。 */
  onClosed(listener: (info: RemoteTerminalInfo, reason: TerminalCloseReason) => void): void {
    this.closeListeners.push(listener);
  }

  private notifyClosed(info: RemoteTerminalInfo, reason: TerminalCloseReason): void {
    for (const listener of this.closeListeners) {
      try {
        listener(info, reason);
      } catch { /* 通知失败不影响回收 */ }
    }
  }

  size(): number {
    return this.terminals.size;
  }

  /** create 内 await 前占位，使并发创建也受上限约束。 */
  private reserve(sessionId: number, terminalId: string): void {
    this.pendingCreates.add(terminalId);
    const ids = this.sessionTerminals.get(sessionId);
    if (ids) ids.add(terminalId);
    else this.sessionTerminals.set(sessionId, new Set([terminalId]));
  }

  private release(sessionId: number, terminalId: string): void {
    this.pendingCreates.delete(terminalId);
    const ids = this.sessionTerminals.get(sessionId);
    if (!ids) return;
    ids.delete(terminalId);
    if (ids.size === 0) this.sessionTerminals.delete(sessionId);
  }

  private forget(terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    this.terminals.delete(terminalId);
    if (!terminal) return;
    this.release(terminal.sessionId, terminalId);
  }

  private pruneDead(): void {
    for (const [terminalId, terminal] of [...this.terminals.entries()]) {
      if (!terminal.isAlive()) this.forget(terminalId);
    }
  }

  private async buildEnv(params: CreateTerminalParams): Promise<NodeJS.ProcessEnv> {
    const { userId, sessionId } = params;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      MAO_TASK_NAME: normalizeTaskName(params.taskName, sessionId),
    };
    const home = this.configureUserHome(env, userId);
    if (this.deps.gitCredentials) {
      try {
        const tokenMap = await this.deps.gitCredentials.getTokenMapByUser(userId);
        if (Object.keys(tokenMap).length > 0) {
          this.configureGitCredentials(env, userId, sessionId, tokenMap);
        }
      } catch (e) {
        // Git 凭据缺失不应阻断终端创建
        harnessLog('warn', `Failed to load git credentials for user ${userId}`, e);
      }
    }
    if (this.deps.shellToken) {
      try {
        const username = params.username ?? (await this.deps.userLookup?.findById(userId))?.username;
        if (username) env.MAO_TOKEN = this.deps.shellToken.generateShellToken(userId, username);
      } catch (e) {
        harnessLog('warn', `Failed to issue MAO_TOKEN for user ${userId}`, e);
      }
    }
    if (home) this.ensureDefaultRc(home);
    return env;
  }

  /** 与 ShellSessionManager.configureUserHome 等价：HOME 指向每用户虚拟家目录。 */
  private configureUserHome(env: NodeJS.ProcessEnv, userId: number): string | null {
    const userHome = this.deps.runtimeResolver.resolveUserHomeDir(userId);
    if (!userHome) return null;
    mkdirSync(userHome, { recursive: true });
    try {
      chmodSync(userHome, 0o700);
    } catch { /* non-posix */ }
    env.HOME = userHome;
    this.deps.pathSandbox.addAllowedRoot(userHome);
    return userHome;
  }

  /** 与 ShellSessionManager.configureGitCredentials 等价：GIT_TOKEN_* + GIT_ASKPASS。 */
  private configureGitCredentials(
    env: NodeJS.ProcessEnv,
    userId: number,
    sessionId: number,
    domainTokenMap: Record<string, string>,
  ): void {
    for (const [domain, token] of Object.entries(domainTokenMap)) {
      env[GitCredentialService.envVarNameForDomain(domain)] = token;
    }
    const askPassScript = this.deps.runtimeResolver.resolveGitAskpassScript(userId, sessionId);
    mkdirSync(path.dirname(askPassScript), { recursive: true });
    writeFileSync(askPassScript, ASKPASS, 'utf8');
    try {
      chmodSync(askPassScript, 0o700);
    } catch { /* non-posix */ }
    env.GIT_ASKPASS = askPassScript;
    env.GIT_TERMINAL_PROMPT = '0';
  }

  private ensureDefaultRc(home: string): void {
    const rcPath = path.join(home, '.bashrc');
    try {
      if (existsSync(rcPath)) return;
      writeFileSync(rcPath, DEFAULT_BASHRC, 'utf8');
      try {
        chmodSync(rcPath, 0o600);
      } catch { /* non-posix */ }
    } catch (e) {
      // rc 写入失败只影响提示符美观，不阻断终端创建
      harnessLog('warn', `Failed to write default .bashrc at ${rcPath}`, e);
    }
  }
}

export function clampInt(value: number | null | undefined, fallback: number, min: number, max: number): number {
  if (value == null) return fallback;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function normalizeTaskName(taskName: string | null | undefined, sessionId: number): string {
  const trimmed = taskName?.trim();
  if (trimmed == null || trimmed === '') return `任务 ${sessionId}`;
  // 任务名进 env 后由 rc 插值到 PS1：去掉控制字符与会被 bash promptvars 展开的字符
  return trimmed.replace(/[\u0000-\u001f\u007f'`$\\]/g, '').slice(0, 60) || `任务 ${sessionId}`;
}
