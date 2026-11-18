import { describe, expect, it, vi } from 'vitest';
import { LocalTerminalRelay, RelayOpenError, sliceUtf8, HOST_FRAME_MAX_BYTES } from './local-terminal-relay.js';
import { TerminalLimitError, type TerminalAuditEvent, type TerminalAuditContext } from './terminal-manager.js';

const CONFIG = {
  maxSessionsPerTask: 2,
  maxSessionsGlobal: 4,
  idleTimeoutMinutes: 120,
  maxLifetimeHours: 24,
  outputBufferBytes: 262144,
};

interface HostCalls {
  hasActiveHostCalls: number;
  frames: Array<Record<string, unknown>>;
  online: boolean;
}

function makeHost(overrides: Partial<HostCalls> = {}) {
  const state: HostCalls = { hasActiveHostCalls: 0, frames: [], online: true, ...overrides };
  return {
    state,
    hasActiveHost: vi.fn(() => {
      state.hasActiveHostCalls += 1;
      return state.online;
    }),
    sendToHost: vi.fn((_userId: number, _deviceId: string, frame: Record<string, unknown>) => {
      state.frames.push(frame);
      return state.online;
    }),
  };
}

function makeRelay(hostOverride?: Partial<HostCalls>, audit?: (event: TerminalAuditEvent, terminal: { terminalId: string; sessionId: number; userId: number }, ctx?: TerminalAuditContext) => void) {
  const host = makeHost(hostOverride);
  const terminalManager = { occupiedCount: vi.fn(() => 0), countForSession: vi.fn(() => 0) };
  const relay = new LocalTerminalRelay({
    terminalManager,
    config: CONFIG,
    host,
    hostStatus: { resolve: () => null },
    audit,
    openTimeoutMs: 50,
  });
  return { relay, host, terminalManager };
}

/** 驱动一次完整创建：create + 主机 opened 应答（dev-1 / userId 7）。 */
async function created(relay: LocalTerminalRelay, sessionId = 1) {
  const pending = relay.create({ sessionId, userId: 7, deviceId: 'dev-1', workspace: '/home/u/proj', cols: 100, rows: 30 });
  const frame = (relay as unknown as { deps: { host: { state: { frames: Array<Record<string, unknown>> } } } }).deps.host.state.frames;
  const open = frame[frame.length - 1]!;
  relay.handleOpened({ userId: 7, deviceId: 'dev-1' }, { terminalId: open.terminalId as string, shell: '/bin/zsh', cwd: '/home/u/proj' });
  return { terminal: await pending, open };
}

