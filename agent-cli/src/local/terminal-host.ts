import fs from 'node:fs';
import WebSocket from 'ws';
import { isWorkspaceWithin } from './sandbox';

/**
 * mao-agent 的终端主机（技术方案 2026-11-18-local-terminal-remote §4.7）：
 * 连接 `/api/ws/terminal-host`，替浏览器 / 安卓 / 其它电脑在本机起 PTY。
 * 由 `local --serve` 与交互式 LOCAL 进程各启动一次；CLOUD 模式不启动。
 *
 * 与文件代理的边界（§10）：不复用 WsClient（那个类绑定 /ws/stream 的订阅与
 * capabilities）；不加入 DAEMON_ROUTED_EVENTS / acceptEvent——终端是进程级的，
 * 不按当前订阅会话过滤。node-pty 只在 spawn 时 require（optionalDependencies，
 * 编译失败时主机连接照常建立、open 一律回 SPAWN_FAILED，能力降级而非装不上）。
 */

/** 主机单帧上限：与服务器 /ws/terminal-host 的 256KB 校验一致。 */
export const HOST_FRAME_MAX_BYTES = 256 * 1024;

/**
 * 数据切片预算：JSON 信封 + 转义（控制字符最坏 6 倍）后仍必须低于 256KB 帧上限——
 * 直接按 256KB 切 data 会让序列化帧超限、被服务器拆连接。与后端 HOST_DATA_CHUNK_BYTES 同值。
 */
export const HOST_DATA_CHUNK_BYTES = 32 * 1024;
const SOCKET_BACKPRESSURE_BYTES = 1024 * 1024;
const DROPPED_NOTICE = '\r\n[输出过快，已丢弃部分内容]\r\n';
const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

/** PTY 工厂：生产用懒加载的 node-pty，测试注入假实现（§4.7）。 */
export type PtyFactory = (shell: string, cols: number, rows: number, cwd: string, env: NodeJS.ProcessEnv) => HostPtyLike;

