import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PathSandbox } from '../safety/path-sandbox.js';
import { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';
import { OutputRingBuffer, type PtyFactory, type PtyLike, type SpawnPtyOptions } from './remote-terminal.js';
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  TerminalLimitError,
  TerminalManager,
  TerminalSpawnError,
  clampInt,
  type TerminalAuditEvent,
  type TerminalManagerConfig,
} from './terminal-manager.js';

class FakePty implements PtyLike {
  static instances: FakePty[] = [];
  readonly pid = 1000 + FakePty.instances.length;
  readonly written: string[] = [];
  readonly resized: Array<{ cols: number; rows: number }> = [];
  killed = false;
  readonly options: SpawnPtyOptions;
  private dataCb: ((data: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;

  constructor(options: SpawnPtyOptions) {
    this.options = options;
    FakePty.instances.push(this);
  }

  onData(cb: (data: string) => void): unknown {
    this.dataCb = cb;
    return null;
  }

  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown {
    this.exitCb = cb;
    return null;
  }

  write(data: string): void {
    this.written.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resized.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
  }

  emit(data: string): void {
    this.dataCb?.(data);
  }

  exit(exitCode = 0): void {
    this.exitCb?.({ exitCode });
  }
}

const fakeFactory: PtyFactory = (options) => new FakePty(options);

function config(overrides: Partial<TerminalManagerConfig> = {}): TerminalManagerConfig {
  return {
    maxSessionsPerTask: 2,
    maxSessionsGlobal: 3,
    idleTimeoutMinutes: 120,
    maxLifetimeHours: 24,
    outputBufferBytes: 1024,
    ...overrides,
  };
}

async function newManager(overrides: Partial<TerminalManagerConfig> = {}, extra: {
  audit?: Array<{ event: TerminalAuditEvent; terminalId: string; errorMessage?: string | null }>;
  ptyFactory?: PtyFactory;
  tokenMap?: Record<string, string>;
} = {}): Promise<{ manager: TerminalManager; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'mao-term-'));
  const sandbox = new PathSandbox(root);
  const manager = new TerminalManager({
    pathSandbox: sandbox,
    runtimeResolver: RuntimeDataResolver.forTest(join(root, 'runtime'), join(root, 'users')),
    gitCredentials: extra.tokenMap ? { getTokenMapByUser: async () => extra.tokenMap! } : undefined,
    shellToken: { generateShellToken: (userId, username) => `tok-${userId}-${username}` },
    userLookup: { findById: async (id) => ({ id, username: `user${id}` }) },
    config: config(overrides),
    ptyFactory: extra.ptyFactory ?? fakeFactory,
    audit: extra.audit
      ? (event, terminal, ctx) => extra.audit!.push({ event, terminalId: terminal.terminalId, errorMessage: ctx?.errorMessage ?? null })
      : undefined,
  });
  return { manager, root };
}

beforeEach(() => {
  FakePty.instances = [];
});

describe('OutputRingBuffer', () => {
  it('keeps content under the byte cap and marks truncation on replay', () => {
    const buffer = new OutputRingBuffer(10);
    buffer.append('abcde');
    expect(buffer.read()).toBe('abcde');
    buffer.append('fghij');
    expect(buffer.read()).toBe('abcdefghij');
    buffer.append('klm');
    const replay = buffer.read();
    expect(replay.startsWith('\r\n[历史输出过长，已截断前面部分]\r\n')).toBe(true);
    expect(replay).toContain('klm');
    expect(replay).not.toContain('abcde');
  });

  it('is empty after clear and ignores empty appends', () => {
    const buffer = new OutputRingBuffer(16);
    buffer.append('');
    expect(buffer.isEmpty()).toBe(true);
    expect(buffer.read()).toBe('');
    buffer.append('x');
    buffer.clear();
    expect(buffer.isEmpty()).toBe(true);
    expect(buffer.read()).toBe('');
  });
});

