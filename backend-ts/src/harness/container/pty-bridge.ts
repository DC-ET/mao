import type { ChannelConnection } from './runtime-channel-server.js';
import type { PtyLike, SpawnPtyOptions } from '../terminal/remote-terminal.js';
import { newFrameId } from './runtime-channel-protocol.js';

/** 容器内 pty 打开超时。 */
const PTY_OPEN_TIMEOUT_MS = 20_000;
/** 连接断开时在飞 pty 的兜底退出码。 */
const PTY_CONNECTION_LOST_EXIT_CODE = -1;
/**
 * 连接断开后的重连宽限：agent 退避重连上限 15s，宽限期满仍无新连接接入
 * 才判定在飞终端已死（同一容器内 pty 在重连期间仍然活着，不能立即收尾）。
 */
const CONNECTION_LOST_GRACE_MS = 20_000;

/**
 * 宿主机侧远程 pty（技术方案 §5.7.3）：实现 RemoteTerminal 的 PtyLike 接口，
 * spawn/write/resize/kill 经 RuntimeChannelServer 转发到容器内 node-pty。
 * 输出与退出由 PtyChannelHub 统一分发（按 ptyId 路由），RemoteTerminal 自身零改动。
 *
 * 写入不持有固定连接：容器重建/agent 重连会换连接，经 hub 的当前连接转发，
 * 旧连接上的 pty 在容器未重建时仍可继续输入。
 */
export class PtyBridgePty implements PtyLike {
  pid: number;

  constructor(
    private readonly hub: PtyChannelHub,
    readonly ptyId: string,
    pid: number,
  ) {
    this.pid = pid;
  }

  onData(cb: (data: string) => void): unknown {
    this.hub.subscribeData(this.ptyId, cb);
    return cb;
  }

  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown {
    this.hub.subscribeExit(this.ptyId, cb);
    return cb;
  }

  write(data: string): void {
    if (this.hub.isClosed(this.ptyId)) return;
    this.hub.currentConnection?.send({ v: 1, type: 'pty_data', ptyId: this.ptyId, data });
  }

  resize(cols: number, rows: number): void {
    if (this.hub.isClosed(this.ptyId)) return;
    this.hub.currentConnection?.send({ v: 1, type: 'pty_resize', ptyId: this.ptyId, cols, rows });
  }

  kill(_signal?: string): void {
    if (this.hub.isClosed(this.ptyId)) return;
    this.hub.currentConnection?.send({ v: 1, type: 'pty_close', ptyId: this.ptyId });
    this.hub.forget(this.ptyId);
  }
}

/**
 * pty 通道分发器：docker 模式下 TerminalManager 的 ptyFactory 即本类的 open。
 * 每用户一个 hub 长生存期；连接替换（agent 重连）时 bindConnection 迁移订阅，
 * 已打开的 pty 不中断；宽限期内没有新连接接入、或容器重建（dispose）时
 * 按退出码 -1 统一收尾在飞终端。
 */
export class PtyChannelHub {
  private readonly dataListeners = new Map<string, (data: string) => void>();
  private readonly exitListeners = new Map<string, (e: { exitCode: number; signal?: number }) => void>();
  private readonly closedIds = new Set<string>();
  private readonly openIds = new Set<string>();
  private readonly unsubs: Array<() => void> = [];
  private connection: ChannelConnection | null;
  private lostTimer: NodeJS.Timeout | null = null;

  constructor(connection: ChannelConnection | null = null) {
    this.connection = connection;
    if (connection) this.subscribe(connection);
  }

  /** 当前可用连接（容器重建后由装配层换绑）；无连接时 open 直接抛错。 */
  get currentConnection(): ChannelConnection | null {
    return this.connection && this.connection.alive ? this.connection : null;
  }

  /**
   * 换绑连接（同一用户的新 ChannelConnection）：旧订阅退订、新连接订阅，
   * 已打开 pty 的 data/exit 分发与输入转发切到新连接；取消断开宽限计时。
   */
  bindConnection(connection: ChannelConnection): void {
    if (this.connection === connection) return;
    this.unsubscribe();
    this.cancelLostTimer();
    this.connection = connection;
    this.subscribe(connection);
  }

