import { randomUUID } from 'node:crypto';
import { harnessLog } from '../log.js';
import {
  RemoteTerminal,
  type PtyLike,
  type RemoteTerminalInfo,
} from './remote-terminal.js';
import {
  TerminalLimitError,
  type TerminalAuditContext,
  type TerminalAuditRecorder,
  type TerminalCloseReason,
  type TerminalManagerConfig,
} from './terminal-manager.js';
import type { TerminalHostAvailability } from '@mao/contracts';

/**
 * 本地任务中继终端（技术方案 2026-11-18-local-terminal-remote §4.3）。
 *
 * PTY 跑在绑定设备的 Electron 主进程或 mao-agent 进程上，服务器只登记、转发、回放。
 * 登记记录复用 `RemoteTerminal`：传入桥接 `PtyLike`（write/resize/kill 变成发往主机的帧，
 * 主机的 output/exit 由 TerminalHostHandler 调回桥上），环形缓冲、attach 接管、
 * 空闲回收与云端终端共用同一套实现。
 */

/** 主机 `open` 失败码（与 §4.5 帧表一致）。 */
export type RelayOpenFailureCode = 'CWD_MISSING' | 'SPAWN_FAILED';

/** 主机帧上限：单帧 UTF-8 256KB（服务器在 /ws/terminal-host 上按此校验，超限整条断开）。 */
export const HOST_FRAME_MAX_BYTES = 256 * 1024;

/**
 * 数据切片预算：JSON 信封（type/terminalId 字段）加转义（控制字符最坏 6 倍）后
 * 仍必须低于 256KB 帧上限——直接按 256KB 切 data 会让序列化帧超限、被两端拆连接。
 */
export const HOST_DATA_CHUNK_BYTES = 32 * 1024;

/** 向 `open` 应答的等待上限：超时视为失败，占位释放。 */
export const RELAY_OPEN_TIMEOUT_MS = 10_000;

export class RelayOpenError extends Error {
  constructor(message: string, readonly failureCode?: RelayOpenFailureCode | 'TIMEOUT') {
    super(message);
    this.name = 'RelayOpenError';
  }
}

/** 终端主机链路：由 TerminalHostHandler 实现，relay 只按 (userId, deviceId) 定向。 */
export interface TerminalHostLink {
  /** 该 (userId, deviceId) 是否有活跃主机连接（能接收 open）。 */
  hasActiveHost(userId: number, deviceId: string): boolean;
  /** 向活跃主机发一帧；无活跃主机或连接不可写时返回 false。 */
  sendToHost(userId: number, deviceId: string, frame: Record<string, unknown>): boolean;
}

/** 帧来源主机身份：relay 侧据此校验帧归属，防跨设备 / 跨用户的 id 注入。 */
export interface TerminalHostIdentity {
  userId: number;
  deviceId: string;
}

/** 主机可用性的语义化状态：relay 创建时据此给出 §5 的固定文案。 */
export interface TerminalHostStatusResolver {
  /**
   * 返回 `null` 表示「设备离线 / 宽限中」——与离线共用文案，不区分暴露宽限细节。
   */
  resolve(userId: number, deviceId: string): TerminalHostAvailability | null;
}

export interface LocalTerminalRelayDeps {
  /** 只读配额来源：云端与中继共用 `terminal.*` 上限（D8）。 */
  terminalManager: { occupiedCount(): number; countForSession(sessionId: number): number };
  config: TerminalManagerConfig;
  host: TerminalHostLink;
  hostStatus?: TerminalHostStatusResolver;
  audit?: TerminalAuditRecorder;
  openTimeoutMs?: number;
}

interface PendingRelay {
  sessionId: number;
  userId: number;
  deviceId: string;
  cwd: string;
  cols: number;
  rows: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (terminal: RemoteTerminal) => void;
  reject: (e: RelayOpenError) => void;
}

/** 桥接 PtyLike：把 RemoteTerminal 的字节操作翻译成发往主机的帧。 */
class RelayPtyBridge implements PtyLike {
  /** 服务器上没有这个进程，日志以 terminalId 标识，pid 记 0 不假装存在。 */
  readonly pid = 0;

  private onOutputCb: ((data: string) => void) | null = null;
  private onExitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;

  constructor(
    private readonly terminalId: string,
    private readonly userId: number,
    private readonly deviceId: string,
    private readonly host: TerminalHostLink,
  ) {}

