import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { harnessLog } from '../log.js';
import {
  FrameDecoder, PendingRegistry, encodeFrame,
  type RuntimeFrame, type RuntimeRequestFrame, type RuntimeResponseFrame,
} from './runtime-channel-protocol.js';

/** 心跳间隔与未响应判定：宿主机每 30s ping，连续 3 次未回 pong 判定容器异常。 */
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_MISS_LIMIT = 3;
/** 单向帧积压上限（pty 大数据帧共用连接时的背压保护：超出即丢最旧帧）。 */
const WRITE_QUEUE_LIMIT = 512;
const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface RuntimeStatus {
  shellSessions: number;
  pendingTasks: number;
  attachedTerminals: number;
}

export interface ChannelConnection {
  readonly userId: number;
  /** 发送请求帧并等待同名 _result 响应帧。 */
  request(frame: RuntimeRequestFrame & { id: string }, timeoutMs: number): Promise<RuntimeResponseFrame>;
  /** 单向发送（pty_data / pty_resize / pty_close）。连接断开时静默丢弃。 */
  send(frame: RuntimeRequestFrame): void;
  /** 容器回收前的优雅停机：发 shutdown 帧并等待 ack。 */
  requestShutdown(timeoutMs?: number): Promise<boolean>;
  onPtyData(listener: (ptyId: string, data: string) => void): () => void;
  onPtyExit(listener: (ptyId: string, exitCode: number) => void): () => void;
  readonly alive: boolean;
  close(): void;
}

export interface RuntimeChannelServerOptions {
  /** Unix socket 根目录；每用户子目录 {channelDir}/{userId}/runtime.sock。 */
  channelDir: string;
  /** 每用户连接令牌（宿主机生成并写入用户 socket 目录，容器启动时读取回传）。 */
  tokenOf(userId: number): string | null;
  /** 容器周期上报的容器内活动状态（idle 判定依据，技术方案 §5.3.1）。 */
  onRuntimeStatus?(userId: number, status: RuntimeStatus): void;
  /** 连接断开（心跳超时/对端关闭）时回调，宿主机据此标记容器异常。 */
  onConnectionDead?(userId: number): void;
}

/**
 * 宿主机侧每用户 Unix socket server（server 角色，容器是 client）。
 *
 * 连接身份校验：Node 没有原生 SO_PEERCRED 绑定，采用「文件系统权限锚定 token」的
 * 等价方案（技术方案 §5.4 的身份要求不变，实现手段替换）——socket 与 token 文件都在
 * {channelDir}/{userId}/（目录 0700，挂载清单只把该用户自己的子目录挂进容器），
 * 容器接入时必须在 hello 帧回传 token，不匹配立即断开。socket 路径可被猜到，
 * 没有属于该用户的 token 无法通过校验；其他用户的容器看不到这个目录。
 */
export class RuntimeChannelServer {
  private readonly servers = new Map<number, Server>();
  private readonly connections = new Map<number, ConnectionImpl>();
  private stopped = false;

  constructor(private readonly opts: RuntimeChannelServerOptions) {}

