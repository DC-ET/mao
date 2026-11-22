import { harnessLog } from '../log.js';
import type { TerminalHostAvailability } from '@mao/contracts';
import type { TerminalSocket, TerminalWsJwt } from './terminal-ws-handler.js';
import { TERMINAL_WS_OPEN } from './terminal-ws-handler.js';
import type { TerminalHostIdentity } from './local-terminal-relay.js';

/**
 * `/api/ws/terminal-host` 的主机连接管理（技术方案 2026-11-18-local-terminal-remote §4.5）。
 *
 * 主机是绑定设备上的 Electron 主进程或 mao-agent 进程（PTY 在那台机器上）。
 * 同一 `(userId, deviceId)` 只有一条活跃主机：Electron 优先于 CLI，同级 / 跨级替换按
 * D12 的规则；断线 60 秒内同设备重连按 auth.terminals 对账，对不上的关闭（HOST_LOST）。
 * 终端的 CREATE / HOST_LOST 审计由中继登记表的关闭路径统一记录，主机连接本身不记审计。
 */

/** 设备 id 白名单：与会话绑定 targetDeviceId 的校验一致（长度 ≤64）。 */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 活跃主机断开后等待同设备重连的宽限时长。 */
export const HOST_GRACE_MS = 60_000;

export type TerminalHostClient = 'electron' | 'cli';

/** 中继登记表需要的回调（LocalTerminalRelay 实现全部方法）。帧回调带来源主机身份，
 *  relay 据此校验归属——跨设备 / 跨用户的 terminalId 注入在登记表就被丢弃。 */
export interface TerminalHostRelayCallbacks {
  handleOpened(host: TerminalHostIdentity, frame: { terminalId: string; shell: string; cwd: string }): void;
  handleOpenFailed(host: TerminalHostIdentity, frame: { terminalId: string; code: string }): void;
  handleHostOutput(host: TerminalHostIdentity, terminalId: string, data: string): void;
  handleHostExit(host: TerminalHostIdentity, terminalId: string, exitCode: number): void;
  reconcileForDevice(userId: number, deviceId: string, terminalIds: ReadonlySet<string>): void;
  handleHostLost(userId: number, deviceId: string): void;
  failPendingForDevice(userId: number, deviceId: string): void;
}

/** 该设备存活的流连接类型集合（终端主机可用性状态机只看这个，不读文件代理能力）。 */
export interface TerminalHostStreamTypes {
  listDeviceClientTypes(userId: number, deviceId: string): Array<TerminalHostClient>;
}

export interface TerminalHostHandlerDeps {
  jwtService: TerminalWsJwt;
  relay: TerminalHostRelayCallbacks;
  streamTypes: TerminalHostStreamTypes;
  /** 主机可用状态跃迁时回调（装配层接到 device_status 广播）。 */
  onStatusChanged?: (userId: number, deviceId: string) => void;
  graceMs?: number;
}

interface HostConn {
  socket: TerminalSocket;
  userId: number;
  deviceId: string;
  client: TerminalHostClient;
  /** auth 帧上报的仍在跑的终端 id（对账基准）。 */
  terminals: Set<string>;
  /** 是否为该 (userId, deviceId) 的活跃主机。 */
  active: boolean;
}

/** 主机可用性快照（内存态，按 userId + deviceId）。 */
export type TerminalHostStatus = TerminalHostAvailability | null;

export class TerminalHostHandler {
  private readonly connections = new Map<string, HostConn>();
  /** key = `${userId}:${deviceId}` → 活跃主机。 */
  private readonly activeHosts = new Map<string, HostConn>();
  /** 同 key 的待命连接（当前只有 CLI 待命 Electron 的形态）。 */
  private readonly standbyHosts = new Map<string, HostConn[]>();
  /** 活跃主机断开后的宽限定时器（key → timer）。 */
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 上次广播的状态：状态值没变就不通知，避免 device_status 刷屏。 */
  private readonly lastStatus = new Map<string, TerminalHostStatus>();
  /** 未认证连接允许忽略的非 auth 帧数量（与观看端同口径）。 */
  private readonly unauthenticatedFrames = new Map<string, number>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly graceMs: number;

