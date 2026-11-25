import { spawn, type IPty } from 'node-pty';

/** 终端输出环形缓冲：超出上限时从头部丢弃，attach 时整体回放或按序号增量回读。 */
export class OutputRingBuffer {
  private chunks: Array<{ data: string; startSeq: number; endSeq: number }> = [];
  private bytes = 0;
  private truncated = false;
  /** 已写入缓冲区末尾的累计字节序号（下一段输出的起始序号）。 */
  private nextSeq = 0;

  constructor(private readonly maxBytes: number) {}

  /**
   * 追加一段 PTY 输出；返回帧尾序号。
   * 序号是原始流的 UTF-8 字节偏移：sanitizeReplayData 会删/改字节，但 seq 永远按原始流推进。
   */
  append(data: string): number {
    if (data === '') return this.nextSeq;
    const dataBytes = Buffer.byteLength(data, 'utf8');
    const startSeq = this.nextSeq;
    this.nextSeq += dataBytes;
    this.chunks.push({ data, startSeq, endSeq: this.nextSeq });
    this.bytes += dataBytes;
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.bytes -= Buffer.byteLength(dropped.data, 'utf8');
      this.truncated = true;
    }
    // 单帧就超过上限时不能连它一起丢（否则最近输出全没、回放一片空白），
    // 只保留这一帧的尾部字节；起点序号要同步推进到被裁掉的字节之后，
    // 否则增量回放会重复或漏掉一段。
    if (this.bytes > this.maxBytes && this.chunks.length === 1) {
      const only = this.chunks[0];
      const tail = tailWithinBytes(only.data, this.maxBytes);
      const droppedBytes = Buffer.byteLength(only.data, 'utf8') - Buffer.byteLength(tail, 'utf8');
      only.data = tail;
      only.startSeq += droppedBytes;
      this.bytes = Buffer.byteLength(tail, 'utf8');
      this.truncated = true;
    }
    return this.nextSeq;
  }

  /** 当前累计序号（下一段输出的起始序号）。 */
  getSeq(): number {
    return this.nextSeq;
  }

  /** 缓冲区仍可增量回放的起点；空缓冲时等于当前序号。 */
  getStartSeq(): number {
    return this.chunks.length > 0 ? this.chunks[0].startSeq : this.nextSeq;
  }

  /** 全量回放内容；曾被截断时前置一行提示。 */
  read(): string {
    const body = this.chunks.map((c) => c.data).join('');
    if (body === '' && !this.truncated) return '';
    return this.truncated ? `\r\n[历史输出过长，已截断前面部分]\r\n${body}` : body;
  }

  /**
   * 增量回读 [fromSeq, 当前序号)；fromSeq 早于缓冲起点或超前于当前序号时返回 null（调用方走全量）。
   * 返回的 data 是原始流字节（调用方仍需 sanitizeReplayData），startSeq/endSeq 都是原始序号。
   */
  readSince(fromSeq: number): { data: string; startSeq: number; endSeq: number } | null {
    if (!Number.isInteger(fromSeq) || fromSeq < this.getStartSeq() || fromSeq > this.nextSeq) return null;
    const parts: string[] = [];
    for (const chunk of this.chunks) {
      if (chunk.endSeq <= fromSeq) continue;
      if (chunk.startSeq >= fromSeq) {
        parts.push(chunk.data);
        continue;
      }
      // fromSeq 正常是帧边界；这里防御非法输入，按 UTF-8 字节切片并对齐到字符边界
      parts.push(sliceFromBytes(chunk.data, fromSeq - chunk.startSeq));
    }
    return { data: parts.join(''), startSeq: fromSeq, endSeq: this.nextSeq };
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

/** 保留字符串末尾不超过 maxBytes 的部分，并对齐到 UTF-8 字符边界（避免切出乱码）。 */
function tailWithinBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  // 0b10xxxxxx 是 UTF-8 续字节：向后挪到首字节、丢掉被切开的半个字符。
  // 不能向前挪——那会把首字节一起带上，结果超出 maxBytes，违背本函数的用途。
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  if (start >= buf.length) {
    // 上限比单个字符还小（被配成个位数）时窗口整个落在某字符内部，向后扫会扫空。
    // 此时宁可略微超出上限也要留下最后一个完整字符，否则回放只剩一行截断提示。
    start = buf.length - 1;
    while (start > 0 && (buf[start] & 0xc0) === 0x80) start -= 1;
  }
  return buf.subarray(start).toString('utf8');
}

