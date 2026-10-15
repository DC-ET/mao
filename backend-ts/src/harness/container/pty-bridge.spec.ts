import { describe, expect, it, vi } from 'vitest';
import { PtyChannelHub } from './pty-bridge.js';
import type { ChannelConnection } from './runtime-channel-server.js';
import type { RuntimeRequestFrame, RuntimeResponseFrame } from './runtime-channel-protocol.js';

/**
 * 宿主机侧 pty 桥接回归（round-01 BUG-9 / BUG-10）：
 * 退出码必须透传容器回报的真实值；连接替换（agent 重连/容器重建）后
 * 新终端可打开、旧终端输入可达新连接、旧连接断开时在飞终端按 -1 收尾。
 */
class FakeConnection implements ChannelConnection {
  readonly sent: RuntimeRequestFrame[] = [];
  closed = false;
  private readonly dataListeners: Array<(ptyId: string, data: string) => void> = [];
  private readonly exitListeners: Array<(ptyId: string, exitCode: number) => void> = [];
  private readonly closedListeners: Array<() => void> = [];

  constructor(readonly userId: number, private readonly autoAck = true) {}

  get alive(): boolean {
    return !this.closed;
  }

  request(frame: RuntimeRequestFrame & { id: string }): Promise<RuntimeResponseFrame> {
    this.sent.push(frame);
    if (this.autoAck && frame.type === 'pty_open') {
      return Promise.resolve({ v: 1, type: 'pty_open_result', id: frame.id, ok: true, pid: 1234 });
    }
    return new Promise(() => undefined); // 不自动响应的帧：挂起等待（测试里不会走到）
  }

  send(frame: RuntimeRequestFrame): void {
    this.sent.push(frame);
  }

  async requestShutdown(): Promise<boolean> {
    return true;
  }

  onPtyData(listener: (ptyId: string, data: string) => void): () => void {
    this.dataListeners.push(listener);
    return () => undefined;
  }

  onPtyExit(listener: (ptyId: string, exitCode: number) => void): () => void {
    this.exitListeners.push(listener);
    return () => undefined;
  }

  onClosed(listener: () => void): () => void {
    if (this.closed) { listener(); return () => undefined; }
    this.closedListeners.push(listener);
    return () => undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of [...this.closedListeners]) listener();
  }

  emitData(ptyId: string, data: string): void {
    for (const listener of [...this.dataListeners]) listener(ptyId, data);
  }

  emitExit(ptyId: string, exitCode: number): void {
    for (const listener of [...this.exitListeners]) listener(ptyId, exitCode);
  }
}

const OPTIONS = { shell: '/bin/bash', args: ['-i'], cwd: '/tmp', cols: 80, rows: 24, env: {} };

describe('pty channel bridge', () => {
  it('passesThroughContainerExitCode', async () => {
    // BUG-9 回归：容器回报 42，宿主机 onExit 必须原样收到 42（host 模式 node-pty 同口径）
    const conn = new FakeConnection(7);
    const hub = new PtyChannelHub(conn);
    const pty = await hub.open(7, OPTIONS);
    const observed: Array<{ exitCode: number }> = [];
    pty.onExit((e) => observed.push(e));
    conn.emitExit(pty.ptyId, 42);
    expect(observed).toEqual([{ exitCode: 42 }]);
  });

  it('survivesConnectionReplacement', async () => {
    // BUG-10 回归：连接被回收/重建后 hub 换绑新连接，新终端可开、旧终端输入可达新连接
    const conn1 = new FakeConnection(7);
    const hub = new PtyChannelHub(conn1);
    const pty1 = await hub.open(7, OPTIONS);

    conn1.close(); // agent 重连失败/容器重建：旧连接断开
    // 宽限期内不收尾在飞终端（同一容器内 pty 仍活着，agent 可能在重连）
    const exits: Array<{ exitCode: number }> = [];
    pty1.onExit((e) => exits.push(e));
    expect(exits).toEqual([]);

    const conn2 = new FakeConnection(7);
    hub.bindConnection(conn2);

    // 新终端经新连接打开
    const pty2 = await hub.open(7, OPTIONS);
    expect(pty2.ptyId).not.toBe(pty1.ptyId);
    expect(conn2.sent.some((f) => f.type === 'pty_open')).toBe(true);

    // 旧 pty 的输入经 hub 当前连接（conn2）转发，不再写进死连接
    const before = conn2.sent.length;
    pty1.write('ls\n');
    expect(conn2.sent.length).toBe(before + 1);
    expect(conn2.sent[before]).toEqual({ v: 1, type: 'pty_data', ptyId: pty1.ptyId, data: 'ls\n' });
    expect(conn1.sent.filter((f) => f.type === 'pty_data')).toEqual([]);
  });

  it('reopensOpenWithoutLiveConnection', async () => {
    // 无可用连接时 open 直接抛错（TerminalManager 转 TerminalSpawnError），不死等
    const conn = new FakeConnection(7);
    const hub = new PtyChannelHub(conn);
    conn.close();
    await expect(hub.open(7, OPTIONS)).rejects.toThrow(/容器运行时通道未连接/);
  });

  it('notifiesInFlightPtysWhenConnectionLostForGood', async () => {
    // 连接断开且宽限期内没有新连接接入：在飞终端统一收到 exit -1
    vi.useFakeTimers();
    try {
      const conn = new FakeConnection(7);
      const hub = new PtyChannelHub(conn);
      const pty = await hub.open(7, OPTIONS);
      const exits: Array<{ exitCode: number }> = [];
      pty.onExit((e) => exits.push(e));
      conn.close();
      // 宽限期内不收尾
      vi.advanceTimersByTime(19_000);
      expect(exits).toEqual([]);
      // 宽限期满仍无新连接 → 收尾
      vi.advanceTimersByTime(2_000);
      expect(exits).toEqual([{ exitCode: -1 }]);
      // 断开后 write 不再往死连接写
      const before = conn.sent.length;
      pty.write('x');
      expect(conn.sent.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposeFailsInFlightPtysImmediately', async () => {
    // 容器重建（startedAtMs 变化 → dispose）：旧容器内的 pty 已不存在，立即收尾
    const conn = new FakeConnection(7);
    const hub = new PtyChannelHub(conn);
    const pty = await hub.open(7, OPTIONS);
    const exits: Array<{ exitCode: number }> = [];
    pty.onExit((e) => exits.push(e));
    hub.dispose();
    expect(exits).toEqual([{ exitCode: -1 }]);
    // dispose 后换绑新连接可继续开终端
    const conn2 = new FakeConnection(7);
    hub.bindConnection(conn2);
    const pty2 = await hub.open(7, OPTIONS);
    expect(pty2.ptyId).toBeTruthy();
  });

  it('forwardsDataFromContainerToSubscribers', async () => {
    const conn = new FakeConnection(7);
    const hub = new PtyChannelHub(conn);
    const pty = await hub.open(7, OPTIONS);
    const received: string[] = [];
    pty.onData((d) => received.push(d));
    conn.emitData(pty.ptyId, 'hello-from-container');
    expect(received).toEqual(['hello-from-container']);
  });
});
