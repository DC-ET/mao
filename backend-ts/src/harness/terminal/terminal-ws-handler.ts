import { harnessLog } from '../log.js';
import type { RemoteTerminalInfo } from './remote-terminal.js';
import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  clampInt,
  type TerminalAuditRecorder,
  type TerminalCloseReason,
} from './terminal-manager.js';

export const TERMINAL_WS_OPEN = 1;
/** 出站缓冲超过该字节数时丢弃输出帧，避免慢客户端把内存拖垮。 */
export const OUTPUT_BACKPRESSURE_BYTES = 1024 * 1024;
export const TERMINAL_USE_PERMISSION = 'terminal:use';
const DROPPED_NOTICE = '\r\n[输出过快，已丢弃部分内容]\r\n';

/**
 * 终端连接抽象。不复用 streaming-ws-registry 的 WsSocket：
 * 终端侧需要 bufferedAmount 做背压判断，并需要 ip 用于 attach 审计。
 */
export interface TerminalSocket {
  id: string;
  readyState: number;
  bufferedAmount: number;
  ip?: string | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type TerminalErrorCode =
  | 'TERMINAL_NOT_FOUND'
  | 'TERMINAL_FORBIDDEN'
  | 'TERMINAL_RECLAIMED'
  | 'TERMINAL_TAKEN_OVER'
  | 'BAD_REQUEST';

/** WS handler 需要的终端能力（RemoteTerminal 结构上满足；单测可注入假实现）。 */
export interface AttachableTerminal {
  readonly terminalId: string;
  readonly sessionId: number;
  readonly userId: number;
  attach(socketId: string, onOutput: (data: string) => void): string | null;
  detach(socketId: string): boolean;
  attachedSocketId(): string | null;
  readBuffered(): string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onExit(listener: (exitCode: number) => void): void;
  toInfo(): RemoteTerminalInfo;
}

export interface TerminalRegistryLike {
  get(terminalId: string): AttachableTerminal | null;
  onClosed(listener: (info: RemoteTerminalInfo, reason: TerminalCloseReason) => void): void;
}

export interface TerminalWsJwt {
  validateAccessToken(token: string): boolean;
  getUserIdFromToken(token: string): number;
  getUsernameFromToken(token: string): string;
}

export interface TerminalWsPermission {
  hasPermission(userId: number, code: string): Promise<boolean>;
}

export interface TerminalWsHandlerDeps {
  terminalManager: TerminalRegistryLike;
  jwtService: TerminalWsJwt;
  permissionService: TerminalWsPermission;
  audit?: TerminalAuditRecorder;
}

interface Connection {
  socket: TerminalSocket;
  userId: number;
  username: string | null;
  /** 该连接当前 attach 的 terminalId 集合。 */
  terminals: Set<string>;
  /** 因背压被丢帧的 terminalId，下一次可发送时补一行提示。 */
  dropped: Set<string>;
}

/** 未认证连接允许忽略的非 auth 帧数量，超出即断开，防止无凭据连接长期刷帧。 */
export const MAX_UNAUTHENTICATED_FRAMES = 20;

/**
 * `/api/ws/terminal` 的消息路由：单连接多路复用多个终端。
 * 鉴权走首帧 auth（token 不进握手 URL），attach 时再校验 terminal:use 与归属。
 */
export class TerminalWsHandler {
  private readonly connections = new Map<string, Connection>();
  /** 已注册退出监听的 terminalId，避免重复 attach 造成重复 exit 帧。 */
  private readonly exitHooked = new Set<string>();
  /** 未认证连接已忽略的帧数：达到阈值才断开，避免正常客户端因帧序抖动被踢。 */
  private readonly unauthenticatedFrames = new Map<string, number>();
  /** 每连接的处理队列：终端是字节流，attach → input 的先后顺序必须保持。 */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly deps: TerminalWsHandlerDeps) {
    this.deps.terminalManager.onClosed((info, reason) => this.handleClosed(info, reason));
  }