/** 从字符串的第 offset 个 UTF-8 字节起截取，并对齐到字符边界（避免切出乱码）。 */
function sliceFromBytes(text: string, offset: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (offset <= 0) return text;
  if (offset >= buf.length) return '';
  let start = offset;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString('utf8');
}

/** 一段实时输出的原始字节序号区间（左闭右开）。 */
export interface OutputSeq {
  seq: number;
  endSeq: number;
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
  /**
   * 中继终端标记（技术方案 2026-11-18 §4.3）：云端终端不写该字段，观看端据此区分标签。
   */
  kind?: 'local-relay';
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
  /** 触发终端创建的用户：docker 运行时据此路由到该用户容器（技术方案 §5.7.3）。 */
  userId?: number;
  /**
   * 会话 Agent（容器键第二维，2026-11-07 复合容器方案 §5.7）：终端的容器绑定在创建时
   * 定型，之后不随会话切 Agent 迁移（决策 1：随旧容器存活）。
   */
  agentId?: number;
}

/** PTY 工厂：生产用 node-pty，docker 模式返回容器桥（异步），单测注入 fake 实现。 */
export type PtyFactory = (options: SpawnPtyOptions) => PtyLike | Promise<PtyLike>;

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
  /**
   * 中继终端（技术方案 2026-11-18 D5）：PTY 跑在执行端设备上而非服务器进程，
   * attach 不校验 `terminal:use`（该权限语义是服务器 shell）。云端终端恒为 false。
   */
  skipTerminalUsePermission?: boolean;
  /** 中继终端标记：写入 toInfo().kind 供观看端区分标签。 */
  kind?: 'local-relay';
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
  readonly skipTerminalUsePermission: boolean;
  readonly kind?: 'local-relay';

  private cols: number;
  private rows: number;
  private lastActiveAt = Date.now();
  private alive = true;
  private readonly pty: PtyLike;
  private readonly buffer: OutputRingBuffer;
  /** 当前接收输出的连接（socketId → 回调）；null 表示无人 attach。 */
  private sink: { socketId: string; onOutput: (data: string, seq: OutputSeq) => void } | null = null;
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
    this.skipTerminalUsePermission = deps.skipTerminalUsePermission === true;
    this.kind = deps.kind;
    this.buffer = new OutputRingBuffer(deps.outputBufferBytes);

    this.pty.onData((data: string) => {
      this.lastActiveAt = Date.now();
      const startSeq = this.buffer.getSeq();
      this.buffer.append(data);
      this.sink?.onOutput(data, { seq: startSeq, endSeq: this.buffer.getSeq() });
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
  attach(socketId: string, onOutput: (data: string, seq: OutputSeq) => void): string | null {
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

  /** 当前输出累计字节序号（增量回放的帧尾）。 */
  getSeq(): number {
    return this.buffer.getSeq();
  }

  /** 缓冲仍可增量回放的起点。 */
  getBufferStartSeq(): number {
    return this.buffer.getStartSeq();
  }

  /** 增量回读 [fromSeq, 当前序号)；返回 null 表示 fromSeq 已滚出缓冲，调用方应全量回放。 */
  readBufferedFrom(fromSeq: number): { data: string; startSeq: number; endSeq: number } | null {
    return this.buffer.readSince(fromSeq);
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
      ...(this.kind != null ? { kind: this.kind } : {}),
    };
  }
}
