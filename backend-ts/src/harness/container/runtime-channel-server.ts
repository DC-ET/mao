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
  /** 连接彻底关闭时回调一次（pty 分发器据此把在飞终端按断开收尾）。 */
  onClosed(listener: () => void): () => void;
  readonly alive: boolean;
  close(): void;
}

export interface RuntimeChannelServerOptions {
  /** Unix socket 根目录；每容器子目录 {channelDir}/{userId}/{agentId}/runtime.sock。 */
  channelDir: string;
  /** 每容器连接令牌（宿主机生成并写入容器 socket 目录，容器启动时读取回传）。 */
  tokenOf(userId: number, agentId: number): string | null;
  /** 容器周期上报的容器内活动状态（idle 判定依据，技术方案 §5.3.1）。 */
  onRuntimeStatus?(userId: number, agentId: number, status: RuntimeStatus): void;
  /**
   * 容器 agent 握手（hello）时回调，携带其运行时闭包版本（runtime-build.json 的 buildId；
   * 旧 agent 缺省 / 字段缺失时为 null）。宿主机据此记录容器内代码版本（ContainerRegistry.reportAgentHello）。
   */
  onAgentHello?(userId: number, agentId: number, info: { build: string | null }): void;
  /** 连接断开（心跳超时/对端关闭）时回调，宿主机据此标记容器异常。 */
  onConnectionDead?(userId: number, agentId: number): void;
}

/**
 * 宿主机侧每容器键 Unix socket server（server 角色，容器是 client）。
 *
 * 连接身份校验：Node 没有原生 SO_PEERCRED 绑定，采用「文件系统权限锚定 token」的
 * 等价方案（技术方案 §5.4 的身份要求不变，实现手段替换）——socket 与 token 文件都在
 * {channelDir}/{userId}/{agentId}/（目录 0700，挂载清单只把该容器自己的子目录挂进
 * 容器），容器接入时必须在 hello 帧回传 token，不匹配立即断开。socket 路径可被猜到，
 * 没有属于该容器键的 token 无法通过校验；其他用户/Agent 的容器看不到这个目录。
 */
export class RuntimeChannelServer {
  private readonly servers = new Map<string, Server>();
  private readonly connections = new Map<string, ConnectionImpl>();
  private stopped = false;

  constructor(private readonly opts: RuntimeChannelServerOptions) {}