  /** 打开容器内 pty 并注册分发；失败抛错（TerminalManager 转为 TerminalSpawnError）。 */
  async open(userId: number, options: SpawnPtyOptions): Promise<PtyBridgePty> {
    const connection = this.currentConnection;
    if (!connection) {
      throw new Error(`容器运行时通道未连接，无法打开终端: userId=${userId}`);
    }
    const ptyId = newFrameId('pty');
    const id = newFrameId('ptyopen');
    const response = await connection.request({
      v: 1, type: 'pty_open', id, ptyId,
      options: {
        shell: options.shell,
        args: options.args,
        cwd: options.cwd,
        cols: options.cols,
        rows: options.rows,
        env: options.env as Record<string, string>,
      },
    }, PTY_OPEN_TIMEOUT_MS);
    if (response.type !== 'pty_open_result' || !response.ok) {
      const message = response.type === 'pty_open_result'
        ? response.error ?? 'pty open failed'
        : `unexpected response: ${response.type}`;
      throw new Error(`容器内终端启动失败: ${message}`);
    }
    this.openIds.add(ptyId);
    this.closedIds.delete(ptyId);
    return new PtyBridgePty(this, ptyId, response.pid ?? -1);
  }

  subscribeData(ptyId: string, cb: (data: string) => void): void {
    this.dataListeners.set(ptyId, cb);
    this.closedIds.delete(ptyId);
  }

  subscribeExit(ptyId: string, cb: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitListeners.set(ptyId, cb);
  }

  isClosed(ptyId: string): boolean {
    return this.closedIds.has(ptyId);
  }

  forget(ptyId: string): void {
    this.dataListeners.delete(ptyId);
    this.exitListeners.delete(ptyId);
    this.openIds.delete(ptyId);
    this.closedIds.add(ptyId);
  }

  /** 容器重建：旧容器内的 pty 已不存在，全部按断开收尾后 hub 可换绑新连接复用。 */
  dispose(): void {
    this.cancelLostTimer();
    this.failInFlightPtys(PTY_CONNECTION_LOST_EXIT_CODE);
    this.unsubscribe();
    this.connection = null;
    this.dataListeners.clear();
    this.exitListeners.clear();
  }

  /**
   * 连接断开：不立即收尾——agent 可能在退避重连（同一容器内 pty 仍活着），
   * 宽限期内 bindConnection 成功即恢复；超时仍无新连接才判定终端已死。
   */
  private handleConnectionLost(): void {
    if (this.lostTimer || this.openIds.size === 0) return;
    this.lostTimer = setTimeout(() => {
      this.lostTimer = null;
      this.failInFlightPtys(PTY_CONNECTION_LOST_EXIT_CODE);
    }, CONNECTION_LOST_GRACE_MS);
    this.lostTimer.unref?.();
  }

  private failInFlightPtys(exitCode: number): void {
    for (const ptyId of [...this.openIds]) {
      const exit = this.exitListeners.get(ptyId);
      this.dataListeners.delete(ptyId);
      this.exitListeners.delete(ptyId);
      this.openIds.delete(ptyId);
      this.closedIds.add(ptyId);
      exit?.({ exitCode });
    }
  }

  private cancelLostTimer(): void {
    if (this.lostTimer) { clearTimeout(this.lostTimer); this.lostTimer = null; }
  }

  private subscribe(connection: ChannelConnection): void {
    if (!connection.alive) {
      // 连接已死（装配/换绑与断开的竞态）：按断开处理，等新连接换绑
      this.handleConnectionLost();
      return;
    }
    this.unsubs.push(
      connection.onPtyData((ptyId, data) => {
        this.dataListeners.get(ptyId)?.(data);
      }),
      // 容器回报的真实 exitCode 原样透出（host 模式 node-pty onExit 同口径）
      connection.onPtyExit((ptyId, exitCode) => {
        const exit = this.exitListeners.get(ptyId);
        this.dataListeners.delete(ptyId);
        this.exitListeners.delete(ptyId);
        this.openIds.delete(ptyId);
        this.closedIds.add(ptyId);
        exit?.({ exitCode });
      }),
      connection.onClosed(() => this.handleConnectionLost()),
    );
  }

  private unsubscribe(): void {
    for (const unsub of this.unsubs.splice(0)) unsub();
  }
}