describe('clampInt', () => {
  it('falls back and clamps out-of-range values', () => {
    expect(clampInt(null, 80, 1, 500)).toBe(80);
    expect(clampInt(Number.NaN, 80, 1, 500)).toBe(80);
    expect(clampInt(0, 80, 1, 500)).toBe(1);
    expect(clampInt(9999, 80, 1, 500)).toBe(500);
    expect(clampInt(120.7, 80, 1, 500)).toBe(120);
  });
});

describe('TerminalManager', () => {
  it('creates a terminal with task env, virtual HOME and default rc', async () => {
    const audit: Array<{ event: TerminalAuditEvent; terminalId: string }> = [];
    const { manager, root } = await newManager({}, { audit, tokenMap: { 'git.example.com': 'tok' } });
    const terminal = await manager.create({
      sessionId: 7, userId: 3, workspace: root, taskName: '重构 登录', cols: 120, rows: 40,
    });

    const pty = FakePty.instances[0];
    expect(pty.options.shell).toBe('/bin/bash');
    expect(pty.options.args).toEqual(['-i']);
    expect(pty.options.cwd).toBe(root);
    expect(pty.options.cols).toBe(120);
    expect(pty.options.rows).toBe(40);
    expect(pty.options.env.TERM).toBe('xterm-256color');
    expect(pty.options.env.MAO_TASK_NAME).toBe('重构 登录');
    expect(pty.options.env.HOME).toBe(join(root, 'users', '3'));
    expect(pty.options.env.MAO_TOKEN).toBe('tok-3-user3');
    expect(pty.options.env.GIT_TOKEN_git_example_com).toBe('tok');
    expect(pty.options.env.GIT_ASKPASS).toContain('git-askpass.sh');
    expect(pty.options.env.GIT_TERMINAL_PROMPT).toBe('0');

    const rcPath = join(root, 'users', '3', '.bashrc');
    expect(existsSync(rcPath)).toBe(true);
    expect(readFileSync(rcPath, 'utf8')).toContain('MAO_TASK_NAME');

    expect(terminal.terminalId).toMatch(/^term-7-\d+-[0-9a-f]{8}$/);
    expect(manager.size()).toBe(1);
    expect(audit.map((a) => a.event)).toEqual(['CREATE']);
  });

  it('applies cols/rows defaults and clamping', async () => {
    const { manager, root } = await newManager();
    await manager.create({ sessionId: 1, userId: 1, workspace: root });
    expect(FakePty.instances[0].options.cols).toBe(DEFAULT_TERMINAL_COLS);
    expect(FakePty.instances[0].options.rows).toBe(DEFAULT_TERMINAL_ROWS);
    await manager.create({ sessionId: 1, userId: 1, workspace: root, cols: 100000, rows: -5 });
    expect(FakePty.instances[1].options.cols).toBe(500);
    expect(FakePty.instances[1].options.rows).toBe(1);
  });

  it('falls back to a generated task name when title is blank or unsafe', async () => {
    const { manager, root } = await newManager({ maxSessionsPerTask: 5, maxSessionsGlobal: 5 });
    await manager.create({ sessionId: 9, userId: 1, workspace: root, taskName: '   ' });
    expect(FakePty.instances[0].options.env.MAO_TASK_NAME).toBe('任务 9');
    await manager.create({ sessionId: 9, userId: 1, workspace: root, taskName: "a'b\u0007c" });
    expect(FakePty.instances[1].options.env.MAO_TASK_NAME).toBe('abc');
    // PS1 渲染时 bash 默认展开参数与命令替换，反引号/$ 一并剥离
    await manager.create({ sessionId: 9, userId: 1, workspace: root, taskName: '$(id)`whoami`x' });
    expect(FakePty.instances[2].options.env.MAO_TASK_NAME).toBe('(id)whoamix');
  });

  it('does not overwrite an existing .bashrc', async () => {
    const { manager, root } = await newManager();
    await manager.create({ sessionId: 1, userId: 5, workspace: root });
    const rcPath = join(root, 'users', '5', '.bashrc');
    const original = readFileSync(rcPath, 'utf8');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(rcPath, '# custom', 'utf8');
    await manager.create({ sessionId: 2, userId: 5, workspace: root });
    expect(readFileSync(rcPath, 'utf8')).toBe('# custom');
    expect(original).not.toBe('# custom');
  });

  it('enforces the per-task limit', async () => {
    const { manager, root } = await newManager({ maxSessionsPerTask: 2 });
    await manager.create({ sessionId: 4, userId: 1, workspace: root });
    await manager.create({ sessionId: 4, userId: 1, workspace: root });
    await expect(manager.create({ sessionId: 4, userId: 1, workspace: root }))
      .rejects.toThrow(TerminalLimitError);
    // 其他任务不受影响
    await expect(manager.create({ sessionId: 5, userId: 1, workspace: root })).resolves.toBeTruthy();
  });

  it('enforces the global limit', async () => {
    const { manager, root } = await newManager({ maxSessionsPerTask: 10, maxSessionsGlobal: 2 });
    await manager.create({ sessionId: 1, userId: 1, workspace: root });
    await manager.create({ sessionId: 2, userId: 1, workspace: root });
    await expect(manager.create({ sessionId: 3, userId: 1, workspace: root }))
      .rejects.toThrow(/服务器终端总数已达上限 2/);
  });

  it('counts in-flight creations against the limits', async () => {
    // create 内 buildEnv 有 await：并发创建必须靠占位而非已注册数量来判上限
    const root = await mkdtemp(join(tmpdir(), 'mao-term-'));
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const manager = new TerminalManager({
      pathSandbox: new PathSandbox(root),
      runtimeResolver: RuntimeDataResolver.forTest(join(root, 'runtime'), join(root, 'users')),
      gitCredentials: { getTokenMapByUser: async () => { await gate; return {}; } },
      config: config({ maxSessionsPerTask: 1, maxSessionsGlobal: 1 }),
      ptyFactory: fakeFactory,
    });
    const first = manager.create({ sessionId: 1, userId: 1, workspace: root });
    await expect(manager.create({ sessionId: 1, userId: 1, workspace: root }))
      .rejects.toThrow(TerminalLimitError);
    await expect(manager.create({ sessionId: 2, userId: 1, workspace: root }))
      .rejects.toThrow(/服务器终端总数已达上限 1/);
    release!();
    await expect(first).resolves.toBeTruthy();
    expect(manager.size()).toBe(1);
  });

  it('releases the reserved slot when spawning fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mao-term-'));
    let fail = true;
    const manager = new TerminalManager({
      pathSandbox: new PathSandbox(root),
      runtimeResolver: RuntimeDataResolver.forTest(join(root, 'runtime'), join(root, 'users')),
      config: config({ maxSessionsPerTask: 1, maxSessionsGlobal: 1 }),
      ptyFactory: (options) => {
        if (fail) throw new Error('boom');
        return new FakePty(options);
      },
    });
    await expect(manager.create({ sessionId: 1, userId: 1, workspace: root })).rejects.toThrow(TerminalSpawnError);
    fail = false;
    // 失败不应长期占用每任务/全局配额
    await expect(manager.create({ sessionId: 1, userId: 1, workspace: root })).resolves.toBeTruthy();
    expect(manager.list(1)).toHaveLength(1);
  });

  it('kills a pty whose reservation was cancelled mid-create', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mao-term-'));
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const manager = new TerminalManager({
      pathSandbox: new PathSandbox(root),
      runtimeResolver: RuntimeDataResolver.forTest(join(root, 'runtime'), join(root, 'users')),
      gitCredentials: { getTokenMapByUser: async () => { await gate; return {}; } },
      config: config(),
      ptyFactory: fakeFactory,
    });
    const pending = manager.create({ sessionId: 5, userId: 1, workspace: root });
    // 任务在创建过程中被删除：占位被撤销
    expect(manager.closeBySession(5)).toBe(0);
    release!();
    await expect(pending).rejects.toThrow(TerminalSpawnError);
    expect(manager.size()).toBe(0);
    expect(FakePty.instances[0].killed).toBe(true);
  });

  it('reports filesystem failures as TerminalSpawnError', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mao-term-'));
    const manager = new TerminalManager({
      pathSandbox: new PathSandbox(root),
      // 虚拟 HOME 落在一个普通文件下：mkdirSync 必然失败
      runtimeResolver: RuntimeDataResolver.forTest(join(root, 'runtime'), join(root, 'file-as-dir')),
      config: config(),
      ptyFactory: fakeFactory,
    });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(root, 'file-as-dir'), 'x', 'utf8');
    await expect(manager.create({ sessionId: 1, userId: 1, workspace: root })).rejects.toThrow(TerminalSpawnError);
    expect(manager.size()).toBe(0);
  });

  it('reports spawn failures as TerminalSpawnError and audits them', async () => {
    const audit: Array<{ event: TerminalAuditEvent; terminalId: string; errorMessage?: string | null }> = [];
    const { manager, root } = await newManager({}, {
      audit,
      ptyFactory: () => { throw new Error('boom'); },
    });
    await expect(manager.create({ sessionId: 1, userId: 1, workspace: root }))
      .rejects.toThrow(TerminalSpawnError);
    expect(manager.size()).toBe(0);
    expect(audit).toHaveLength(1);
    expect(audit[0].event).toBe('CREATE');
    expect(audit[0].errorMessage).toBe('boom');
  });

  it('checks ownership on lookup helpers', async () => {
    const { manager, root } = await newManager();
    const terminal = await manager.create({ sessionId: 8, userId: 2, workspace: root });
    expect(manager.getOwned(terminal.terminalId, 8, 2)).toBe(terminal);
    expect(manager.getOwned(terminal.terminalId, 9, 2)).toBeNull();
    expect(manager.getOwned(terminal.terminalId, 8, 3)).toBeNull();
    expect(manager.getOwnedByUser(terminal.terminalId, 2)).toBe(terminal);
    expect(manager.getOwnedByUser(terminal.terminalId, 3)).toBeNull();
    expect(manager.getOwned('term-nope', 8, 2)).toBeNull();
  });

  it('lists terminals of a session ordered by createdAt', async () => {
    const { manager, root } = await newManager({ maxSessionsPerTask: 5, maxSessionsGlobal: 5 });
    const first = await manager.create({ sessionId: 3, userId: 1, workspace: root });
    const second = await manager.create({ sessionId: 3, userId: 1, workspace: root });
    await manager.create({ sessionId: 4, userId: 1, workspace: root });
    const list = manager.list(3);
    expect(list.map((t) => t.terminalId)).toEqual([first.terminalId, second.terminalId]);
    expect(list[0].shell).toBe('/bin/bash');
    expect(list[0].attached).toBe(false);
    expect(manager.list(99)).toEqual([]);
  });

  it('replays buffered output and truncates beyond the cap', async () => {
    const { manager, root } = await newManager({ outputBufferBytes: 8 });
    const terminal = await manager.create({ sessionId: 1, userId: 1, workspace: root });
    const pty = FakePty.instances[0];
    pty.emit('12345678');
    pty.emit('abcd');
    const replay = terminal.readBuffered();
    expect(replay).toContain('[历史输出过长，已截断前面部分]');
    expect(replay).toContain('abcd');
    expect(replay).not.toContain('12345678');
  });

  it('streams output to the attached sink and takes over previous attachments', async () => {
    const { manager, root } = await newManager();
    const terminal = await manager.create({ sessionId: 1, userId: 1, workspace: root });
    const first: string[] = [];
    const second: string[] = [];
    expect(terminal.attach('sock-1', (d) => first.push(d))).toBeNull();
    FakePty.instances[0].emit('hello');
    expect(first).toEqual(['hello']);

    const replaced = terminal.attach('sock-2', (d) => second.push(d));
    expect(replaced).toBe('sock-1');
    FakePty.instances[0].emit('world');
    expect(first).toEqual(['hello']);
    expect(second).toEqual(['world']);

    // 旧连接的 close 不应解绑新连接
    expect(terminal.detach('sock-1')).toBe(false);
    expect(terminal.isAttached()).toBe(true);
    expect(terminal.attachedSocketId()).toBe('sock-2');
    expect(terminal.detach('sock-2')).toBe(true);
    expect(terminal.isAttached()).toBe(false);
  });

  it('writes input and resizes the pty', async () => {
    const { manager, root } = await newManager();
    const terminal = await manager.create({ sessionId: 1, userId: 1, workspace: root });
    terminal.write('ls\r');
    terminal.resize(100, 30);
    expect(FakePty.instances[0].written).toEqual(['ls\r']);
    expect(FakePty.instances[0].resized).toEqual([{ cols: 100, rows: 30 }]);
    expect(terminal.toInfo().cols).toBe(100);
    expect(terminal.toInfo().rows).toBe(30);
  });

  it('drops terminals from the registry once the pty exits by itself', async () => {
    const { manager, root } = await newManager();
    const terminal = await manager.create({ sessionId: 6, userId: 1, workspace: root });
    const exits: number[] = [];
    terminal.onExit((code) => exits.push(code));
    FakePty.instances[0].exit(3);
    expect(exits).toEqual([3]);
    expect(manager.get(terminal.terminalId)).toBeNull();
    expect(manager.list(6)).toEqual([]);
    expect(manager.size()).toBe(0);
    // 退出后写入与 resize 不应触碰已死 PTY
    terminal.write('x');
    terminal.resize(10, 10);
    expect(FakePty.instances[0].written).toEqual([]);
    expect(FakePty.instances[0].resized).toEqual([]);
  });

  it('closes terminals and reports idempotently', async () => {
    const audit: Array<{ event: TerminalAuditEvent; terminalId: string }> = [];
    const { manager, root } = await newManager({}, { audit });
    const terminal = await manager.create({ sessionId: 1, userId: 1, workspace: root });
    expect(manager.close(terminal.terminalId)).toBe(true);
    expect(FakePty.instances[0].killed).toBe(true);
    expect(manager.close(terminal.terminalId)).toBe(false);
    expect(audit.map((a) => a.event)).toEqual(['CREATE', 'CLOSE']);
  });

  it('closes every terminal of a session with the SESSION_DELETED audit event', async () => {
    const audit: Array<{ event: TerminalAuditEvent; terminalId: string }> = [];
    const { manager, root } = await newManager({ maxSessionsPerTask: 5, maxSessionsGlobal: 5 }, { audit });
    await manager.create({ sessionId: 12, userId: 1, workspace: root });
    await manager.create({ sessionId: 12, userId: 1, workspace: root });
    await manager.create({ sessionId: 13, userId: 1, workspace: root });
    expect(manager.closeBySession(12)).toBe(2);
    expect(manager.list(12)).toEqual([]);
    expect(manager.size()).toBe(1);
    expect(manager.closeBySession(12)).toBe(0);
    expect(audit.filter((a) => a.event === 'SESSION_DELETED')).toHaveLength(2);
  });

  it('closeAll kills every pty', async () => {
    const { manager, root } = await newManager({ maxSessionsPerTask: 5, maxSessionsGlobal: 5 });
    await manager.create({ sessionId: 1, userId: 1, workspace: root });
    await manager.create({ sessionId: 2, userId: 1, workspace: root });
    manager.closeAll();
    expect(manager.size()).toBe(0);
    expect(FakePty.instances.every((p) => p.killed)).toBe(true);
  });

  it('reclaims idle terminals and notifies listeners', async () => {
    const audit: Array<{ event: TerminalAuditEvent; terminalId: string }> = [];
    const { manager, root } = await newManager({ idleTimeoutMinutes: 1 }, { audit });
    const terminal = await manager.create({ sessionId: 1, userId: 1, workspace: root });
    const reclaimed: Array<{ terminalId: string; reason: string }> = [];
    manager.onClosed((info, reason) => reclaimed.push({ terminalId: info.terminalId, reason }));

    expect(manager.cleanupExpired()).toEqual([]);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2 * 60_000);
    try {
      const result = manager.cleanupExpired();
      expect(result.map((r) => r.terminalId)).toEqual([terminal.terminalId]);
    } finally {
      vi.useRealTimers();
    }
    expect(reclaimed).toEqual([{ terminalId: terminal.terminalId, reason: 'RECLAIM' }]);
    expect(manager.size()).toBe(0);
    expect(audit.some((a) => a.event === 'RECLAIM')).toBe(true);
  });

  it('never reclaims a terminal that is still attached', async () => {
    const { manager, root } = await newManager({ idleTimeoutMinutes: 1 });
    const terminal = await manager.create({ sessionId: 1, userId: 1, workspace: root });
    terminal.attach('sock-1', () => {});
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10 * 60_000);
    try {
      expect(manager.cleanupExpired()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
    expect(manager.size()).toBe(1);
  });

  it('reclaims terminals beyond max lifetime even while attached', async () => {
    const { manager, root } = await newManager({ maxLifetimeHours: 1 });
    const terminal = await manager.create({ sessionId: 1, userId: 1, workspace: root });
    terminal.attach('sock-1', () => {});
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2 * 3600_000);
    try {
      expect(manager.cleanupExpired().map((r) => r.terminalId)).toEqual([terminal.terminalId]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('prunes dead terminals during cleanup and before applying limits', async () => {
    const { manager, root } = await newManager({ maxSessionsPerTask: 1, maxSessionsGlobal: 1 });
    await manager.create({ sessionId: 1, userId: 1, workspace: root });
    FakePty.instances[0].exit(0);
    // 已退出的终端不占用配额
    await expect(manager.create({ sessionId: 1, userId: 1, workspace: root })).resolves.toBeTruthy();
    expect(manager.cleanupExpired()).toEqual([]);
  });

  it('startCleanup is idempotent and stoppable', async () => {
    const { manager } = await newManager();
    const spy = vi.spyOn(global, 'setInterval');
    manager.startCleanup(1000);
    manager.startCleanup(1000);
    expect(spy).toHaveBeenCalledTimes(1);
    manager.stopCleanup();
    manager.stopCleanup();
    spy.mockRestore();
  });

  it('survives git credential lookup failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mao-term-'));
    const manager = new TerminalManager({
      pathSandbox: new PathSandbox(root),
      runtimeResolver: RuntimeDataResolver.forTest(join(root, 'runtime'), join(root, 'users')),
      gitCredentials: { getTokenMapByUser: async () => { throw new Error('db down'); } },
      config: config(),
      ptyFactory: fakeFactory,
    });
    const terminal = await manager.create({ sessionId: 1, userId: 1, workspace: root });
    expect(terminal.isAlive()).toBe(true);
    // 凭据查询失败不写入 GIT_ASKPASS（继承 process.env 的原值不变）
    expect(FakePty.instances[0].options.env.GIT_ASKPASS).toBe(process.env.GIT_ASKPASS);
    expect(FakePty.instances[0].options.env.GIT_TERMINAL_PROMPT).toBe(process.env.GIT_TERMINAL_PROMPT);
  });

  it('uses the username from params without touching userLookup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mao-term-'));
    const findById = vi.fn(async (id: number) => ({ id, username: `user${id}` }));
    const manager = new TerminalManager({
      pathSandbox: new PathSandbox(root),
      runtimeResolver: RuntimeDataResolver.forTest(join(root, 'runtime'), join(root, 'users')),
      shellToken: { generateShellToken: (userId, username) => `tok-${userId}-${username}` },
      userLookup: { findById },
      config: config(),
      ptyFactory: fakeFactory,
    });
    await manager.create({ sessionId: 1, userId: 4, workspace: root, username: 'alice' });
    expect(findById).not.toHaveBeenCalled();
    expect(FakePty.instances[0].options.env.MAO_TOKEN).toBe('tok-4-alice');
  });
});