  /** 确保 (userId, agentId) 的 socket server 在监听；返回 socket 路径（容器启动命令使用）。 */
  async ensureListening(userId: number, agentId: number): Promise<string> {
    this.assertRunning();
    const key = `${userId}:${agentId}`;
    const dir = this.userDir(userId, agentId);
    const socketPath = path.join(dir, 'runtime.sock');
    if (this.servers.has(key)) return socketPath;
    mkdirSync(dir, { recursive: true });
    try { chmodSync(dir, 0o700); } catch { /* non-posix */ }
    if (existsSync(socketPath)) {
      // 残留 socket 文件会让 listen 报 EADDRINUSE
      rmSync(socketPath, { force: true });
    }
    const server = createServer((socket) => this.acceptConnection(userId, agentId, socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        try { chmodSync(socketPath, 0o600); } catch { /* non-posix */ }
        resolve();
      });
    });
    this.servers.set(key, server);
    harnessLog('info', `Runtime channel server listening: userId=${userId}, agentId=${agentId}, path=${socketPath}`);
    return socketPath;
  }

  socketPathOf(userId: number, agentId: number): string {
    return path.join(this.userDir(userId, agentId), 'runtime.sock');
  }

  /** 生成并落盘容器连接 token（幂等）；容器创建时把该目录挂入容器。 */
  issueToken(userId: number, agentId: number): string {
    const dir = this.userDir(userId, agentId);
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

  getConnection(userId: number, agentId: number): ChannelConnection | null {
    const conn = this.connections.get(`${userId}:${agentId}`);
    return conn && conn.alive ? conn : null;
  }

  /** 当前在线的容器键列表（运维排查用），形如 ["7:5"]。 */
  connectedKeys(): string[] {
    return [...this.connections.entries()].filter(([, c]) => c.alive).map(([k]) => k);
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

  private userDir(userId: number, agentId: number): string {
    return path.join(this.opts.channelDir, String(userId), String(agentId));
  }

  private acceptConnection(userId: number, agentId: number, socket: Socket): void {
    // 握手超时未完成 hello 直接断开，防半开连接占位
    const timer = setTimeout(() => {
      harnessLog('warn', `Runtime channel handshake timeout: userId=${userId}, agentId=${agentId}`);
      socket.destroy();
    }, HANDSHAKE_TIMEOUT_MS);
    timer.unref?.();
    const decoder = new FrameDecoder();
    const onFirstFrame = (frame: RuntimeFrame): void => {
      if (frame.type !== 'hello') {
        harnessLog('warn', `Runtime channel first frame is not hello: userId=${userId}, agentId=${agentId}, type=${frame.type}`);
        socket.destroy();
        return;
      }
      if (!this.tokenMatches(userId, agentId, frame.token)) {
        socket.write(encodeFrame({ v: 1, type: 'error', message: 'invalid token' }));
        harnessLog('warn', `Runtime channel token mismatch: userId=${userId}, agentId=${agentId}`);
        socket.destroy();
        return;
      }
      // 容器内代码版本上报（可选字段）：旧 agent 缺省传 null，由宿主机按「unknown」处理
      this.opts.onAgentHello?.(userId, agentId, {
        build: typeof frame.build === 'string' && frame.build !== '' ? frame.build : null,
      });
      socket.write(encodeFrame({ v: 1, type: 'hello_result' }));
      clearTimeout(timer);
      let connection: ConnectionImpl | null = null;
      connection = new ConnectionImpl(userId, agentId, socket, {
        onRuntimeStatus: (status) => this.publishStatus(userId, agentId, status),
        onClosed: () => this.drop(userId, agentId, connection!),
      });
      // 单键单连接：容器重建场景新连接接入时踢掉旧连接（跨键互不影响）
      const previous = this.connections.get(`${userId}:${agentId}`);
      if (previous) {
        harnessLog('info', `Runtime channel replacing stale connection: userId=${userId}, agentId=${agentId}`);
        previous.close();
      }
      this.connections.set(`${userId}:${agentId}`, connection);
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
      harnessLog('info', `Runtime channel connected: userId=${userId}, agentId=${agentId}`);
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
    socket.on('error', (e) => harnessLog('debug', `Runtime channel socket error: userId=${userId}, agentId=${agentId}, ${e.message}`));
  }

  private tokenMatches(userId: number, agentId: number, token: string): boolean {
    return token !== '' && this.opts.tokenOf(userId, agentId) === token;
  }

  private publishStatus(userId: number, agentId: number, status: RuntimeStatus): void {
    this.opts.onRuntimeStatus?.(userId, agentId, status);
  }

  private drop(userId: number, agentId: number, connection: ConnectionImpl): void {
    if (this.connections.get(`${userId}:${agentId}`) === connection) {
      this.connections.delete(`${userId}:${agentId}`);
      this.opts.onConnectionDead?.(userId, agentId);
    }
  }
}

class ConnectionImpl implements ChannelConnection {
  private readonly pending = new PendingRegistry<RuntimeResponseFrame>();
  private readonly ptyDataListeners: Array<(ptyId: string, data: string) => void> = [];
  private readonly ptyExitListeners: Array<(ptyId: string, exitCode: number) => void> = [];
  private readonly closedListeners: Array<() => void> = [];
  private closedNotified = false;
  private readonly writeQueue: Buffer[] = [];
  private draining = false;
  private closed = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private missedPongs = 0;

  constructor(
    readonly userId: number,
    readonly agentId: number,
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
      // 连续 HEARTBEAT_MISS_LIMIT 次未回 pong 判定异常（§5.4：30s 一次、3 次即 90s）
      if (this.missedPongs >= HEARTBEAT_MISS_LIMIT) {
        harnessLog('warn', `Runtime channel heartbeat lost: userId=${this.userId}, agentId=${this.agentId}`);
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
    if (!this.alive) throw new Error(`Runtime channel not connected: userId=${this.userId}, agentId=${this.agentId}`);
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

  onClosed(listener: () => void): () => void {
    // 连接已关闭时同步回调：装配与连接断开竞态下订阅方不会永远等不到通知
    if (this.closed) {
      listener();
      return () => undefined;
    }
    this.closedListeners.push(listener);
    return () => {
      const idx = this.closedListeners.indexOf(listener);
      if (idx >= 0) this.closedListeners.splice(idx, 1);
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
        harnessLog('warn', `Runtime channel peer error: userId=${this.userId}, agentId=${this.agentId}, ${frame.message}`);
        break;
      default:
        harnessLog('warn', `Runtime channel unexpected frame: userId=${this.userId}, agentId=${this.agentId}, type=${(frame as { type: string }).type}`);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.pending.failAll(new Error('Runtime channel closed'));
    try { this.socket.destroy(); } catch { /* ignore */ }
    this.hooks.onClosed();
    this.notifyClosed();
  }

  /** closed 监听只通知一次（hub 可能在 close 之后仍被换绑进来）。 */
  private notifyClosed(): void {
    if (this.closedNotified) return;
    this.closedNotified = true;
    for (const listener of [...this.closedListeners]) listener();
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
