import { spawn, type IPty } from 'node-pty';

/** 终端输出环形缓冲：超出上限时从头部丢弃，attach 时整体回放。 */
export class OutputRingBuffer {
  private chunks: string[] = [];
  private bytes = 0;
  private truncated = false;

  constructor(private readonly maxBytes: number) {}

  append(data: string): void {
    if (data === '') return;
    this.chunks.push(data);
    this.bytes += Buffer.byteLength(data, 'utf8');
    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      const dropped = this.chunks.shift()!;
      this.bytes -= Buffer.byteLength(dropped, 'utf8');
      this.truncated = true;
    }
  }

  /** 回放内容；曾被截断时前置一行提示。 */
  read(): string {
    const body = this.chunks.join('');
    if (body === '') return '';
    return this.truncated ? `\r\n[历史输出过长，已截断前面部分]\r\n${body}` : body;
  }

  isEmpty(): boolean {
    return this.chunks.length === 0;
  }

  clear(): void {
    this.chunks = [];
    this.bytes = 0;
    this.truncated = false;
  }
}

export interface RemoteTerminalInfo {
  terminalId: string;
  sessionId: number;
  userId: number;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  lastActiveAt: number;
  attached: boolean;
}

export interface PtyLike {
  readonly pid: number;
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface SpawnPtyOptions {
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

/** PTY 工厂：生产用 node-pty，单测注入 fake 实现。 */
export type PtyFactory = (options: SpawnPtyOptions) => PtyLike;

export const nodePtyFactory: PtyFactory = (options) => {
  const pty: IPty = spawn(options.shell, options.args, {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env as { [key: string]: string },
  });
  return pty as unknown as PtyLike;
};

export interface RemoteTerminalDeps {
  terminalId: string;
  sessionId: number;
  userId: number;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  pty: PtyLike;
  outputBufferBytes: number;
}

/**
 * 一个云端交互式终端：包装 PTY 进程 + 输出环形缓冲 + attach 状态。
 * 断线时只解绑 sink，PTY 输出继续写入缓冲，避免子进程被输出缓冲阻塞。
 */
export class RemoteTerminal {
  readonly terminalId: string;
  readonly sessionId: number;
  readonly userId: number;
  readonly shell: string;
  readonly cwd: string;
  readonly createdAt = Date.now();

  private cols: number;
  private rows: number;
  private lastActiveAt = Date.now();
  private alive = true;
  private readonly pty: PtyLike;
  private readonly buffer: OutputRingBuffer;
  /** 当前接收输出的连接（socketId → 回调）；null 表示无人 attach。 */
  private sink: { socketId: string; onOutput: (data: string) => void } | null = null;
  private exitListeners: Array<(exitCode: number) => void> = [];

  constructor(deps: RemoteTerminalDeps) {
    this.terminalId = deps.terminalId;
    this.sessionId = deps.sessionId;
    this.userId = deps.userId;
    this.shell = deps.shell;
    this.cwd = deps.cwd;
    this.cols = deps.cols;
    this.rows = deps.rows;
    this.pty = deps.pty;
    this.buffer = new OutputRingBuffer(deps.outputBufferBytes);

    this.pty.onData((data: string) => {
      this.lastActiveAt = Date.now();
      this.buffer.append(data);
      this.sink?.onOutput(data);
    });
    this.pty.onExit(({ exitCode }) => {
      this.alive = false;
      for (const listener of this.exitListeners) {
        try {
          listener(exitCode);
        } catch { /* 监听器异常不影响其它监听器 */ }
      }
      this.exitListeners = [];
    });
  }

  get pid(): number {
    return this.pty.pid;
  }

  isAlive(): boolean {
    return this.alive;
  }

  isAttached(): boolean {
    return this.sink != null;
  }

  attachedSocketId(): string | null {
    return this.sink?.socketId ?? null;
  }

  onExit(listener: (exitCode: number) => void): void {
    this.exitListeners.push(listener);
  }

  /** 绑定输出接收方；返回被顶替的旧 socketId（无则 null）。 */
  attach(socketId: string, onOutput: (data: string) => void): string | null {
    const previous = this.sink != null && this.sink.socketId !== socketId ? this.sink.socketId : null;
    this.sink = { socketId, onOutput };
    this.touch();
    return previous;
  }

  /** 解绑指定连接；socketId 不匹配时不动作（避免重连后被旧连接的 close 误解绑）。 */
  detach(socketId: string): boolean {
    if (this.sink == null || this.sink.socketId !== socketId) return false;
    this.sink = null;
    return true;
  }

  /** attach 后回放历史输出。 */
  readBuffered(): string {
    return this.buffer.read();
  }

  write(data: string): void {
    if (!this.alive) return;
    this.touch();
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.alive) return;
    this.cols = cols;
    this.rows = rows;
    this.touch();
    try {
      this.pty.resize(cols, rows);
    } catch { /* PTY 已退出时 resize 抛错，忽略 */ }
  }

  touch(): void {
    this.lastActiveAt = Date.now();
  }

  isIdleTimeout(timeoutMs: number): boolean {
    // attach 中的终端视为活跃：用户可能只在看输出（如 tail -f）而不敲键
    if (this.sink != null) return false;
    return Date.now() - this.lastActiveAt > timeoutMs;
  }

  isExpired(maxLifetimeMs: number): boolean {
    return Date.now() - this.createdAt > maxLifetimeMs;
  }

  close(): void {
    this.sink = null;
    this.exitListeners = [];
    this.buffer.clear();
    if (!this.alive) return;
    this.alive = false;
    try {
      // node-pty kill 会回收 PTY 会话内的后代进程，无需额外 kill(-pid)
      this.pty.kill();
    } catch { /* 已退出 */ }
  }

  toInfo(): RemoteTerminalInfo {
    return {
      terminalId: this.terminalId,
      sessionId: this.sessionId,
      userId: this.userId,
      shell: this.shell,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      attached: this.sink != null,
    };
  }
}