describe('LocalTerminalRelay', () => {
  it('创建：主机在线且回 opened → 登记为中继记录（kind=local-relay，skipTerminalUsePermission）', async () => {
    const { relay } = makeRelay();
    const { terminal, open } = await created(relay);
    expect(open).toMatchObject({ type: 'open', sessionId: 1, cwd: '/home/u/proj', cols: 100, rows: 30 });
    expect(terminal.terminalId).toMatch(/^term-1-\d+-[0-9a-f]{8}$/);
    expect(terminal.skipTerminalUsePermission).toBe(true);
    expect(terminal.toInfo().kind).toBe('local-relay');
    expect(terminal.toInfo().shell).toBe('/bin/zsh');
    expect(relay.occupiedCount()).toBe(1);
    expect(relay.countForSession(1)).toBe(1);
  });

  it('桥接 PtyLike：write/resize/kill 变成发往主机的帧，主机 output/exit 调回', async () => {
    const { relay, host } = makeRelay();
    const { terminal, open } = await created(relay);
    const terminalId = open.terminalId as string;
    let exitCode: number | null = null;
    // RemoteTerminal.onExit 回调直接传数字 exitCode（与 node-pty 事件解构后一致）
    terminal.onExit((code) => { exitCode = code; });

    terminal.write('ls\r\n');
    terminal.resize(120, 40);
    expect(host.state.frames.slice(-2)).toEqual([
      { type: 'input', terminalId, data: 'ls\r\n' },
      { type: 'resize', terminalId, cols: 120, rows: 40 },
    ]);

    relay.handleHostOutput({ userId: 7, deviceId: 'dev-1' }, terminalId, 'hello');
    // 输出经 RemoteTerminal 构造时注册的桥回调写入环形缓冲（attach 时整段回放）
    expect(terminal.readBuffered()).toBe('hello');

    relay.handleHostExit({ userId: 7, deviceId: 'dev-1' }, terminalId, 3);
    expect(exitCode).toBe(3);
    // exit 后登记摘除
    expect(relay.get(terminalId)).toBeNull();
    expect(relay.occupiedCount()).toBe(0);
  });

  it('write 超过 256KB 按 UTF-8 边界切片成多帧', async () => {
    const { relay, host } = makeRelay();
    const { terminal, open } = await created(relay);
    const terminalId = open.terminalId as string;
    // 8 万个中文字符 ≈ 240KB UTF-8，再补一段让总量超过 256KB
    const big = '中'.repeat(90_000);
    terminal.write(big);
    const inputFrames = host.state.frames.filter((f) => f.type === 'input');
    expect(inputFrames.length).toBeGreaterThanOrEqual(2);
    for (const f of inputFrames) {
      // 数据切片预算 32KB（JSON 信封 + 转义后仍低于 256KB 帧上限，P1-3 评审修复）
      expect(Buffer.byteLength(f.data as string, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    }
    expect(inputFrames.map((f) => f.data).join('')).toBe(big);
    expect(inputFrames.every((f) => f.terminalId === terminalId)).toBe(true);
  });

  it('主机 open_failed / CWD_MISSING → 释放占位并回固定文案，不假装终端存在', async () => {
    const { relay } = makeRelay();
    const pending = relay.create({ sessionId: 1, userId: 7, deviceId: 'dev-1', workspace: '/gone' });
    const frames = (relay as unknown as { deps: { host: { state: { frames: Array<Record<string, unknown>> } } } }).deps.host.state.frames;
    const open = frames[frames.length - 1]!;
    relay.handleOpenFailed({ userId: 7, deviceId: 'dev-1' }, { terminalId: open.terminalId as string, code: 'CWD_MISSING' });
    await expect(pending).rejects.toSatisfy((e: RelayOpenError) =>
      e instanceof RelayOpenError && e.message === '工作区目录不存在或无法访问' && e.failureCode === 'CWD_MISSING');
    expect(relay.occupiedCount()).toBe(0);
    expect(relay.countForSession(1)).toBe(0);
  });

  it('10 秒无应答 → 超时失败且占位释放', async () => {
    const { relay } = makeRelay();
    const pending = relay.create({ sessionId: 1, userId: 7, deviceId: 'dev-1', workspace: '/home/u/proj' });
    await expect(pending).rejects.toSatisfy((e: RelayOpenError) =>
      e instanceof RelayOpenError && e.message === '执行端未在时限内响应');
    expect(relay.occupiedCount()).toBe(0);
  });

  it('主机不在线 / 发送失败 → 执行端设备离线，不产生 pending', async () => {
    const { relay } = makeRelay({ online: false });
    await expect(relay.create({ sessionId: 1, userId: 7, deviceId: 'dev-1', workspace: '/w' }))
      .rejects.toSatisfy((e: RelayOpenError) => e instanceof RelayOpenError && e.message === '执行端设备离线');
    expect(relay.occupiedCount()).toBe(0);
  });

  it('hostStatus 分支：unsupported / upgrade-cli / upgrade-either 各自文案', async () => {
    const host = makeHost({ online: false });
    const terminalManager = { occupiedCount: () => 0, countForSession: () => 0 };
    for (const [status, message] of [
      ['unsupported', '当前桌面客户端版本不支持远程终端，请升级桌面客户端'],
      ['upgrade-cli', '当前 mao-agent 版本不支持远程终端，请升级后重试'],
      ['upgrade-either', '请升级桌面客户端或 mao-agent 后使用远程终端'],
    ] as const) {
      const relay = new LocalTerminalRelay({
        terminalManager,
        config: CONFIG,
        host,
        hostStatus: { resolve: () => status },
      });
      await expect(relay.create({ sessionId: 1, userId: 7, deviceId: 'dev-1', workspace: '/w' }))
        .rejects.toSatisfy((e: RelayOpenError) => e instanceof RelayOpenError && e.message === message);
    }
  });

  it('配额（D8）：云端 + 中继合并计入每任务与全局上限', async () => {
    // countForSession 按会话区分：任务 1 已有 2 个云端终端，任务 9 为 0
    const terminalManager = { occupiedCount: vi.fn(() => 3), countForSession: vi.fn((id: number) => (id === 1 ? 2 : 0)) };
    const relay = new LocalTerminalRelay({
      terminalManager,
      config: CONFIG,
      host: makeHost(),
      openTimeoutMs: 50,
    });
    // 云端已占 2 个（上限 2）：中继创建被拒
    await expect(relay.create({ sessionId: 1, userId: 7, deviceId: 'dev-1', workspace: '/w' }))
      .rejects.toSatisfy((e: TerminalLimitError) => e instanceof TerminalLimitError && e.message.includes('终端数量已达上限'));
    // 全局：云端占 3（上限 4）+ 中继 0 → 可以创建一个，但第 2 个被拒
    const pending = relay.create({ sessionId: 9, userId: 7, deviceId: 'dev-1', workspace: '/w' });
    const frames = (relay as unknown as { deps: { host: { state: { frames: Array<Record<string, unknown>> } } } }).deps.host.state.frames;
    relay.handleOpened({ userId: 7, deviceId: 'dev-1' }, { terminalId: frames[frames.length - 1]!.terminalId as string, shell: '/bin/bash', cwd: '/w' });
    await pending;
    await expect(relay.create({ sessionId: 9, userId: 7, deviceId: 'dev-1', workspace: '/w' }))
      .rejects.toSatisfy((e: TerminalLimitError) => e instanceof TerminalLimitError && e.message.includes('总数'));
  });

  it('reconcileForDevice：列表之外的登记按 HOST_LOST 关闭并通知观看端', async () => {
    const audits: Array<{ event: TerminalAuditEvent; terminalId: string }> = [];
    const { relay } = makeRelay(undefined, (event, terminal) => audits.push({ event, terminalId: terminal.terminalId }));
    const closed: Array<{ info: { terminalId: string }; reason: string }> = [];
    relay.onClosed((info, reason) => closed.push({ info: { terminalId: info.terminalId }, reason }));

    const { terminal: a } = await created(relay, 1);
    const { terminal: b } = await created(relay, 2);
    relay.reconcileForDevice(7, 'dev-1', new Set([a.terminalId]));
    // b 不在列表 → HOST_LOST；a 保留
    expect(relay.get(a.terminalId)).not.toBeNull();
    expect(relay.get(b.terminalId)).toBeNull();
    expect(closed).toEqual([{ info: { terminalId: b.terminalId }, reason: 'HOST_LOST' }]);
    expect(audits.map((x) => x.event)).toContain('HOST_LOST');
  });

  it('帧归属校验：非本主机的 terminalId 注入被丢弃（P1-8 评审修复）', async () => {
    const { relay } = makeRelay();
    const { terminal, open } = await created(relay, 1);
    const terminalId = open.terminalId as string;
    const foreign = { userId: 8, deviceId: 'dev-9' };
    relay.handleHostOutput(foreign, terminalId, 'injected');
    relay.handleHostExit(foreign, terminalId, 1);
    expect(terminal.readBuffered()).toBe('');
    expect(terminal.isAlive()).toBe(true);
    expect(relay.get(terminalId)).not.toBeNull();
    // pending 侧同理：别人的 opened 不会替我们的占位登记
    const pending = relay.create({ sessionId: 2, userId: 7, deviceId: 'dev-1', workspace: '/w' });
    const frames = (relay as unknown as { deps: { host: { state: { frames: Array<Record<string, unknown>> } } } }).deps.host.state.frames;
    const open2 = frames[frames.length - 1]!;
    relay.handleOpened(foreign, { terminalId: open2.terminalId as string, shell: '/bin/bash', cwd: '/w' });
    await new Promise((r) => setTimeout(r, 5));
    // 别人的 opened 没有替我们的占位登记：pending 仍在（占位 1）+ 已登记 1
    expect(relay.get(open2.terminalId as string)).toBeNull();
    expect(relay.occupiedCount()).toBe(2);
    await expect(pending).rejects.toSatisfy((e: RelayOpenError) => e instanceof RelayOpenError); // 超时正常失败
  });

  it('closeBySession 撤销在途 open 占位（P1-4 评审修复）', async () => {
    const { relay } = makeRelay();
    const pending = relay.create({ sessionId: 3, userId: 7, deviceId: 'dev-1', workspace: '/w' });
    const settled = pending.catch((e: RelayOpenError) => e);
    relay.closeBySession(3);
    await expect(settled).resolves.toSatisfy((e: RelayOpenError) =>
      e instanceof RelayOpenError && e.message === '任务已删除，终端已关闭');
    expect(relay.occupiedCount()).toBe(0);
    expect(relay.countForSession(3)).toBe(0);
  });

  it('handleHostLost：该设备全部登记关闭（RECLAIM/DELETE 之外的 host 丢失原因）', async () => {
    const { relay } = makeRelay();
    const { terminal: a } = await created(relay, 1);
    relay.handleHostLost(7, 'dev-1');
    expect(relay.get(a.terminalId)).toBeNull();
  });

  it('closeBySession：任务删除级联，桥 kill 帧发往主机', async () => {
    const { relay, host } = makeRelay();
    const { terminal, open } = await created(relay, 5);
    relay.closeBySession(5);
    expect(relay.get(terminal.terminalId)).toBeNull();
    expect(host.state.frames.at(-1)).toMatchObject({ type: 'kill', terminalId: open.terminalId as string });
  });

  it('GET 侧 list：按 createdAt 排序返回中继记录', async () => {
    const { relay } = makeRelay();
    const first = await created(relay, 3);
    const second = await created(relay, 3);
    const list = relay.list(3);
    expect(list.map((t) => t.terminalId)).toEqual([first.terminal.terminalId, second.terminal.terminalId]);
    expect(list.every((t) => t.kind === 'local-relay')).toBe(true);
  });
});

describe('sliceUtf8', () => {
  it('ASCII 与中文混合：切点落在字符边界，拼接无损', () => {
    const text = 'a中b文c'.repeat(10_000);
    const chunks = sliceUtf8(text, 1000);
    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(1000);
      expect(Buffer.from(chunk, 'utf8').toString('utf8')).toBe(chunk);
    }
  });

  it('代理对（emoji 4 字节）不拆开', () => {
    const chunks = sliceUtf8('a😀b', 4);
    expect(chunks.join('')).toBe('a😀b');
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.includes('\uFFFD')).toBe(false);
    }
  });

  it('空串与上限 0 不死循环', () => {
    expect(sliceUtf8('', 100)).toEqual(['']);
    expect(sliceUtf8('abc', 0)).toEqual(['abc']);
  });
});