  onData(cb: (data: string) => void): unknown {
    this.onOutputCb = cb;
    return cb;
  }

  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown {
    this.onExitCb = cb;
    return cb;
  }

  write(data: string): void {
    // 观看端粘贴可能很大：按数据预算切片（32KB），JSON 信封 + 转义后仍低于 256KB 帧上限
    for (const chunk of sliceUtf8(data, HOST_DATA_CHUNK_BYTES)) {
      this.host.sendToHost(this.userId, this.deviceId, { type: 'input', terminalId: this.terminalId, data: chunk });
    }
  }

  resize(cols: number, rows: number): void {
    this.host.sendToHost(this.userId, this.deviceId, { type: 'resize', terminalId: this.terminalId, cols, rows });
  }

  kill(): void {
    // reason 由服务器登记的关闭事件决定；桥上统一发 CLOSE，登记侧原因记录在服务器
    this.host.sendToHost(this.userId, this.deviceId, { type: 'kill', terminalId: this.terminalId, reason: 'CLOSE' });
  }

  /** TerminalHostHandler 调回：主机 output 帧 → 环形缓冲 + attach 的观看端。 */
  emitOutput(data: string): void {
    this.onOutputCb?.(data);
  }

  /** 主机 exit 帧 → RemoteTerminal 的 onExit 链（摘除登记 + 通知观看端）。 */
  emitExit(exitCode: number): void {
    this.onExitCb?.({ exitCode });
  }
}

/** 按 UTF-8 字符边界切片：代理对（4 字节）不拆开，避免切出乱码。 */
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
    // 单个字符就超过 maxBytes（配置错误）：宁可整段不切也不能死循环
    if (end === start) break;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks.length > 0 ? chunks : [text];
}

/**
 * 中继终端注册表：自己的 map / pending / 生命周期，与 TerminalManager 并列。
 * 配额合并计数、观看通道由目录门面（get = cloud ?? relay）在装配层拼起来。
 */
export class LocalTerminalRelay {
  private readonly relays = new Map<string, RemoteTerminal>();
  private readonly sessionRelays = new Map<number, Set<string>>();
  private readonly pending = new Map<string, PendingRelay>();
  /** terminalId → 桥接 PtyLike（handleHostOutput/Exit 经它回调 RemoteTerminal）。 */
  private readonly bridges = new Map<string, RelayPtyBridge>();
  /** 中继终端的归属设备（RemoteTerminal 不带该字段，桥接帧定向要用）。 */
  private readonly terminalDevices = new Map<string, string>();
  private readonly closeListeners: Array<(info: RemoteTerminalInfo, reason: TerminalCloseReason) => void> = [];
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly openTimeoutMs: number;

  constructor(private readonly deps: LocalTerminalRelayDeps) {
    this.openTimeoutMs = deps.openTimeoutMs ?? RELAY_OPEN_TIMEOUT_MS;
  }

  get config(): TerminalManagerConfig {
    return this.deps.config;
  }

