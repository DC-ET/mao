import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { TerminalHost, detectShell, sliceUtf8, type HostPtyLike } from './terminal-host';

/**
 * 终端主机（技术方案 2026-11-18-local-terminal-remote §4.7）：
 * 工厂注入 spawn；信任根外的 cwd 回 CWD_MISSING 且不 spawn；standby 忽略 open；
 * 收到服务器断开（4000 replaced）后由 close 路径收敛。真实 node-pty 不进模块图。
 */

class FakePty implements HostPtyLike {
  static instances: FakePty[] = [];
  readonly written: string[] = [];
  readonly resized: Array<{ cols: number; rows: number }> = [];
  killed = false;
  private dataCb: ((data: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number }) => void) | null = null;
  constructor(readonly options: { shell: string; cols: number; rows: number; cwd: string }) {
    FakePty.instances.push(this);
  }
  onData(cb: (data: string) => void): void { this.dataCb = cb; }
  onExit(cb: (e: { exitCode: number }) => void): void { this.exitCb = cb; }
  write(data: string): void { this.written.push(data); }
  resize(cols: number, rows: number): void { this.resized.push({ cols, rows }); }
  kill(): void { this.killed = true; }
  emit(data: string): void { this.dataCb?.(data); }
  exit(exitCode = 0): void { this.exitCb?.({ exitCode }); }
}

type Frame = Record<string, unknown>;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = FakeWebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: Frame[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private openCb: (() => void) | null = null;
  private closeCb: ((code?: number) => void) | null = null;
  private messageCb: ((raw: Buffer) => void) | null = null;
  constructor(public url: string, _opts?: unknown) {
    FakeWebSocket.instances.push(this);
  }
  on(event: string, cb: never): void {
    if (event === 'open') this.openCb = cb as () => void;
    if (event === 'close') this.closeCb = cb as (code?: number) => void;
    if (event === 'message') this.messageCb = cb as (raw: Buffer) => void;
  }
  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as Frame);
  }
  close(code?: number, reason?: string): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.closedWith = { code, reason };
    this.closeCb?.(code);
  }
  // 测试驱动
  emitOpen(): void { this.openCb?.(); }
  receive(frame: Frame): void { this.messageCb?.(Buffer.from(JSON.stringify(frame))); }
  frames(type: string): Frame[] { return this.sent.filter((f) => f.type === type); }
}

function makeHost(tmp: string, overrides: Partial<{ workspace: string; role: string }> = {}) {
  const spawned: FakePty[] = [];
  const debug: string[] = [];
  const host = new TerminalHost({
    baseUrl: 'http://localhost:9080/api/v1',
    getToken: async () => 'token-1',
    deviceId: 'dev-1',
    workspace: overrides.workspace ?? tmp,
    debug: (m) => debug.push(m),
    ptyFactory: (shell, cols, rows, cwd) => {
      const pty = new FakePty({ shell, cols, rows, cwd });
      spawned.push(pty);
      return pty;
    },
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    heartbeatIntervalMs: 60_000,
  });
  return { host, spawned, debug };
}