  /** 确保 userId 的 socket server 在监听；返回 socket 路径（容器启动命令使用）。 */
  async ensureListening(userId: number): Promise<string> {
    this.assertRunning();
    const dir = this.userDir(userId);
    const socketPath = path.join(dir, 'runtime.sock');
    if (this.servers.has(userId)) return socketPath;
    mkdirSync(dir, { recursive: true });
    try { chmodSync(dir, 0o700); } catch { /* non-posix */ }
    if (existsSync(socketPath)) {
      // 残留 socket 文件会让 listen 报 EADDRINUSE
      rmSync(socketPath, { force: true });
    }
    const server = createServer((socket) => this.acceptConnection(userId, socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        try { chmodSync(socketPath, 0o600); } catch { /* non-posix */ }
        resolve();
      });
    });
    this.servers.set(userId, server);
    harnessLog('info', `Runtime channel server listening: userId=${userId}, path=${socketPath}`);
    return socketPath;
  }

  socketPathOf(userId: number): string {
    return path.join(this.userDir(userId), 'runtime.sock');
  }

  /** 生成并落盘用户连接 token（幂等）；容器创建时把该目录挂入容器。 */
  issueToken(userId: number): string {
    const dir = this.userDir(userId);
    mkdirSync(dir, { recursive: true });
    try { chmodSync(dir, 0o700); } catch { /* non-posix */ }
    const tokenPath = path.join(dir, '.token');
    if (existsSync(tokenPath)) {
      const existing = readFileSync(tokenPath, 'utf8').trim();
      if (existing !== '') return existing;
    }
    const token = randomUUID().replace(/-/g, '');
    writeFileSync(tokenPath, token, 'utf8');
    try { chmodSync(tokenPath, 0o600); } catch { /* non-posix */ }
    return token;
  }

  getConnection(userId: number): ChannelConnection | null {
    const conn = this.connections.get(userId);
    return conn && conn.alive ? conn : null;
  }

  /** 当前在线的用户 id 列表（运维排查用）。 */
  connectedUserIds(): number[] {
    return [...this.connections.entries()].filter(([, c]) => c.alive).map(([u]) => u);
  }

  /** 停止全部监听与连接（应用关闭时调用）。 */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const conn of [...this.connections.values()]) conn.close();
    this.connections.clear();
    await Promise.all([...this.servers.values()].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    this.servers.clear();
  }

  private assertRunning(): void {
    if (this.stopped) throw new Error('RuntimeChannelServer has been stopped');
  }

  private userDir(userId: number): string {
    return path.join(this.opts.channelDir, String(userId));
  }

  private acceptConnection(userId: number, socket: Socket): void {
    // 握手超时未完成 hello 直接断开，防半开连接占位
    const timer = setTimeout(() => {
      harnessLog('warn', `Runtime channel handshake timeout: userId=${userId}`);
      socket.destroy();
    }, HANDSHAKE_TIMEOUT_MS);
    timer.unref?.();
    const decoder = new FrameDecoder();
    const onFirstFrame = (frame: RuntimeFrame): void => {
      if (frame.type !== 'hello') {
        harnessLog('warn', `Runtime channel first frame is not hello: userId=${userId}, type=${frame.type}`);
        socket.destroy();
        return;
      }
      if (!this.tokenMatches(userId, frame.token)) {
        socket.write(encodeFrame({ v: 1, type: 'error', message: 'invalid token' }));
        harnessLog('warn', `Runtime channel token mismatch: userId=${userId}`);
        socket.destroy();
        return;
      }
      socket.write(encodeFrame({ v: 1, type: 'hello_result' }));
      clearTimeout(timer);
      let connection: ConnectionImpl | null = null;
      connection = new ConnectionImpl(userId, socket, {
        onRuntimeStatus: (status) => this.publishStatus(userId, status),
        onClosed: () => this.drop(userId, connection!),
      });
      // 单用户单连接：容器重建场景新连接接入时踢掉旧连接
      const previous = this.connections.get(userId);
      if (previous) {
        harnessLog('info', `Runtime channel replacing stale connection: userId=${userId}`);
        previous.close();
      }
      this.connections.set(userId, connection);
      socket.on('data', (chunk: Buffer) => {
        let frames: RuntimeFrame[];
        try {
          frames = decoder.push(chunk);
        } catch (e) {
          harnessLog('warn', `Runtime channel frame decode failed: ${(e as Error).message}`);
          socket.destroy();
          return;
        }
        for (const frame of frames) connection.handleFrame(frame);
      });
      harnessLog('info', `Runtime channel connected: userId=${userId}`);
    };
    socket.on('data', function firstData(chunk: Buffer): void {
      socket.off('data', firstData);
      let frames: RuntimeFrame[];
      try {
        frames = decoder.push(chunk);
      } catch (e) {
        harnessLog('warn', `Runtime channel frame decode failed: ${(e as Error).message}`);
        socket.destroy();
        return;
      }
      for (const frame of frames) onFirstFrame(frame);
    });
    socket.on('error', (e) => harnessLog('debug', `Runtime channel socket error: userId=${userId}, ${e.message}`));
  }

  private tokenMatches(userId: number, token: string): boolean {
    return token !== '' && this.opts.tokenOf(userId) === token;
  }

  private publishStatus(userId: number, status: RuntimeStatus): void {
    this.opts.onRuntimeStatus?.(userId, status);
  }

  private drop(userId: number, connection: ConnectionImpl): void {
    if (this.connections.get(userId) === connection) {
      this.connections.delete(userId);
      this.opts.onConnectionDead?.(userId);
    }
  }
}

class ConnectionImpl implements ChannelConnection {
  private readonly pending = new PendingRegistry<RuntimeResponseFrame>();
  private readonly ptyDataListeners: Array<(ptyId: string, data: string) => void> = [];
  private readonly ptyExitListeners: Array<(ptyId: string, exitCode: number) => void> = [];
  private readonly writeQueue: Buffer[] = [];
  private draining = false;
  private closed = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private missedPongs = 0;