  constructor(private readonly deps: TerminalHostHandlerDeps) {
    this.graceMs = deps.graceMs ?? HOST_GRACE_MS;
  }

  /** 逐帧串行处理同一连接（output 高频，保持顺序即可）。 */
  handleTextMessage(socket: TerminalSocket, payload: string): Promise<void> {
    const previous = this.queues.get(socket.id) ?? Promise.resolve();
    const current = previous.then(() => this.processTextMessage(socket, payload)).catch((e) => {
      harnessLog('error', `Terminal host WS frame failed socket=${socket.id}`, e);
    });
    this.queues.set(socket.id, current);
    void current.then(() => {
      if (this.queues.get(socket.id) === current) this.queues.delete(socket.id);
    });
    return current;
  }

  private async processTextMessage(socket: TerminalSocket, payload: string): Promise<void> {
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
      if (type !== 'auth') {
        const seen = (this.unauthenticatedFrames.get(socket.id) ?? 0) + 1;
        if (seen >= 20) {
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

    switch (type) {
      case 'auth':
        // 已认证连接重复 auth：幂等忽略（不对账，避免旧列表误杀）
        return;
      case 'ping':
        this.send(socket, { type: 'pong' });
        return;
      case 'opened':
        if (conn.active) {
          this.deps.relay.handleOpened(conn, {
            terminalId: readString(root, 'terminalId'),
            shell: readString(root, 'shell'),
            cwd: readString(root, 'cwd'),
          });
        }
        return;
      case 'open_failed':
        if (conn.active) {
          this.deps.relay.handleOpenFailed(conn, {
            terminalId: readString(root, 'terminalId'),
            code: readString(root, 'code'),
          });
        }
        return;
      case 'output': {
        if (!conn.active) return;
        const data = typeof root.data === 'string' ? root.data : '';
        this.deps.relay.handleHostOutput(conn, readString(root, 'terminalId'), data);
        return;
      }
      case 'exit':
        if (conn.active) {
          const exitCode = typeof root.exitCode === 'number' && Number.isFinite(root.exitCode) ? root.exitCode : 0;
          this.deps.relay.handleHostExit(conn, readString(root, 'terminalId'), exitCode);
        }
        return;
      default:
        return;
    }
  }

  afterConnectionClosed(socket: TerminalSocket): void {
    this.unauthenticatedFrames.delete(socket.id);
    this.queues.delete(socket.id);
    const conn = this.connections.get(socket.id);
    if (!conn) return;
    this.connections.delete(socket.id);
    if (!conn.active) {
      this.removeStandby(conn);
      return;
    }
    const key = hostKey(conn.userId, conn.deviceId);
    // 已被新连接替换（4000 replaced 路径）：不触发断开语义
    if (this.activeHosts.get(key) !== conn) return;

    this.activeHosts.delete(key);

    // 待命 CLI 立即升位（§4.5）：Electron 上的旧 id 不能迁到 CLI，reconcile 会按
    // 升位方的 terminals 列表把它们关闭
    const standby = this.takeFirstStandby(key);
    if (standby != null) {
      this.establishActive(standby);
      return;
    }
    // 没有待命：60 秒宽限，等原主机带原 id 回来
    this.startGrace(key, conn.userId, conn.deviceId);
  }

  handleTransportError(socket: TerminalSocket): void {
    this.afterConnectionClosed(socket);
  }

  connectionCount(): number {
    return this.connections.size;
  }

  private handleAuth(socket: TerminalSocket, root: Record<string, unknown>): void {
    const token = typeof root.token === 'string' ? root.token : '';
    const deviceId = readString(root, 'deviceId');
    const client = readString(root, 'client');
    let userId: number | null = null;
    try {
      if (token !== '' && this.deps.jwtService.validateAccessToken(token)) {
        userId = this.deps.jwtService.getUserIdFromToken(token);
      }
    } catch {
      userId = null;
    }
    if (userId == null || !Number.isFinite(userId)
      || deviceId == null || !DEVICE_ID_PATTERN.test(deviceId)
      || (client !== 'electron' && client !== 'cli')) {
      socket.close(1003, 'Missing or invalid token');
      return;
    }
    // token 只在 auth 时校验一次（连接存活期内不复查，与 /ws/stream 现状一致）
    const terminals = new Set<string>(
      Array.isArray(root.terminals)
        ? root.terminals.filter((t): t is string => typeof t === 'string' && t !== '')
        : [],
    );
    const conn: HostConn = { socket, userId, deviceId, client, terminals, active: false };
    this.unauthenticatedFrames.delete(socket.id);
    this.connections.set(socket.id, conn);

    const key = hostKey(userId, deviceId);
    const current = this.activeHosts.get(key);
    if (current == null || current.socket.readyState !== TERMINAL_WS_OPEN) {
      // 空位（或活跃连接已半死）：本连接成为活跃主机；宽限中的重连在此归位
      if (current != null) this.demoteDeadActive(current);
      this.clearGrace(key);
      this.establishActive(conn);
      return;
    }
    if (current.client === 'electron' && client === 'cli') {
      // D12：Electron 活跃时 CLI 只能待命，不替换（PTY 不能迁进程）。
      // 此处不能 failPending：Electron 仍是活跃主机，其未应答的在途 open 会正常回应，
      // 强制失败会误报「设备离线」或留下无登记孤儿 PTY（2026-11-22 审查 BUG-2）。
      conn.active = false;
      const list = this.standbyHosts.get(key) ?? [];
      list.push(conn);
      this.standbyHosts.set(key, list);
      this.send(socket, { type: 'connected', userId, role: 'standby' });
      return;
    }
    // 被替换的活跃主机是另一个进程（同一进程不会开第二条主机连接）：
    // 它的在途 open 不会再应答，立即失败，不等 10 秒超时
    this.deps.relay.failPendingForDevice(userId, deviceId);
    // 同级替换，或 CLI 活跃时 Electron 到场顶替：旧连接 4000，新连接对账后上位
    this.activeHosts.delete(key);
    this.connections.delete(current.socket.id);
    this.closeSocket(current.socket);
    this.clearGrace(key);
    this.establishActive(conn);
  }

  /** 新活跃主机上位：对账（列表外的登记按 HOST_LOST 关闭）并回 connected。 */
  private establishActive(conn: HostConn): void {
    conn.active = true;
    const key = hostKey(conn.userId, conn.deviceId);
    this.activeHosts.set(key, conn);
    this.deps.relay.reconcileForDevice(conn.userId, conn.deviceId, conn.terminals);
    this.send(conn.socket, { type: 'connected', userId: conn.userId, role: 'active' });
    this.notifyStatus(conn.userId, conn.deviceId);
  }

  private demoteDeadActive(current: HostConn): void {
    // socket 已死：它的在途 open 不可能应答，立即失败
    this.deps.relay.failPendingForDevice(current.userId, current.deviceId);
    this.connections.delete(current.socket.id);
    this.closeSocket(current.socket);
  }

  private removeStandby(conn: HostConn): void {
    const key = hostKey(conn.userId, conn.deviceId);
    const list = this.standbyHosts.get(key);
    if (!list) return;
    const idx = list.indexOf(conn);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) this.standbyHosts.delete(key);
  }

  private takeFirstStandby(key: string): HostConn | null {
    const list = this.standbyHosts.get(key);
    if (!list || list.length === 0) return null;
    const next = list.shift()!;
    if (list.length === 0) this.standbyHosts.delete(key);
    // 注意：连接仍在 connections map 里（socket 活着），升位只改角色——
    // 删掉会导致它的后续帧被当成未认证（20 帧后 1003 断开）
    return next;
  }

  private startGrace(key: string, userId: number, deviceId: string): void {
    this.clearGrace(key);
    const timer = setTimeout(() => {
      this.graceTimers.delete(key);
      harnessLog('info', `Terminal host grace expired userId=${userId} device=${deviceId}`);
      this.deps.relay.handleHostLost(userId, deviceId);
      this.notifyStatus(userId, deviceId);
    }, this.graceMs);
    timer.unref?.();
    this.graceTimers.set(key, timer);
    this.notifyStatus(userId, deviceId);
  }

  private clearGrace(key: string): void {
    const timer = this.graceTimers.get(key);
    if (timer == null) return;
    clearTimeout(timer);
    this.graceTimers.delete(key);
  }

  /**
   * 主机可用性状态机（§4.5 表）：enabled / grace(null) / unsupported / upgrade-cli /
   * upgrade-either。grace 与「无流连接」都返回 null（离线文案），不单独暴露宽限细节。
   */
  getStatus(userId: number, deviceId: string): TerminalHostStatus {
    const key = hostKey(userId, deviceId);
    const active = this.activeHosts.get(key);
    if (active != null && active.socket.readyState === TERMINAL_WS_OPEN) return 'enabled';
    if (this.graceTimers.has(key)) return null;
    const types = this.deps.streamTypes.listDeviceClientTypes(userId, deviceId);
    const hasElectron = types.includes('electron');
    const hasCli = types.includes('cli');
    if (hasElectron && hasCli) return 'upgrade-either';
    if (hasElectron) return 'unsupported';
    if (hasCli) return 'upgrade-cli';
    return null;
  }

  /** 供 relay 判定「能否立即 open」。 */
  hasActiveHost(userId: number, deviceId: string): boolean {
    const active = this.activeHosts.get(hostKey(userId, deviceId));
    return active != null && active.socket.readyState === TERMINAL_WS_OPEN;
  }

  /** 向活跃主机定向发帧：无活跃主机 / 连接不可写时返回 false。 */
  sendToHost(userId: number, deviceId: string, frame: Record<string, unknown>): boolean {
    const active = this.activeHosts.get(hostKey(userId, deviceId));
    if (!active || active.socket.readyState !== TERMINAL_WS_OPEN) return false;
    try {
      active.socket.send(JSON.stringify(frame));
      return true;
    } catch (e) {
      harnessLog('warn', `Failed to send frame to terminal host device=${deviceId}`, e);
      return false;
    }
  }

  /** 服务端关停（closeApp）时清空状态；不主动杀主机上的 PTY，由主机对账收敛。 */
  closeAll(): void {
    for (const [, timer] of this.graceTimers) clearTimeout(timer);
    this.graceTimers.clear();
    for (const [, conn] of [...this.connections]) {
      this.closeSocket(conn.socket);
    }
    this.connections.clear();
    this.activeHosts.clear();
    this.standbyHosts.clear();
    this.lastStatus.clear();
  }

  private notifyStatus(userId: number, deviceId: string): void {
    const status = this.getStatus(userId, deviceId);
    const key = hostKey(userId, deviceId);
    if (this.lastStatus.get(key) === status) return;
    this.lastStatus.set(key, status);
    this.deps.onStatusChanged?.(userId, deviceId);
  }

  private closeSocket(socket: TerminalSocket): void {
    try {
      socket.close(4000, 'replaced');
    } catch { /* 已关闭 */ }
  }

  private send(socket: TerminalSocket, payload: Record<string, unknown>): void {
    if (socket.readyState !== TERMINAL_WS_OPEN) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch (e) {
      harnessLog('warn', `Failed to send terminal host frame type=${String(payload.type)}`, e);
    }
  }
}

function hostKey(userId: number, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

function readString(root: Record<string, unknown>, key: string): string {
  const value = root[key];
  return typeof value === 'string' ? value : '';
}
