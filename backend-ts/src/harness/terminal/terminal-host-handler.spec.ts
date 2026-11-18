import { describe, expect, it, vi } from 'vitest';
import { TERMINAL_WS_OPEN, type TerminalSocket } from './terminal-ws-handler.js';
import {
  HOST_GRACE_MS,
  TerminalHostHandler,
  type TerminalHostRelayCallbacks,
} from './terminal-host-handler.js';

class FakeSocket implements TerminalSocket {
  readyState = TERMINAL_WS_OPEN;
  bufferedAmount = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  closed: { code?: number; reason?: string } | null = null;

  constructor(readonly id: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }

  frames(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((f) => f.type === type);
  }

  last(): Record<string, unknown> | undefined {
    return this.sent[this.sent.length - 1];
  }
}

function makeRelay() {
  const relay: TerminalHostRelayCallbacks & { calls: Array<{ op: string; args: unknown[] }> } = {
    calls: [],
    handleOpened(host, frame) { this.calls.push({ op: 'opened', args: [host, frame] }); },
    handleOpenFailed(host, frame) { this.calls.push({ op: 'openFailed', args: [host, frame] }); },
    handleHostOutput(host, terminalId, data) { this.calls.push({ op: 'output', args: [host, terminalId, data] }); },
    handleHostExit(host, terminalId, exitCode) { this.calls.push({ op: 'exit', args: [host, terminalId, exitCode] }); },
    reconcileForDevice(userId, deviceId, terminalIds) { this.calls.push({ op: 'reconcile', args: [userId, deviceId, [...terminalIds]] }); },
    handleHostLost(userId, deviceId) { this.calls.push({ op: 'hostLost', args: [userId, deviceId] }); },
    failPendingForDevice(userId, deviceId) { this.calls.push({ op: 'failPending', args: [userId, deviceId] }); },
  };
  return relay;
}

function makeHandler(opts: { streamTypes?: Array<'electron' | 'cli'>; graceMs?: number } = {}) {
  const relay = makeRelay();
  const statusChanges: Array<[number, string]> = [];
  const handler = new TerminalHostHandler({
    jwtService: {
      validateAccessToken: (token) => token !== 'bad' && token !== '',
      getUserIdFromToken: () => 7,
      getUsernameFromToken: () => 'u',
    },
    relay,
    streamTypes: { listDeviceClientTypes: () => opts.streamTypes ?? [] },
    onStatusChanged: (userId, deviceId) => statusChanges.push([userId, deviceId]),
    graceMs: opts.graceMs ?? HOST_GRACE_MS,
  });
  return { handler, relay, statusChanges };
}

/** 建连 + auth：返回 socket 并推进事件循环消化串行队列。 */
async function connect(handler: TerminalHostHandler, id: string, frame: Record<string, unknown>): Promise<FakeSocket> {
  const socket = new FakeSocket(id);
  await handler.handleTextMessage(socket, JSON.stringify({ type: 'auth', token: 't', ...frame }));
  return socket;
}

const HOST_LOST_CALLS = (relay: { calls: Array<{ op: string; args: unknown[] }> }) =>
  relay.calls.filter((c) => c.op === 'hostLost');

