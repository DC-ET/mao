import type { ChannelConnection } from './runtime-channel-server.js';
import type { PtyLike, SpawnPtyOptions } from '../terminal/remote-terminal.js';
import { newFrameId } from './runtime-channel-protocol.js';

/** 容器内 pty 打开超时。 */
const PTY_OPEN_TIMEOUT_MS = 20_000;

/**
 * 宿主机侧远程 pty（技术方案 §5.7.3）：实现 RemoteTerminal 的 PtyLike 接口，
 * spawn/write/resize/kill 经 RuntimeChannelServer 转发到容器内 node-pty。
 * 输出与退出由 PtyChannelHub 统一分发（按 ptyId 路由），RemoteTerminal 自身零改动。
 */
export class PtyBridgePty implements PtyLike {
  pid: number;

  constructor(
    private readonly hub: PtyChannelHub,
    readonly ptyId: string,
    pid: number,
    private readonly connection: ChannelConnection,
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
    this.connection.send({ v: 1, type: 'pty_data', ptyId: this.ptyId, data });
  }

  resize(cols: number, rows: number): void {
    if (this.hub.isClosed(this.ptyId)) return;
    this.connection.send({ v: 1, type: 'pty_resize', ptyId: this.ptyId, cols, rows });
  }

  kill(_signal?: string): void {
    if (this.hub.isClosed(this.ptyId)) return;
    this.connection.send({ v: 1, type: 'pty_close', ptyId: this.ptyId });
    this.hub.forget(this.ptyId);
  }
}

/**
 * pty 通道分发器：docker 模式下 TerminalManager 的 ptyFactory 即本类的 open。
 * 每个用户容器一条 ChannelConnection，本 hub 绑定单条连接。
 */
export class PtyChannelHub {
  private readonly dataListeners = new Map<string, (data: string) => void>();
  private readonly exitListeners = new Map<string, (e: { exitCode: number; signal?: number }) => void>();
  private readonly closedIds = new Set<string>();
  private readonly unsubs: Array<() => void>;

  constructor(private readonly connection: ChannelConnection) {
    this.unsubs = [
      connection.onPtyData((ptyId, data) => {
        this.dataListeners.get(ptyId)?.(data);
      }),
      connection.onPtyExit((ptyId) => {
        const exit = this.exitListeners.get(ptyId);
        this.dataListeners.delete(ptyId);
        this.exitListeners.delete(ptyId);
        this.closedIds.add(ptyId);
        exit?.({ exitCode: 0 });
      }),
    ];
  }

  /** 打开容器内 pty 并注册分发；失败抛错（TerminalManager 转为 TerminalSpawnError）。 */
  async open(userId: number, options: SpawnPtyOptions): Promise<PtyBridgePty> {
    const ptyId = newFrameId('pty');
    const id = newFrameId('ptyopen');
    const response = await this.connection.request({
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
    return new PtyBridgePty(this, ptyId, response.pid ?? -1, this.connection);
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
    this.closedIds.add(ptyId);
  }

  dispose(): void {
    for (const unsub of this.unsubs) unsub();
    this.dataListeners.clear();
    this.exitListeners.clear();
  }
}