export interface HostPtyLike {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface TerminalHostOptions {
  baseUrl: string;
  getToken: () => Promise<string | null>;
  deviceId: string;
  /** 本地信任根：cwd 必须等于它或位于其内（复用 executor 的收窄语义） */
  workspace: string;
  debug?: (msg: string) => void;
  ptyFactory?: PtyFactory;
  /** 测试注入：缺省用真实 ws 连接 */
  WebSocketImpl?: typeof WebSocket;
  heartbeatIntervalMs?: number;
}

interface RelayPty {
  pty: HostPtyLike;
  shell: string;
  cwd: string;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** 按UTF-8 字符边界切片（代理对不拆开），与服务器 / 桌面端同口径。 */
export function sliceUtf8(text: string, maxBytes: number): string[] {
  if (text === '' || maxBytes <= 0) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    let bytes = 0;
    while (end < text.length) {
      const code = text.codePointAt(end) ?? 0;
      const size = code > 0xffff ? 4 : code > 0x7ff ? 3 : code > 0x7f ? 2 : 1;
      if (bytes + size > maxBytes) break;
      bytes += size;
      end += code > 0xffff ? 2 : 1;
    }
    if (end === start) break;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks.length > 0 ? chunks : [text];
}

/** 与后端 TerminalManager._detectShell / 桌面端同一条规则。 */
export function detectShell(platform: NodeJS.Platform = process.platform): string {
  if (process.env.SHELL) return process.env.SHELL;
  return platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

function toWsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/i, 'ws').replace(/\/+$/, '')}/ws/terminal-host`;
}

export class TerminalHost {
  private readonly opts: TerminalHostOptions;
  private readonly debug?: (msg: string) => void;
  private readonly terminals = new Map<string, RelayPty>();
  private readonly dropped = new Set<string>();
  private socket: WebSocket | null = null;
  private connected = false;
  private role: 'active' | 'standby' | null = null;
  private stopped = false;
  private reconnectDelay = RECONNECT_INITIAL_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastServerMessageAt = 0;
  private ptyFactory: PtyFactory | null;

  constructor(opts: TerminalHostOptions) {
    this.opts = opts;
    this.debug = opts.debug;
    this.ptyFactory = opts.ptyFactory ?? null;
  }

  /** 懒加载 node-pty（§4.7：optionalDependencies 编译失败只降级 spawn）。 */
  private loadPtyFactory(): PtyFactory | null {
    if (this.ptyFactory != null) return this.ptyFactory;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pty = require('node-pty') as {
        spawn(shell: string, args: string[], options: Record<string, unknown>): HostPtyLike;
      };
      this.ptyFactory = (shell, cols, rows, cwd, env) =>
        pty.spawn(shell, [], { name: 'xterm-256color', cols, rows, cwd, env: env as { [key: string]: string } });
    } catch (e) {
      this.debug?.(`node-pty 不可用，远程终端主机降级为 SPAWN_FAILED：${e instanceof Error ? e.message : String(e)}`);
      this.ptyFactory = () => {
        throw new Error('node-pty unavailable');
      };
    }
    return this.ptyFactory;
  }

  start(): void {
    this.stopped = false;
    this.scheduleReconnect(0);
  }

  /** 进程退出 / REPL 关闭：杀掉全部中继 PTY（§4.7）。 */
  shutdown(): void {
    this.stopped = true;
    this.clearTimers();
    this.killAllTerminals();
    this.closeSocket(1000, 'shutdown');
  }

  terminalIds(): string[] {
    return [...this.terminals.keys()];
  }

  clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(delayMs?: number): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = delayMs ?? this.reconnectDelay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((e) => {
        this.debug?.(`terminal host connect failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async connect(): Promise<void> {
    if (this.stopped || (this.socket != null && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN))) return;
    const token = await this.opts.getToken();
    if (!token) {
      // 未登录（CLI 没有登录钩子可踢）：按退避重试，login 后 30 秒内自动连上
      this.scheduleReconnect();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      return;
    }
    const url = toWsUrl(this.opts.baseUrl);
    this.debug?.(`terminal host connect ${url}`);
    const socket = new (this.opts.WebSocketImpl ?? WebSocket)(url, { maxPayload: HOST_FRAME_MAX_BYTES });
    this.socket = socket;
    socket.on('open', () => {
      if (this.socket !== socket) return;
      this.connected = true;
      this.role = null;
      this.reconnectDelay = RECONNECT_INITIAL_MS;
      this.lastServerMessageAt = Date.now();
      // auth 首帧：terminals 带上仍活着的 id 供服务器对账（§4.9）
      this.send(socket, { type: 'auth', token, deviceId: this.opts.deviceId, client: 'cli', terminals: [...this.terminals.keys()] });
      this.startHeartbeat(socket);
    });
    socket.on('message', (raw: Buffer | string) => {
      if (this.socket !== socket) return;
      this.lastServerMessageAt = Date.now();
      const size = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.length;
      if (size > HOST_FRAME_MAX_BYTES) {
        socket.close(1009, 'frame too large');
        return;
      }
      this.handleMessage(socket, typeof raw === 'string' ? raw : raw.toString('utf8'));
    });
    socket.on('close', (code) => {
      if (this.socket !== socket) return;
      this.connected = false;
      this.role = null;
      this.stopHeartbeat();
      this.socket = null;
      // 被 4000 replaced（同机 Electron 上位）：PTY 不能迁进程，杀掉本进程 map 里的
      // 中继 PTY（§4.5/§4.7）；服务器侧登记由新主机的对账收敛为 HOST_LOST
      if (code === 4000) this.killAllTerminals();
      if (this.stopped) return;
      this.scheduleReconnect();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      if (code === 1003) this.debug?.('terminal host auth 被拒（token 过期？），等待下一次重连取新 token');
    });
    socket.on('error', () => { /* close 随后触发 */ });
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastServerMessageAt > 90_000) {
        socket.close();
        return;
      }
      this.send(socket, { type: 'ping' });
    }, this.opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private closeSocket(code: number, reason: string): void {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.role = null;
    this.stopHeartbeat();
    if (socket != null) {
      try {
        socket.close(code, reason);
      } catch {
        // ignore
      }
    }
  }

  private handleMessage(socket: WebSocket, text: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (frame.type) {
      case 'connected': {
        this.role = frame.role === 'standby' ? 'standby' : 'active';
        this.debug?.(`terminal host connected as ${this.role}`);
        return;
      }
      case 'open':
        // standby 期间不 spawn（§4.7）；active 由 handleOpen 处理
        void this.handleOpen(frame);
        return;
      case 'input':
      case 'resize':
      case 'kill':
        this.handleControl(frame);
        return;
      case 'pong':
        return;
      default:
        return;
    }
  }

  /** cwd 必须通过信任根收窄（§4.7）；目录不存在回 CWD_MISSING，不 spawn。 */
  private async handleOpen(frame: Record<string, unknown>): Promise<void> {
    const terminalId = typeof frame.terminalId === 'string' ? frame.terminalId : '';
    if (!terminalId || !this.connected || this.socket == null || this.role === 'standby') return;
    if (this.terminals.has(terminalId)) return;
    const cwd = typeof frame.cwd === 'string' && frame.cwd !== '' ? frame.cwd : '';
    if (!cwd || !isWorkspaceWithin(cwd, this.opts.workspace)) {
      this.send(this.socket, { type: 'open_failed', terminalId, code: 'CWD_MISSING' });
      return;
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(cwd);
    } catch {
      this.send(this.socket, { type: 'open_failed', terminalId, code: 'CWD_MISSING' });
      return;
    }
    if (!stat.isDirectory()) {
      this.send(this.socket, { type: 'open_failed', terminalId, code: 'CWD_MISSING' });
      return;
    }
    const cols = clampInt(frame.cols, 80, 1, 500);
    const rows = clampInt(frame.rows, 24, 1, 200);
    try {
      const shell = detectShell();
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      };
      const token = await this.opts.getToken();
      if (token) env.MAO_TOKEN = token;
      else delete env.MAO_TOKEN;
      if (this.opts.baseUrl) env.MAO_BASE_URL = this.opts.baseUrl;
      const factory = this.loadPtyFactory();
      if (factory == null) throw new Error('node-pty unavailable');
      const pty = factory(shell, cols, rows, cwd, env);
      this.terminals.set(terminalId, { pty, shell, cwd });
      pty.onData((data) => this.sendOutput(terminalId, data));
      pty.onExit(({ exitCode }) => {
        if (this.terminals.delete(terminalId)) {
          this.send(this.socket, { type: 'exit', terminalId, exitCode });
        }
      });
      this.send(this.socket, { type: 'opened', terminalId, shell, cwd });
    } catch (e) {
      this.debug?.(`spawn failed for ${terminalId}: ${e instanceof Error ? e.message : String(e)}`);
      this.send(this.socket, { type: 'open_failed', terminalId, code: 'SPAWN_FAILED' });
    }
  }

  private handleControl(frame: Record<string, unknown>): void {
    const terminalId = typeof frame.terminalId === 'string' ? frame.terminalId : '';
    const relay = this.terminals.get(terminalId);
    if (relay == null) return;
    if (frame.type === 'input') {
      if (typeof frame.data === 'string' && frame.data !== '') relay.pty.write(frame.data);
      return;
    }
    if (frame.type === 'resize') {
      try {
        relay.pty.resize(clampInt(frame.cols, 80, 1, 500), clampInt(frame.rows, 24, 1, 200));
      } catch {
        // 已退出
      }
      return;
    }
    try {
      relay.pty.kill();
    } catch {
      // 已退出
    }
    this.terminals.delete(terminalId);
    this.dropped.delete(terminalId);
    this.send(this.socket, { type: 'exit', terminalId, exitCode: 0 });
  }

  private sendOutput(terminalId: string, data: string): void {
    const socket = this.socket;
    if (socket == null || socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > SOCKET_BACKPRESSURE_BYTES) {
      this.dropped.add(terminalId);
      return;
    }
    if (this.dropped.delete(terminalId)) {
      this.send(socket, { type: 'output', terminalId, data: DROPPED_NOTICE });
    }
    for (const chunk of sliceUtf8(data, HOST_DATA_CHUNK_BYTES)) {
      this.send(socket, { type: 'output', terminalId, data: chunk });
    }
  }

  private send(socket: WebSocket | null, frame: Record<string, unknown>): void {
    if (socket == null || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch (e) {
      this.debug?.(`terminal host send failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  killAllTerminals(): void {
    for (const [terminalId, relay] of [...this.terminals.entries()]) {
      try {
        relay.pty.kill();
      } catch {
        // 已退出
      }
      this.terminals.delete(terminalId);
      this.dropped.delete(terminalId);
    }
  }
}