  /**
   * 逐帧串行处理同一连接的消息。
   * attach 内含权限查库（await），若并发处理，紧随其后的 input/resize 会先看到「未绑定」状态：
   * 既丢按键又回无意义的错误帧。串行化从根上消除该竞态。
   */
  handleTextMessage(socket: TerminalSocket, payload: string): Promise<void> {
    const previous = this.queues.get(socket.id) ?? Promise.resolve();
    const current = previous.then(() => this.processTextMessage(socket, payload)).catch((e) => {
      harnessLog('error', `Terminal WS frame failed socket=${socket.id}`, e);
    });
    this.queues.set(socket.id, current);
    void current.then(() => {
      // 队尾处理完即回收，避免 Map 无界增长
      if (this.queues.get(socket.id) === current) this.queues.delete(socket.id);
    });
    return current;
  }

  private async processTextMessage(socket: TerminalSocket, payload: string): Promise<void> {
    // 排队期间连接可能已关闭：丢弃剩余帧，避免为已消失的 socket 记账
    if (socket.readyState !== TERMINAL_WS_OPEN) return;
    let root: Record<string, unknown>;
    try {
      root = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof root.type === 'string' ? root.type : null;
    if (!type) return;

    const conn = this.connections.get(socket.id);
    if (!conn) {
      // 未认证连接只接受 auth 帧；其余帧先忽略（客户端可能在 auth 之后同 tick 连发 attach），
      // 累计超过阈值才断开，防止无凭据连接长期占用
      if (type !== 'auth') {
        const seen = (this.unauthenticatedFrames.get(socket.id) ?? 0) + 1;
        if (seen >= MAX_UNAUTHENTICATED_FRAMES) {
          this.unauthenticatedFrames.delete(socket.id);
          socket.close(1003, 'Not authenticated');
          return;
        }
        this.unauthenticatedFrames.set(socket.id, seen);
        return;
      }
      this.handleAuth(socket, root);
      return;
    }

    try {
      await this.dispatch(conn, type, root);
    } catch (e) {
      harnessLog('error', `Terminal WS handler failed for type=${type} userId=${conn.userId}`, e);
    }
  }

  afterConnectionClosed(socket: TerminalSocket): void {
    this.unauthenticatedFrames.delete(socket.id);
    this.queues.delete(socket.id);
    const conn = this.connections.get(socket.id);
    if (!conn) return;
    this.connections.delete(socket.id);
    // 断线只解绑，不杀 PTY：输出继续写入环形缓冲，重连 attach 后回放
    for (const terminalId of conn.terminals) {
      this.deps.terminalManager.get(terminalId)?.detach(socket.id);
    }
  }

  handleTransportError(socket: TerminalSocket): void {
    this.afterConnectionClosed(socket);
  }

  connectionCount(): number {
    return this.connections.size;
  }

  private handleAuth(socket: TerminalSocket, root: Record<string, unknown>): void {
    const token = typeof root.token === 'string' ? root.token : '';
    let userId: number | null = null;
    let username: string | null = null;
    try {
      if (token !== '' && this.deps.jwtService.validateAccessToken(token)) {
        userId = this.deps.jwtService.getUserIdFromToken(token);
        username = this.deps.jwtService.getUsernameFromToken(token);
      }
    } catch {
      userId = null;
    }
    if (userId == null || !Number.isFinite(userId)) {
      socket.close(1003, 'Missing or invalid token');
      return;
    }
    this.unauthenticatedFrames.delete(socket.id);
    this.connections.set(socket.id, {
      socket,
      userId,
      username,
      terminals: new Set(),
      dropped: new Set(),
    });
    this.send(socket, { type: 'connected', userId });
  }

  private async dispatch(conn: Connection, type: string, root: Record<string, unknown>): Promise<void> {
    switch (type) {
      case 'auth':
        // 已认证连接重复 auth：幂等回一帧 connected
        this.send(conn.socket, { type: 'connected', userId: conn.userId });
        return;
      case 'attach':
        await this.handleAttach(conn, root);
        return;
      case 'detach':
        this.handleDetach(conn, root);
        return;
      case 'input':
        this.handleInput(conn, root);
        return;
      case 'resize':
        this.handleResize(conn, root);
        return;
      case 'ping':
        this.send(conn.socket, { type: 'pong' });
        return;
      default:
        this.sendError(conn.socket, 'BAD_REQUEST', `不支持的消息类型: ${type}`);
    }
  }

  private async handleAttach(conn: Connection, root: Record<string, unknown>): Promise<void> {
    const terminalId = readString(root, 'terminalId');
    if (!terminalId) {
      this.sendError(conn.socket, 'BAD_REQUEST', '缺少 terminalId');
      return;
    }
    if (!(await this.deps.permissionService.hasPermission(conn.userId, TERMINAL_USE_PERMISSION))) {
      this.sendError(conn.socket, 'TERMINAL_FORBIDDEN', `无权限: ${TERMINAL_USE_PERMISSION}`, terminalId);
      return;
    }
    // 权限查库期间连接可能已关闭：afterConnectionClosed 此时看不到本次 attach，
    // 若继续绑定会把 sink 挂在死连接上（终端永不进 idle 回收，还会顶替重连后的新连接）
    if (this.connections.get(conn.socket.id) !== conn || conn.socket.readyState !== TERMINAL_WS_OPEN) return;
    const terminal = this.deps.terminalManager.get(terminalId);
    if (!terminal) {
      this.sendError(conn.socket, 'TERMINAL_NOT_FOUND', '终端不存在或已被回收', terminalId);
      return;
    }
    if (terminal.userId !== conn.userId) {
      this.sendError(conn.socket, 'TERMINAL_FORBIDDEN', '无权操作该终端', terminalId);
      return;
    }

    const previousSocketId = terminal.attach(conn.socket.id, (data) => this.sendOutput(conn.socket.id, terminalId, data));
    if (previousSocketId != null) {
      const previous = this.connections.get(previousSocketId);
      if (previous) {
        previous.terminals.delete(terminalId);
        previous.dropped.delete(terminalId);
        this.sendError(previous.socket, 'TERMINAL_TAKEN_OVER', '该终端已在其他窗口接管', terminalId);
      }
    }
    conn.terminals.add(terminalId);
    conn.dropped.delete(terminalId);
    if (!this.exitHooked.has(terminalId)) {
      this.exitHooked.add(terminalId);
      terminal.onExit((exitCode) => this.handleTerminalExit(terminalId, exitCode));
    }

    const info = terminal.toInfo();
    this.send(conn.socket, { type: 'attached', terminalId, cols: info.cols, rows: info.rows });
    const buffered = terminal.readBuffered();
    if (buffered !== '') {
      this.send(conn.socket, { type: 'output', terminalId, data: buffered });
    }
    this.deps.audit?.('ATTACH', terminal, { ip: conn.socket.ip, username: conn.username });
  }

  private handleDetach(conn: Connection, root: Record<string, unknown>): void {
    const terminalId = readString(root, 'terminalId');
    if (!terminalId) {
      this.sendError(conn.socket, 'BAD_REQUEST', '缺少 terminalId');
      return;
    }
    conn.terminals.delete(terminalId);
    conn.dropped.delete(terminalId);
    this.deps.terminalManager.get(terminalId)?.detach(conn.socket.id);
  }

  private handleInput(conn: Connection, root: Record<string, unknown>): void {
    const terminalId = readString(root, 'terminalId');
    const data = typeof root.data === 'string' ? root.data : null;
    if (!terminalId || data == null) {
      this.sendError(conn.socket, 'BAD_REQUEST', '缺少 terminalId 或 data');
      return;
    }
    const terminal = this.requireAttached(conn, terminalId);
    terminal?.write(data);
  }

  private handleResize(conn: Connection, root: Record<string, unknown>): void {
    const terminalId = readString(root, 'terminalId');
    if (!terminalId) {
      this.sendError(conn.socket, 'BAD_REQUEST', '缺少 terminalId');
      return;
    }
    const terminal = this.requireAttached(conn, terminalId);
    if (!terminal) return;
    const cols = clampInt(readNumber(root, 'cols'), DEFAULT_TERMINAL_COLS, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS);
    const rows = clampInt(readNumber(root, 'rows'), DEFAULT_TERMINAL_ROWS, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS);
    terminal.resize(cols, rows);
  }

  /** 取该连接已 attach 且归属正确的终端；否则回错误帧并返回 null。 */
  private requireAttached(conn: Connection, terminalId: string): AttachableTerminal | null {
    const terminal = this.deps.terminalManager.get(terminalId);
    if (!terminal) {
      conn.terminals.delete(terminalId);
      this.sendError(conn.socket, 'TERMINAL_NOT_FOUND', '终端不存在或已被回收', terminalId);
      return null;
    }
    if (terminal.userId !== conn.userId || !conn.terminals.has(terminalId)) {
      this.sendError(conn.socket, 'TERMINAL_FORBIDDEN', '终端未绑定到当前连接', terminalId);
      return null;
    }
    return terminal;
  }

  private sendOutput(socketId: string, terminalId: string, data: string): void {
    const conn = this.connections.get(socketId);
    if (!conn) return;
    if (conn.socket.readyState !== TERMINAL_WS_OPEN) return;
    if (conn.socket.bufferedAmount > OUTPUT_BACKPRESSURE_BYTES) {
      conn.dropped.add(terminalId);
      return;
    }
    const payload = conn.dropped.delete(terminalId) ? `${DROPPED_NOTICE}${data}` : data;
    this.send(conn.socket, { type: 'output', terminalId, data: payload });
  }

  private handleTerminalExit(terminalId: string, exitCode: number): void {
    this.exitHooked.delete(terminalId);
    for (const conn of this.connections.values()) {
      if (!conn.terminals.delete(terminalId)) continue;
      conn.dropped.delete(terminalId);
      this.send(conn.socket, { type: 'exit', terminalId, exitCode });
    }
  }

  /** 服务端主动关闭（REST DELETE / 回收 / 任务删除）：PTY 的 onExit 不会触发，由此统一收敛状态。 */
  private handleClosed(info: RemoteTerminalInfo, reason: TerminalCloseReason): void {
    this.exitHooked.delete(info.terminalId);
    const message = reason === 'SESSION_DELETED' ? '任务已删除，终端已关闭'
      : reason === 'RECLAIM' ? '终端因空闲或超时已被回收'
      : '终端已关闭';
    for (const conn of this.connections.values()) {
      if (!conn.terminals.delete(info.terminalId)) continue;
      conn.dropped.delete(info.terminalId);
      this.sendError(conn.socket, 'TERMINAL_RECLAIMED', message, info.terminalId);
    }
  }

  private sendError(socket: TerminalSocket, code: TerminalErrorCode, message: string, terminalId?: string): void {
    this.send(socket, terminalId == null ? { type: 'error', code, message } : { type: 'error', terminalId, code, message });
  }

  private send(socket: TerminalSocket, payload: Record<string, unknown>): void {
    if (socket.readyState !== TERMINAL_WS_OPEN) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch (e) {
      harnessLog('warn', `Failed to send terminal WS frame type=${String(payload.type)}`, e);
    }
  }
}

function readString(root: Record<string, unknown>, key: string): string | null {
  const value = root[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function readNumber(root: Record<string, unknown>, key: string): number | null {
  const value = root[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