  /** 创建中继终端：向主机发 open 并等应答（10 秒超时）。 */
  async create(params: {
    sessionId: number;
    userId: number;
    deviceId: string;
    workspace: string | null | undefined;
    cols?: number | null;
    rows?: number | null;
    ip?: string | null;
    username?: string | null;
  }): Promise<RemoteTerminal> {
    const { sessionId, userId, deviceId } = params;
    const workspace = typeof params.workspace === 'string' ? params.workspace : '';
    // 与云端终端相同的两条上限文案（D8）；中继 pending 与云端 pending 都计入
    const perTask = this.deps.terminalManager.countForSession(sessionId) + this.countForSession(sessionId);
    if (perTask >= this.deps.config.maxSessionsPerTask) {
      throw new TerminalLimitError(`该任务的终端数量已达上限 ${this.deps.config.maxSessionsPerTask}，请先关闭已有终端`);
    }
    const global = this.deps.terminalManager.occupiedCount() + this.occupiedCount();
    if (global >= this.deps.config.maxSessionsGlobal) {
      throw new TerminalLimitError(`服务器终端总数已达上限 ${this.deps.config.maxSessionsGlobal}，请稍后再试`);
    }
    if (!this.deps.host.hasActiveHost(userId, deviceId)) {
      throw new RelayOpenError(this.unavailableMessage(userId, deviceId));
    }

    const cols = clampInt(params.cols, 80, 1, 500);
    const rows = clampInt(params.rows, 24, 1, 200);
    const terminalId = `term-${sessionId}-${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const cwd = workspace;

    const opened = new Promise<RemoteTerminal>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(terminalId)) {
          reject(new RelayOpenError('执行端未在时限内响应', 'TIMEOUT'));
        }
      }, this.openTimeoutMs);
      // 超时定时器不该挂住进程退出
      timer.unref?.();
      this.pending.set(terminalId, {
        sessionId, userId, deviceId, cwd, cols, rows, timer, resolve, reject,
      });
    });

    const sent = this.deps.host.sendToHost(userId, deviceId, {
      type: 'open', terminalId, sessionId, cwd, cols, rows,
    });
    if (!sent) {
      this.releasePending(terminalId);
      throw new RelayOpenError(this.unavailableMessage(userId, deviceId));
    }

    harnessLog('info', `Relay open sent terminalId=${terminalId} (session=${sessionId}, user=${userId}, device=${deviceId})`);
    try {
      const terminal = await opened;
      this.terminalDevices.set(terminalId, deviceId);
      this.relays.set(terminalId, terminal);
      const ids = this.sessionRelays.get(sessionId);
      if (ids) ids.add(terminalId);
      else this.sessionRelays.set(sessionId, new Set([terminalId]));
      this.deps.audit?.('CREATE', terminal, { ip: params.ip, username: params.username });
      harnessLog('info', `Created relay terminal ${terminalId} (session=${sessionId}, user=${userId}, device=${deviceId}, shell=${terminal.shell})`);
      return terminal;
    } catch (e) {
      const failure = e instanceof RelayOpenError ? e : new RelayOpenError('终端启动失败', 'SPAWN_FAILED');
      this.deps.audit?.('CREATE', { terminalId, sessionId, userId }, {
        ip: params.ip,
        username: params.username,
        errorMessage: failure.message,
      });
      harnessLog('warn', `Relay open failed terminalId=${terminalId}: ${failure.message}`);
      throw failure;
    }
  }

  /** 主机 `opened` 应答：用主机实测的 shell/cwd 登记中继记录。帧归属必须与 pending 一致。 */
  handleOpened(host: TerminalHostIdentity, frame: { terminalId: string; shell: string; cwd: string }): void {
    const pending = this.pending.get(frame.terminalId);
    if (!pending || pending.userId !== host.userId || pending.deviceId !== host.deviceId) return;
    this.releasePending(frame.terminalId);
    const bridge = new RelayPtyBridge(frame.terminalId, pending.userId, pending.deviceId, this.deps.host);
    this.bridges.set(frame.terminalId, bridge);
    const terminal = new RemoteTerminal({
      terminalId: frame.terminalId,
      sessionId: pending.sessionId,
      userId: pending.userId,
      shell: typeof frame.shell === 'string' && frame.shell !== '' ? frame.shell : '/bin/bash',
      cwd: typeof frame.cwd === 'string' && frame.cwd !== '' ? frame.cwd : pending.cwd,
      cols: pending.cols,
      rows: pending.rows,
      pty: bridge,
      outputBufferBytes: this.deps.config.outputBufferBytes,
      skipTerminalUsePermission: true,
      kind: 'local-relay',
    });
    // PTY 在主机上自行退出（用户 exit）时从登记表摘除
    terminal.onExit(() => this.forget(frame.terminalId));
    pending.resolve(terminal);
  }

  /** 主机 `open_failed` 应答：占位释放，创建方收到固定文案（原始细节只进日志）。 */
  handleOpenFailed(host: TerminalHostIdentity, frame: { terminalId: string; code: string }): void {
    const pending = this.pending.get(frame.terminalId);
    if (!pending || pending.userId !== host.userId || pending.deviceId !== host.deviceId) return;
    this.releasePending(frame.terminalId);
    const message = frame.code === 'CWD_MISSING' ? '工作区目录不存在或无法访问' : '终端启动失败';
    pending.reject(new RelayOpenError(message, frame.code === 'CWD_MISSING' ? 'CWD_MISSING' : 'SPAWN_FAILED'));
  }

  /** 主机 `output` 帧：透传给桥（环形缓冲 + attach 的观看端）。归属不符 / 未知 id 忽略。 */
  handleHostOutput(host: TerminalHostIdentity, terminalId: string, data: string): void {
    if (!this.ownedByHost(host, terminalId)) return;
    this.bridgeOf(terminalId)?.emitOutput(data);
  }

  /** 主机 `exit` 帧：PTY 在执行端退出，登记摘除走 RemoteTerminal 的 onExit 链。 */
  handleHostExit(host: TerminalHostIdentity, terminalId: string, exitCode: number): void {
    if (!this.ownedByHost(host, terminalId)) return;
    this.bridgeOf(terminalId)?.emitExit(exitCode);
  }

  /** 帧归属校验：terminalId 必须登记在该主机自己的 (userId, deviceId) 名下。 */
  private ownedByHost(host: TerminalHostIdentity, terminalId: string): boolean {
    const terminal = this.relays.get(terminalId);
    if (terminal == null || terminal.userId !== host.userId) return false;
    return this.terminalDevices.get(terminalId) === host.deviceId;
  }

  /**
   * 活跃主机对账（§4.9）：auth 帧带来的 id 集合之外的登记一律按 HOST_LOST 关闭。
   * 同类型重连、跨类型替换（CLI 让位 Electron）都走这一条，无需单独分支。
   */
  reconcileForDevice(userId: number, deviceId: string, terminalIds: ReadonlySet<string>): void {
    for (const [terminalId, device] of [...this.terminalDevices.entries()]) {
      if (device !== deviceId) continue;
      const terminal = this.relays.get(terminalId);
      if (!terminal || terminal.userId !== userId) continue;
      if (terminalIds.has(terminalId)) continue;
      harnessLog('info', `Relay terminal ${terminalId} not in host terminals list, closing as HOST_LOST`);
      this.close(terminalId, { event: 'HOST_LOST' });
    }
  }

  /**
   * 旧活跃主机被替换 / socket 已死：它的在途 open 不会再应答（同一进程不会开第二条
   * 主机连接），立即失败占位。只动 pending，不动已登记——对账负责登记的取舍。
   */
  failPendingForDevice(userId: number, deviceId: string): void {
    for (const [terminalId, pending] of [...this.pending.entries()]) {
      if (pending.deviceId !== deviceId || pending.userId !== userId) continue;
      this.releasePending(terminalId);
      pending.reject(new RelayOpenError('执行端设备离线', 'TIMEOUT'));
    }
  }

  /** 主机断开且宽限到期 / 待命升位：该设备上全部中继登记关闭。 */
  handleHostLost(userId: number, deviceId: string): void {
    for (const [terminalId, device] of [...this.terminalDevices.entries()]) {
      if (device !== deviceId) continue;
      const terminal = this.relays.get(terminalId);
      if (!terminal || terminal.userId !== userId) continue;
      this.close(terminalId, { event: 'HOST_LOST' });
    }
    // 主机都没了，等 pending 只会白等 10 秒：立即按超时失败
    this.failPendingForDevice(userId, deviceId);
  }

  get(terminalId: string): RemoteTerminal | null {
    const terminal = this.relays.get(terminalId);
    if (!terminal) return null;
    if (!terminal.isAlive()) {
      this.forget(terminalId);
      return null;
    }
    return terminal;
  }

  getOwnedByUser(terminalId: string, userId: number): RemoteTerminal | null {
    const terminal = this.get(terminalId);
    if (!terminal || terminal.userId !== userId) return null;
    return terminal;
  }

  list(sessionId: number): RemoteTerminalInfo[] {
    const ids = this.sessionRelays.get(sessionId);
    if (!ids) return [];
    const result: RemoteTerminalInfo[] = [];
    for (const id of [...ids]) {
      const terminal = this.get(id);
      if (terminal) result.push(terminal.toInfo());
    }
    return result.sort((a, b) => a.createdAt - b.createdAt);
  }

  close(terminalId: string, ctx?: TerminalAuditContext & { event?: TerminalCloseReason }): boolean {
    const terminal = this.relays.get(terminalId);
    if (!terminal) return false;
    const info = terminal.toInfo();
    this.forget(terminalId);
    // close() 内部调桥的 kill：向主机发 kill 帧（主机已断开时 sendToHost 静默失败，无害）
    terminal.close();
    harnessLog('info', `Closed relay terminal ${terminalId}`);
    const reason = ctx?.event ?? 'CLOSE';
    this.deps.audit?.(reason, info, ctx);
    this.notifyClosed(info, reason);
    return true;
  }

  /** 任务删除级联（与云端终端同一钩子，装配层在两边都调）。在途的 open 占位一并撤销。 */
  closeBySession(sessionId: number): number {
    let closed = 0;
    const ids = this.sessionRelays.get(sessionId);
    if (ids) {
      for (const id of [...ids]) {
        if (this.close(id, { event: 'SESSION_DELETED' })) closed++;
      }
    }
    // 10 秒 open 窗口内任务被删：拒绝占位，避免为已删除任务登记中继 / 在主机留孤儿 PTY
    for (const [terminalId, pending] of [...this.pending.entries()]) {
      if (pending.sessionId !== sessionId) continue;
      this.releasePending(terminalId);
      pending.reject(new RelayOpenError('任务已删除，终端已关闭'));
      closed += 1;
    }
    if (closed > 0) harnessLog('info', `Closed ${closed} relay terminals for session ${sessionId}`);
    return closed;
  }

  closeAll(): void {
    for (const id of [...this.relays.keys()]) {
      this.close(id, { event: 'CLOSE' });
    }
    for (const pending of [...this.pending.values()]) {
      clearTimeout(pending.timer);
      pending.reject(new RelayOpenError('终端已关闭，请重试', 'SPAWN_FAILED'));
    }
    this.pending.clear();
    this.bridges.clear();
    this.terminalDevices.clear();
  }

  /** 已登记 + pending 的全局名额（与 TerminalManager.occupiedCount 相加后共用上限）。 */
  occupiedCount(): number {
    return this.relays.size + this.pending.size;
  }

  /** 某任务的名额（含 pending）。 */
  countForSession(sessionId: number): number {
    let count = this.sessionRelays.get(sessionId)?.size ?? 0;
    for (const pending of this.pending.values()) {
      if (pending.sessionId === sessionId) count += 1;
    }
    return count;
  }

  startCleanup(intervalMs = 60_000): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), intervalMs);
    this.cleanupTimer.unref?.();
  }

  stopCleanup(): void {
    if (!this.cleanupTimer) return;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  /** 空闲 / 超寿回收，与云端终端同参同因（RECLAIM）。 */
  cleanupExpired(): RemoteTerminalInfo[] {
    const idleTimeout = this.deps.config.idleTimeoutMinutes * 60_000;
    const maxLifetime = this.deps.config.maxLifetimeHours * 3600_000;
    const reclaimed: RemoteTerminalInfo[] = [];
    for (const [terminalId, terminal] of [...this.relays.entries()]) {
      if (!terminal.isAlive()) {
        this.forget(terminalId);
        continue;
      }
      if (terminal.isIdleTimeout(idleTimeout) || terminal.isExpired(maxLifetime)) {
        reclaimed.push(terminal.toInfo());
        this.close(terminalId, { event: 'RECLAIM' });
      }
    }
    if (reclaimed.length > 0) {
      harnessLog('info', `Reclaimed ${reclaimed.length} idle/expired relay terminals`);
    }
    return reclaimed;
  }

  /** 服务端关闭中继时通知观看端的钩子（目录门面把两边都接进来）。 */
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

  private bridgeOf(terminalId: string): RelayPtyBridge | null {
    const terminal = this.relays.get(terminalId);
    if (!terminal) return null;
    return this.bridges.get(terminalId) ?? null;
  }

  private releasePending(terminalId: string): void {
    const pending = this.pending.get(terminalId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(terminalId);
  }

  private forget(terminalId: string): void {
    this.relays.delete(terminalId);
    this.bridges.delete(terminalId);
    this.terminalDevices.delete(terminalId);
    this.releasePending(terminalId);
    // sessionRelays 的清理
    for (const [sessionId, ids] of [...this.sessionRelays.entries()]) {
      if (!ids.delete(terminalId)) continue;
      if (ids.size === 0) this.sessionRelays.delete(sessionId);
      break;
    }
  }

  private unavailableMessage(userId: number, deviceId: string): string {
    const status = this.deps.hostStatus?.resolve(userId, deviceId) ?? null;
    switch (status) {
      case 'unsupported':
        return '当前桌面客户端版本不支持远程终端，请升级桌面客户端';
      case 'upgrade-cli':
        return '当前 mao-agent 版本不支持远程终端，请升级后重试';
      case 'upgrade-either':
        return '请升级桌面客户端或 mao-agent 后使用远程终端';
      default:
        return '执行端设备离线';
    }
  }
}

function clampInt(value: number | null | undefined, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}