/** 连接并推到 connected（active 或 standby）。 */
function connect(host: TerminalHost, role = 'active'): FakeWebSocket {
  void host.start();
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.emitOpen();
  socket.receive({ type: 'connected', userId: 7, role });
  return socket;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakePty.instances = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('TerminalHost（mao-agent）', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-cli-terminal-host-'));
  });

  it('信任根内的 cwd：工厂 spawn 并回 opened；信任根外回 CWD_MISSING 且不 spawn', async () => {
    const { host, spawned } = makeHost(tmp);
    const socket = connect(host);
    const inside = fs.mkdtempSync(path.join(tmp, 'ws-'));

    socket.receive({ type: 'open', terminalId: 't1', cwd: inside, cols: 100, rows: 30 });
    await vi.waitFor(() => expect(socket.frames('opened')).toHaveLength(1));
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.options.cwd).toBe(inside);
    expect(spawned[0]!.options.cols).toBe(100);
    expect(socket.frames('opened')[0]).toMatchObject({ terminalId: 't1', cwd: inside });

    // 信任根外（服务端可能把 workspace 指到 /）：不 spawn、不泄漏路径细节
    socket.receive({ type: 'open', terminalId: 't2', cwd: '/etc', cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.frames('open_failed')).toHaveLength(1));
    expect(socket.frames('open_failed')[0]).toMatchObject({ terminalId: 't2', code: 'CWD_MISSING' });
    expect(spawned).toHaveLength(1);
    host.shutdown();
  });

  it('目录不存在：CWD_MISSING', async () => {
    const { host, spawned } = makeHost(tmp);
    const socket = connect(host);
    socket.receive({ type: 'open', terminalId: 't3', cwd: path.join(tmp, 'gone') });
    await vi.waitFor(() => expect(socket.frames('open_failed')).toHaveLength(1));
    expect(socket.frames('open_failed')[0]).toMatchObject({ code: 'CWD_MISSING' });
    expect(spawned).toHaveLength(0);
    host.shutdown();
  });

  it("role: 'standby' 期间忽略 open；unknown id 的 input/resize/kill 忽略", async () => {
    const { host, spawned } = makeHost(tmp);
    const socket = connect(host, 'standby');
    const inside = fs.mkdtempSync(path.join(tmp, 'ws-'));
    socket.receive({ type: 'open', terminalId: 't1', cwd: inside });
    await new Promise((r) => setTimeout(r, 20));
    expect(spawned).toHaveLength(0);
    expect(socket.frames('opened')).toHaveLength(0);
    expect(socket.frames('open_failed')).toHaveLength(0);

    socket.receive({ type: 'input', terminalId: 'unknown', data: 'rm -rf /' });
    expect(host.terminalIds()).toHaveLength(0);
    host.shutdown();
  });

  it('output 切片进帧；input/resize/kill 作用于中继 map；PTY 退出上送 exit 并摘除', async () => {
    const { host, spawned } = makeHost(tmp);
    const socket = connect(host);
    const inside = fs.mkdtempSync(path.join(tmp, 'ws-'));
    socket.receive({ type: 'open', terminalId: 't1', cwd: inside });
    await vi.waitFor(() => expect(socket.frames('opened')).toHaveLength(1));
    const pty = spawned[0]!;

    const big = '中'.repeat(90_000);
    pty.emit(big);
    const outputs = socket.frames('output');
    expect(outputs.length).toBeGreaterThanOrEqual(2);
    expect(outputs.map((f) => f.data as string).join('')).toBe(big);
    for (const f of outputs) {
      // 数据切片预算 32KB（JSON 信封 + 转义后仍低于 256KB 帧上限）
      expect(Buffer.byteLength(f.data as string, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    }

    socket.receive({ type: 'input', terminalId: 't1', data: 'ls\r\n' });
    socket.receive({ type: 'resize', terminalId: 't1', cols: 120, rows: 40 });
    expect(pty.written).toEqual(['ls\r\n']);
    expect(pty.resized).toEqual([{ cols: 120, rows: 40 }]);

    pty.exit(3);
    expect(socket.frames('exit').at(-1)).toMatchObject({ terminalId: 't1', exitCode: 3 });
    expect(host.terminalIds()).toHaveLength(0);
    host.shutdown();
  });

  it('服务器 4000 replaced（close）：杀掉本进程 map 里的中继 PTY（§4.5/§4.7）', async () => {
    const { host, spawned } = makeHost(tmp);
    const socket = connect(host);
    const inside = fs.mkdtempSync(path.join(tmp, 'ws-'));
    socket.receive({ type: 'open', terminalId: 't1', cwd: inside });
    await vi.waitFor(() => expect(socket.frames('opened')).toHaveLength(1));
    const pty = spawned[0]!;

    socket.close(4000, 'replaced');
    expect(pty.killed).toBe(true);
    expect(host.terminalIds()).toHaveLength(0);
    host.shutdown();
  });

  it('shutdown：杀掉全部中继 PTY', async () => {
    const { host, spawned } = makeHost(tmp);
    const socket = connect(host);
    const inside = fs.mkdtempSync(path.join(tmp, 'ws-'));
    socket.receive({ type: 'open', terminalId: 't1', cwd: inside });
    await vi.waitFor(() => expect(socket.frames('opened')).toHaveLength(1));
    host.shutdown();
    expect(spawned[0]!.killed).toBe(true);
    expect(host.terminalIds()).toHaveLength(0);
    expect(socket.closedWith?.code).toBe(1000);
  });
});

describe('终端主机纯函数与模块图', () => {
  it('detectShell：SHELL 优先，darwin /bin/zsh，其它 /bin/bash', () => {
    const prev = process.env.SHELL;
    process.env.SHELL = '/bin/fish';
    expect(detectShell()).toBe('/bin/fish');
    delete process.env.SHELL;
    expect(detectShell('darwin')).toBe('/bin/zsh');
    expect(detectShell('win32')).toBe('/bin/bash');
    if (prev != null) process.env.SHELL = prev;
  });

  it('sliceUtf8：代理对不拆开，拼接无损', () => {
    const text = 'a中b😀c'.repeat(1000);
    const chunks = sliceUtf8(text, 1024);
    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(1024);
    }
  });

  it('executor.ts / file-ops.ts / ws-client.ts 的模块图里没有 node-pty（§4.7）', () => {
    for (const file of ['src/local/executor.ts', 'src/local/file-ops.ts', 'src/ws/ws-client.ts']) {
      const source = fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
      expect(source, `${file} 不得引用 node-pty（ubuntu --ignore-scripts 下顶层 import 会让测试崩）`).not.toMatch(/node-pty/);
    }
  });
});