describe('TerminalHostHandler', () => {
  it('auth：token / deviceId / client 校验，通过后回 connected role=active 并对账', async () => {
    const { handler, relay } = makeHandler();
    const socket = await connect(handler, 'h1', { deviceId: 'dev-1', client: 'electron', terminals: ['term-1', 'term-2'] });
    expect(socket.last()).toMatchObject({ type: 'connected', userId: 7, role: 'active' });
    expect(relay.calls).toEqual([{ op: 'reconcile', args: [7, 'dev-1', ['term-1', 'term-2']] }]);
    expect(handler.hasActiveHost(7, 'dev-1')).toBe(true);
    expect(handler.getStatus(7, 'dev-1')).toBe('enabled');
  });

  it('auth 非法：坏 token / 非法 deviceId / 未知 client → 1003 关闭', async () => {
    const { handler } = makeHandler();
    const badFrames = [
      { token: 'bad', deviceId: 'dev-1', client: 'electron' },
      { deviceId: 'bad id!', client: 'electron' },
      { deviceId: 'dev-1', client: 'web' },
    ];
    for (const [i, frame] of badFrames.entries()) {
      const socket = await connect(handler, `h-bad-${i}`, frame);
      expect(socket.closed?.code).toBe(1003);
    }
    expect(handler.connectionCount()).toBe(0);
  });

  it('优先级（D12）：Electron 活跃时 CLI 得到 standby，不收 open；Electron 断开 CLI 立即升位', async () => {
    const { handler, relay, statusChanges } = makeHandler();
    const electron = await connect(handler, 'e1', { deviceId: 'dev-1', client: 'electron', terminals: ['term-e'] });
    const cli = await connect(handler, 'c1', { deviceId: 'dev-1', client: 'cli', terminals: [] });
    expect(cli.last()).toMatchObject({ type: 'connected', role: 'standby' });
    expect(handler.hasActiveHost(7, 'dev-1')).toBe(true);

    // Electron 断开：CLI 升位，Electron 的登记按升位方列表（空）关闭
    handler.afterConnectionClosed(electron);
    expect(cli.last()).toMatchObject({ type: 'connected', role: 'active' });
    expect(relay.calls.filter((c) => c.op === 'reconcile').at(-1)).toEqual({ op: 'reconcile', args: [7, 'dev-1', []] });
    expect(HOST_LOST_CALLS(relay)).toEqual([]);
    expect(handler.hasActiveHost(7, 'dev-1')).toBe(true);
    expect(handler.getStatus(7, 'dev-1')).toBe('enabled');
    // 状态值（enabled）全程未变：只有 Electron 首连广播一次，升位不重复广播
    expect(statusChanges.length).toBe(1);
  });

  it('CLI 活跃时 Electron 到场：CLI 被 4000 replaced，Electron 对账关闭 CLI 时代的登记', async () => {
    const { handler, relay } = makeHandler();
    const cli = await connect(handler, 'c1', { deviceId: 'dev-1', client: 'cli', terminals: [] });
    relay.calls.length = 0;
    const electron = await connect(handler, 'e1', { deviceId: 'dev-1', client: 'electron', terminals: [] });
    expect(cli.closed).toMatchObject({ code: 4000, reason: 'replaced' });
    expect(electron.last()).toMatchObject({ type: 'connected', role: 'active' });
    // reconcile 以 Electron 的空列表对账：CLI 的旧登记（假设存在）会被关闭
    expect(relay.calls.filter((c) => c.op === 'reconcile')).toHaveLength(1);
  });

  it('同级替换（electron→electron）：旧连接 4000，新列表对账；旧 socket close 不再触发宽限', async () => {
    const { handler, relay } = makeHandler({ graceMs: 30 });
    const e1 = await connect(handler, 'e1', { deviceId: 'dev-1', client: 'electron', terminals: ['term-a'] });
    const e2 = await connect(handler, 'e2', { deviceId: 'dev-1', client: 'electron', terminals: ['term-a'] });
    expect(e1.closed).toMatchObject({ code: 4000 });
    expect(e2.last()).toMatchObject({ type: 'connected', role: 'active' });
    // 旧 socket 的迟到 close 事件：active 已不是它，不进入宽限、不杀登记
    handler.afterConnectionClosed(e1);
    expect(handler.hasActiveHost(7, 'dev-1')).toBe(true);
    expect(handler.getStatus(7, 'dev-1')).toBe('enabled');
    // 每次活跃主机上位都对账一次（e1 / e2 auth 各一次），列表内的 id 幸存
    expect(relay.calls.filter((c) => c.op === 'reconcile')).toHaveLength(2);
  });

  it('无待命断开 → 60 秒宽限（状态 null / 离线文案），到期 handleHostLost', async () => {
    vi.useFakeTimers();
    try {
      const { handler, relay } = makeHandler({ graceMs: 30 });
      const e1 = await connect(handler, 'e1', { deviceId: 'dev-1', client: 'electron', terminals: ['term-a'] });
      handler.afterConnectionClosed(e1);
      expect(handler.hasActiveHost(7, 'dev-1')).toBe(false);
      expect(handler.getStatus(7, 'dev-1')).toBeNull();
      expect(HOST_LOST_CALLS(relay)).toEqual([]);

      // 宽限内重连并带上原 id：对账保留，无 HOST_LOST
      const e2 = await connect(handler, 'e2', { deviceId: 'dev-1', client: 'electron', terminals: ['term-a'] });
      expect(e2.last()).toMatchObject({ role: 'active' });
      vi.advanceTimersByTime(100);
      expect(HOST_LOST_CALLS(relay)).toEqual([]);
      expect(handler.getStatus(7, 'dev-1')).toBe('enabled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('宽限到期 → 该设备登记全部 HOST_LOST', async () => {
    vi.useFakeTimers();
    try {
      const { handler, relay } = makeHandler({ graceMs: 30 });
      const e1 = await connect(handler, 'e1', { deviceId: 'dev-1', client: 'electron', terminals: [] });
      handler.afterConnectionClosed(e1);
      vi.advanceTimersByTime(60);
      expect(HOST_LOST_CALLS(relay)).toEqual([{ op: 'hostLost', args: [7, 'dev-1'] }]);
      expect(handler.getStatus(7, 'dev-1')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('状态机：无主机时按流连接类型给出 unsupported / upgrade-cli / upgrade-either', async () => {
    for (const [types, expected] of [
      [['electron'], 'unsupported'],
      [['cli'], 'upgrade-cli'],
      [['electron', 'cli'], 'upgrade-either'],
      [[], null],
    ] as const) {
      const { handler } = makeHandler({ streamTypes: [...types] });
      expect(handler.getStatus(7, 'dev-1')).toBe(expected);
    }
  });

  it('主机帧路由：opened / open_failed / output / exit 只在活跃连接上转发到 relay', async () => {
    const { handler, relay } = makeHandler();
    const active = await connect(handler, 'a1', { deviceId: 'dev-1', client: 'electron', terminals: [] });
    await handler.handleTextMessage(active, JSON.stringify({ type: 'output', terminalId: 't1', data: 'hi' }));
    await handler.handleTextMessage(active, JSON.stringify({ type: 'exit', terminalId: 't1', exitCode: 0 }));
    await handler.handleTextMessage(active, JSON.stringify({ type: 'opened', terminalId: 't2', shell: '/bin/zsh', cwd: '/w' }));
    await handler.handleTextMessage(active, JSON.stringify({ type: 'open_failed', terminalId: 't3', code: 'CWD_MISSING' }));
    expect(relay.calls.map((c) => c.op)).toEqual(['reconcile', 'output', 'exit', 'opened', 'openFailed']);
    // 帧回调携带来源主机身份（P1-8）：host 是连接对象，按身份字段断言
    expect((relay.calls[1]!.args[0] as { userId: number; deviceId: string }).userId).toBe(7);
    expect((relay.calls[1]!.args[0] as { userId: number; deviceId: string }).deviceId).toBe('dev-1');
    expect(relay.calls[1]!.args.slice(1)).toEqual(['t1', 'hi']);

    // 待命连接的帧不转发
    const electron2 = new FakeSocket('a2');
    await handler.handleTextMessage(electron2, JSON.stringify({ type: 'auth', token: 't', deviceId: 'dev-1', client: 'electron', terminals: [] }));
    const standby = new FakeSocket('s1');
    await handler.handleTextMessage(standby, JSON.stringify({ type: 'auth', token: 't', deviceId: 'dev-1', client: 'cli', terminals: [] }));
    expect(standby.last()).toMatchObject({ role: 'standby' });
    const before = relay.calls.length;
    await handler.handleTextMessage(standby, JSON.stringify({ type: 'output', terminalId: 't9', data: 'x' }));
    expect(relay.calls.length).toBe(before);
  });

  it('ping → pong；sendToHost 定向活跃主机', async () => {
    const { handler } = makeHandler();
    const active = await connect(handler, 'a1', { deviceId: 'dev-1', client: 'electron', terminals: [] });
    await handler.handleTextMessage(active, JSON.stringify({ type: 'ping' }));
    expect(active.last()).toEqual({ type: 'pong' });

    expect(handler.sendToHost(7, 'dev-1', { type: 'open', terminalId: 't1' })).toBe(true);
    expect(active.frames('open')).toEqual([{ type: 'open', terminalId: 't1' }]);
    expect(handler.sendToHost(7, 'dev-9', { type: 'open' })).toBe(false);
  });

  it('断开重置宽限（新的断开重置 60 秒）', async () => {
    vi.useFakeTimers();
    try {
      const { handler, relay } = makeHandler({ graceMs: 60 });
      const e1 = await connect(handler, 'e1', { deviceId: 'dev-1', client: 'electron', terminals: [] });
      handler.afterConnectionClosed(e1);
      vi.advanceTimersByTime(50);
      // 宽限内第二台（同设备不同进程）连上又断开：宽限重置
      const e2 = await connect(handler, 'e2', { deviceId: 'dev-1', client: 'electron', terminals: [] });
      handler.afterConnectionClosed(e2);
      vi.advanceTimersByTime(50);
      expect(HOST_LOST_CALLS(relay)).toEqual([]);
      vi.advanceTimersByTime(40);
      expect(HOST_LOST_CALLS(relay)).toEqual([{ op: 'hostLost', args: [7, 'dev-1'] }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