  constructor(
    readonly userId: number,
    private readonly socket: Socket,
    private readonly hooks: {
      onRuntimeStatus(status: RuntimeStatus): void;
      onClosed(): void;
    },
  ) {
    socket.on('close', () => this.close());
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return;
      this.missedPongs += 1;
      if (this.missedPongs > HEARTBEAT_MISS_LIMIT) {
        harnessLog('warn', `Runtime channel heartbeat lost: userId=${this.userId}`);
        this.close();
        return;
      }
      this.write(encodeFrame({ v: 1, type: 'ping', id: `ping-${Date.now()}` }));
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  get alive(): boolean {
    return !this.closed && !this.socket.destroyed;
  }

  async request(frame: RuntimeRequestFrame & { id: string }, timeoutMs: number): Promise<RuntimeResponseFrame> {
    if (!this.alive) throw new Error(`Runtime channel not connected: userId=${this.userId}`);
    const wait = this.pending.register(frame.id, timeoutMs, `Runtime channel request timeout: ${frame.type}`);
    this.write(encodeFrame(frame));
    return wait;
  }

  send(frame: RuntimeRequestFrame): void {
    if (!this.alive) return;
    this.write(encodeFrame(frame));
  }

  requestShutdown(timeoutMs = 5000): Promise<boolean> {
    if (!this.alive) return Promise.resolve(false);
    const id = `shutdown-${randomUUID().slice(0, 8)}`;
    const wait = this.pending.register(id, timeoutMs, 'shutdown ack timeout');
    this.write(encodeFrame({ v: 1, type: 'shutdown', id }));
    return wait.then(() => true).catch(() => false);
  }

  onPtyData(listener: (ptyId: string, data: string) => void): () => void {
    this.ptyDataListeners.push(listener);
    return () => {
      const idx = this.ptyDataListeners.indexOf(listener);
      if (idx >= 0) this.ptyDataListeners.splice(idx, 1);
    };
  }

  onPtyExit(listener: (ptyId: string, exitCode: number) => void): () => void {
    this.ptyExitListeners.push(listener);
    return () => {
      const idx = this.ptyExitListeners.indexOf(listener);
      if (idx >= 0) this.ptyExitListeners.splice(idx, 1);
    };
  }

  handleFrame(frame: RuntimeFrame): void {
    switch (frame.type) {
      case 'pong':
        this.missedPongs = 0;
        break;
      case 'tool_result':
      case 'read_bytes_result':
      case 'mcp_result':
      case 'pty_open_result':
      case 'shutdown_ack':
        this.pending.resolve(frame.id, frame);
        break;
      case 'pty_data':
        for (const listener of [...this.ptyDataListeners]) listener(frame.ptyId, frame.data);
        break;
      case 'pty_exit':
        for (const listener of [...this.ptyExitListeners]) listener(frame.ptyId, frame.exitCode);
        break;
      case 'runtime_status':
        this.hooks.onRuntimeStatus({
          shellSessions: frame.shellSessions,
          pendingTasks: frame.pendingTasks,
          attachedTerminals: frame.attachedTerminals,
        });
        break;
      case 'error':
        harnessLog('warn', `Runtime channel peer error: userId=${this.userId}, ${frame.message}`);
        break;
      default:
        harnessLog('warn', `Runtime channel unexpected frame: userId=${this.userId}, type=${(frame as { type: string }).type}`);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.pending.failAll(new Error('Runtime channel closed'));
    try { this.socket.destroy(); } catch { /* ignore */ }
    this.hooks.onClosed();
  }

  /** 简单写队列：socket 高水位时入队，drain 后继续；超出上限丢最旧帧防内存堆积。 */
  private write(data: Buffer): void {
    if (this.closed) return;
    if (this.draining) {
      this.writeQueue.push(data);
      if (this.writeQueue.length > WRITE_QUEUE_LIMIT) this.writeQueue.shift();
      return;
    }
    const ok = this.socket.write(data);
    if (!ok) {
      this.draining = true;
      this.socket.once('drain', () => {
        this.draining = false;
        this.flushQueue();
      });
    }
  }

  private flushQueue(): void {
    while (this.writeQueue.length > 0 && !this.closed) {
      const next = this.writeQueue.shift()!;
      const ok = this.socket.write(next);
      if (!ok) {
        this.draining = true;
        this.socket.once('drain', () => {
          this.draining = false;
          this.flushQueue();
        });
        return;
      }
    }
  }
}
