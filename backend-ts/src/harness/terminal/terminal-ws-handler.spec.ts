import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteTerminalInfo } from './remote-terminal.js';
import type { TerminalCloseReason } from './terminal-manager.js';
import {
  MAX_UNAUTHENTICATED_FRAMES,
  OUTPUT_BACKPRESSURE_BYTES,
  TERMINAL_WS_OPEN,
  TerminalWsHandler,
  type AttachableTerminal,
  type TerminalSocket,
} from './terminal-ws-handler.js';

class FakeSocket implements TerminalSocket {
  readyState = TERMINAL_WS_OPEN;
  bufferedAmount = 0;
  ip = '10.0.0.1';
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

class FakeTerminal implements AttachableTerminal {
  readonly written: string[] = [];
  readonly resized: Array<{ cols: number; rows: number }> = [];
  buffered = '';
  private sink: { socketId: string; onOutput: (data: string) => void } | null = null;
  private exitListeners: Array<(exitCode: number) => void> = [];

  constructor(readonly terminalId: string, readonly sessionId: number, readonly userId: number) {}

  attach(socketId: string, onOutput: (data: string) => void): string | null {
    const previous = this.sink != null && this.sink.socketId !== socketId ? this.sink.socketId : null;
    this.sink = { socketId, onOutput };
    return previous;
  }

  detach(socketId: string): boolean {
    if (this.sink == null || this.sink.socketId !== socketId) return false;
    this.sink = null;
    return true;
  }

  attachedSocketId(): string | null {
    return this.sink?.socketId ?? null;
  }

  readBuffered(): string {
    return this.buffered;
  }

  write(data: string): void {
    this.written.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resized.push({ cols, rows });
  }

  onExit(listener: (exitCode: number) => void): void {
    this.exitListeners.push(listener);
  }

  toInfo(): RemoteTerminalInfo {
    return {
      terminalId: this.terminalId,
      sessionId: this.sessionId,
      userId: this.userId,
      shell: '/bin/bash',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      createdAt: 1,
      lastActiveAt: 2,
      attached: this.sink != null,
    };
  }

  emit(data: string): void {
    this.sink?.onOutput(data);
  }

  fireExit(code = 0): void {
    for (const listener of this.exitListeners) listener(code);
    this.exitListeners = [];
  }

  exitListenerCount(): number {
    return this.exitListeners.length;
  }
}

class FakeRegistry {
  readonly terminals = new Map<string, FakeTerminal>();
  closeListener: ((info: RemoteTerminalInfo, reason: TerminalCloseReason) => void) | null = null;

  add(terminal: FakeTerminal): FakeTerminal {
    this.terminals.set(terminal.terminalId, terminal);
    return terminal;
  }

  get(terminalId: string): AttachableTerminal | null {
    return this.terminals.get(terminalId) ?? null;
  }

  onClosed(listener: (info: RemoteTerminalInfo, reason: TerminalCloseReason) => void): void {
    this.closeListener = listener;
  }
}

const VALID_TOKEN = 'valid-token';

interface Harness {
  handler: TerminalWsHandler;
  registry: FakeRegistry;
  audit: Array<{ event: string; terminalId: string }>;
  permission: { hasPermission: ReturnType<typeof vi.fn> };
}

function newHarness(options: { permitted?: boolean; permissionDelayed?: boolean } = {}): Harness {
  const registry = new FakeRegistry();
  const audit: Array<{ event: string; terminalId: string }> = [];
  const permission = {
    hasPermission: vi.fn(async () => {
      // 模拟一次真实 DB 往返，用于验证同连接的帧处理串行化
      if (options.permissionDelayed) await new Promise((resolve) => setImmediate(resolve));
      return options.permitted ?? true;
    }),
  };
  const handler = new TerminalWsHandler({
    terminalManager: registry,
    jwtService: {
      validateAccessToken: (token) => token === VALID_TOKEN,
      getUserIdFromToken: () => 7,
      getUsernameFromToken: () => 'alice',
    },
    permissionService: permission,
    audit: (event, terminal) => audit.push({ event, terminalId: terminal.terminalId }),
  });
  return { handler, registry, audit, permission };
}

async function authed(harness: Harness, socketId = 'sock-1'): Promise<FakeSocket> {
  const socket = new FakeSocket(socketId);
  await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'auth', token: VALID_TOKEN }));
  return socket;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('TerminalWsHandler auth', () => {
  it('accepts the first auth frame and replies connected', async () => {
    const harness = newHarness();
    const socket = await authed(harness);
    expect(socket.sent).toEqual([{ type: 'connected', userId: 7 }]);
    expect(harness.handler.connectionCount()).toBe(1);
  });

  it('tolerates a few pre-auth frames but closes after the threshold', async () => {
    const harness = newHarness();
    const socket = new FakeSocket('sock-x');
    const frame = JSON.stringify({ type: 'input', terminalId: 't', data: 'x' });
    for (let i = 0; i < MAX_UNAUTHENTICATED_FRAMES - 1; i++) {
      await harness.handler.handleTextMessage(socket, frame);
    }
    expect(socket.closed).toBeNull();
    await harness.handler.handleTextMessage(socket, frame);
    expect(socket.closed).toEqual({ code: 1003, reason: 'Not authenticated' });
    expect(harness.handler.connectionCount()).toBe(0);
  });

  it('authenticates even when attach frames arrive before auth is processed', async () => {
    const harness = newHarness();
    const terminal = harness.registry.add(new FakeTerminal('t1', 1, 7));
    const socket = new FakeSocket('sock-race');
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'attach', terminalId: 't1' }));
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'auth', token: VALID_TOKEN }));
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'attach', terminalId: 't1' }));
    expect(socket.closed).toBeNull();
    expect(terminal.attachedSocketId()).toBe('sock-race');
  });

  it('serializes frames per connection so input right after attach is not rejected', async () => {
    // attach 内含权限查库（await），若不串行化，紧随的 input/resize 会看到「未绑定」而被拒
    const harness = newHarness({ permissionDelayed: true });
    const terminal = harness.registry.add(new FakeTerminal('t1', 1, 7));
    const socket = await authed(harness, 'sock-seq');
    const frames = [
      harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'attach', terminalId: 't1' })),
      harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'resize', terminalId: 't1', cols: 100, rows: 30 })),
      harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'input', terminalId: 't1', data: 'ls\r' })),
    ];
    await Promise.all(frames);
    expect(socket.frames('error')).toEqual([]);
    expect(terminal.resized).toEqual([{ cols: 100, rows: 30 }]);
    expect(terminal.written).toEqual(['ls\r']);
  });

  it('does not bind the terminal when the connection closes during the permission lookup', async () => {
    // attach 停在权限查库的 await 上时连接断开：afterConnectionClosed 看不到本次 attach，
    // 若不复核连接有效性，sink 会挂在死连接上导致终端永不进 idle 回收
    const harness = newHarness({ permissionDelayed: true });
    const terminal = harness.registry.add(new FakeTerminal('t1', 1, 7));
    const socket = await authed(harness, 'sock-late');
    const inflight = harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'attach', terminalId: 't1' }));
    // 让 attach 先进入 await，再断开连接
    await Promise.resolve();
    expect(harness.permission.hasPermission).toHaveBeenCalledTimes(1);
    socket.readyState = 3;
    harness.handler.afterConnectionClosed(socket);
    await inflight;

    expect(terminal.attachedSocketId()).toBeNull();
    expect(terminal.toInfo().attached).toBe(false);
    expect(harness.audit).toEqual([]);
    expect(harness.handler.connectionCount()).toBe(0);
  });

  it('closes connections with an invalid token', async () => {
    const harness = newHarness();
    const socket = new FakeSocket('sock-y');
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'auth', token: 'nope' }));
    expect(socket.closed).toEqual({ code: 1003, reason: 'Missing or invalid token' });
    expect(harness.handler.connectionCount()).toBe(0);
  });

  it('ignores malformed payloads and typeless frames', async () => {
    const harness = newHarness();
    const socket = new FakeSocket('sock-z');
    await harness.handler.handleTextMessage(socket, 'not-json');
    await harness.handler.handleTextMessage(socket, JSON.stringify({ token: VALID_TOKEN }));
    expect(socket.sent).toEqual([]);
    expect(socket.closed).toBeNull();
  });

  it('is idempotent when an authenticated connection re-sends auth', async () => {
    const harness = newHarness();
    const socket = await authed(harness);
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'auth', token: VALID_TOKEN }));
    expect(socket.frames('connected')).toHaveLength(2);
    expect(harness.handler.connectionCount()).toBe(1);
  });
});

describe('TerminalWsHandler attach', () => {
  it('attaches, replays buffered output and audits', async () => {
    const harness = newHarness();
    const terminal = harness.registry.add(new FakeTerminal('t1', 3, 7));
    terminal.buffered = 'history';
    const socket = await authed(harness);
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'attach', terminalId: 't1' }));

    expect(socket.sent[1]).toEqual({ type: 'attached', terminalId: 't1', cols: 80, rows: 24 });
    expect(socket.sent[2]).toEqual({ type: 'output', terminalId: 't1', data: 'history' });
    expect(harness.audit).toEqual([{ event: 'ATTACH', terminalId: 't1' }]);
    terminal.emit('live');
    expect(socket.last()).toEqual({ type: 'output', terminalId: 't1', data: 'live' });
  });

  it('skips the replay frame when the buffer is empty', async () => {
    const harness = newHarness();
    harness.registry.add(new FakeTerminal('t1', 3, 7));
    const socket = await authed(harness);
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'attach', terminalId: 't1' }));
    expect(socket.frames('output')).toHaveLength(0);
  });

  it('rejects attach without terminalId', async () => {
    const harness = newHarness();
    const socket = await authed(harness);
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'attach' }));
    expect(socket.last()).toMatchObject({ type: 'error', code: 'BAD_REQUEST' });
  });

  it('rejects attach without the terminal:use permission', async () => {
    const harness = newHarness({ permitted: false });
    harness.registry.add(new FakeTerminal('t1', 3, 7));
    const socket = await authed(harness);
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'attach', terminalId: 't1' }));
    expect(socket.last()).toMatchObject({ type: 'error', terminalId: 't1', code: 'TERMINAL_FORBIDDEN' });
    expect(harness.audit).toEqual([]);
  });

  it('reports missing terminals', async () => {
    const harness = newHarness();
    const socket = await authed(harness);
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'attach', terminalId: 'gone' }));
    expect(socket.last()).toMatchObject({ type: 'error', terminalId: 'gone', code: 'TERMINAL_NOT_FOUND' });
  });

  it("rejects attaching another user's terminal", async () => {
    const harness = newHarness();
    harness.registry.add(new FakeTerminal('t-other', 3, 99));
    const socket = await authed(harness);
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'attach', terminalId: 't-other' }));
    expect(socket.last()).toMatchObject({ type: 'error', terminalId: 't-other', code: 'TERMINAL_FORBIDDEN' });
  });

  it('takes over a terminal attached by another connection', async () => {
    const harness = newHarness();
    const terminal = harness.registry.add(new FakeTerminal('t1', 3, 7));
    const first = await authed(harness, 'sock-1');
    await harness.handler.handleTextMessage(first, JSON.stringify({ type: 'attach', terminalId: 't1' }));
    const second = await authed(harness, 'sock-2');
    await harness.handler.handleTextMessage(second, JSON.stringify({ type: 'attach', terminalId: 't1' }));

    expect(first.last()).toMatchObject({ type: 'error', terminalId: 't1', code: 'TERMINAL_TAKEN_OVER' });
    expect(second.frames('attached')).toHaveLength(1);
    terminal.emit('after');
    expect(second.last()).toEqual({ type: 'output', terminalId: 't1', data: 'after' });
    // 旧连接不再收到输出，也不再能写入
    await harness.handler.handleTextMessage(first, JSON.stringify({ type: 'input', terminalId: 't1', data: 'x' }));
    expect(first.last()).toMatchObject({ type: 'error', code: 'TERMINAL_FORBIDDEN' });
    expect(terminal.written).toEqual([]);
  });

  it('registers the exit listener only once per terminal', async () => {
    const harness = newHarness();
    const terminal = harness.registry.add(new FakeTerminal('t1', 3, 7));
    const socket = await authed(harness);
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'attach', terminalId: 't1' }));
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'attach', terminalId: 't1' }));
    expect(terminal.exitListenerCount()).toBe(1);
  });
});

describe('TerminalWsHandler messages', () => {
  async function attached(): Promise<{ harness: Harness; socket: FakeSocket; terminal: FakeTerminal }> {
    const harness = newHarness();
    const terminal = harness.registry.add(new FakeTerminal('t1', 3, 7));
    const socket = await authed(harness);
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'attach', terminalId: 't1' }));
    return { harness, socket, terminal };
  }

  it('forwards input to the pty', async () => {
    const { harness, socket, terminal } = await attached();
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'input', terminalId: 't1', data: 'ls\r' }));
    expect(terminal.written).toEqual(['ls\r']);
  });

  it('rejects input frames without data', async () => {
    const { harness, socket, terminal } = await attached();
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'input', terminalId: 't1' }));
    expect(socket.last()).toMatchObject({ type: 'error', code: 'BAD_REQUEST' });
    expect(terminal.written).toEqual([]);
  });

  it('forwards resize with clamping and defaults', async () => {
    const { harness, socket, terminal } = await attached();
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'resize', terminalId: 't1', cols: 120, rows: 40 }));
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'resize', terminalId: 't1', cols: 99999, rows: 0 }));
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'resize', terminalId: 't1' }));
    expect(terminal.resized).toEqual([
      { cols: 120, rows: 40 },
      { cols: 500, rows: 1 },
      { cols: 80, rows: 24 },
    ]);
  });

  it('answers ping with pong', async () => {
    const { harness, socket } = await attached();
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'ping' }));
    expect(socket.last()).toEqual({ type: 'pong' });
  });

  it('rejects unknown message types', async () => {
    const { harness, socket } = await attached();
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'nope' }));
    expect(socket.last()).toMatchObject({ type: 'error', code: 'BAD_REQUEST' });
  });

  it('detach unbinds without killing the pty', async () => {
    const { harness, socket, terminal } = await attached();
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'detach', terminalId: 't1' }));
    expect(terminal.attachedSocketId()).toBeNull();
    terminal.emit('ignored');
    expect(socket.frames('output')).toHaveLength(0);
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'input', terminalId: 't1', data: 'x' }));
    expect(socket.last()).toMatchObject({ type: 'error', code: 'TERMINAL_FORBIDDEN' });
  });

  it('rejects detach without terminalId', async () => {
    const { harness, socket } = await attached();
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'detach' }));
    expect(socket.last()).toMatchObject({ type: 'error', code: 'BAD_REQUEST' });
  });

  it('reports terminals that disappeared between frames', async () => {
    const { harness, socket } = await attached();
    harness.registry.terminals.delete('t1');
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'input', terminalId: 't1', data: 'x' }));
    expect(socket.last()).toMatchObject({ type: 'error', terminalId: 't1', code: 'TERMINAL_NOT_FOUND' });
  });

  it('detaches every terminal of a closed connection without killing them', async () => {
    const { harness, socket, terminal } = await attached();
    harness.handler.afterConnectionClosed(socket);
    expect(harness.handler.connectionCount()).toBe(0);
    expect(terminal.attachedSocketId()).toBeNull();
    // 幂等：重复 close 不抛错
    harness.handler.afterConnectionClosed(socket);
  });

  it('treats transport errors as a closed connection', async () => {
    const { harness, socket, terminal } = await attached();
    harness.handler.handleTransportError(socket);
    expect(harness.handler.connectionCount()).toBe(0);
    expect(terminal.attachedSocketId()).toBeNull();
  });

  it('broadcasts exit frames and forgets the terminal', async () => {
    const { harness, socket, terminal } = await attached();
    terminal.fireExit(3);
    expect(socket.last()).toEqual({ type: 'exit', terminalId: 't1', exitCode: 3 });
    harness.registry.terminals.delete('t1');
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'input', terminalId: 't1', data: 'x' }));
    expect(socket.last()).toMatchObject({ code: 'TERMINAL_NOT_FOUND' });
  });

  it('notifies attached connections when a terminal is reclaimed', async () => {
    const { harness, socket, terminal } = await attached();
    harness.registry.closeListener?.(terminal.toInfo(), 'RECLAIM');
    expect(socket.last()).toMatchObject({ type: 'error', terminalId: 't1', code: 'TERMINAL_RECLAIMED' });
  });

  it('notifies attached connections when a terminal is closed via REST', async () => {
    const { harness, socket, terminal } = await attached();
    expect(terminal.exitListenerCount()).toBe(1);
    harness.registry.closeListener?.(terminal.toInfo(), 'CLOSE');
    expect(socket.last()).toMatchObject({ type: 'error', terminalId: 't1', code: 'TERMINAL_RECLAIMED', message: '终端已关闭' });
    // 关闭通知已清理 exitHooked：重新 attach 会再挂一次监听，不会因残留而漏发 exit
    harness.registry.terminals.set('t1', terminal);
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'attach', terminalId: 't1' }));
    expect(terminal.exitListenerCount()).toBe(2);
  });

  it('reports session deletion with a dedicated message', async () => {
    const { harness, socket, terminal } = await attached();
    harness.registry.closeListener?.(terminal.toInfo(), 'SESSION_DELETED');
    expect(socket.last()).toMatchObject({ code: 'TERMINAL_RECLAIMED', message: '任务已删除，终端已关闭' });
  });

  it('does not send to sockets that are no longer open', async () => {
    const { harness, socket, terminal } = await attached();
    const before = socket.sent.length;
    socket.readyState = 3;
    terminal.emit('data');
    await harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'ping' }));
    expect(socket.sent).toHaveLength(before);
  });

  it('drops output frames under backpressure and prepends a notice on recovery', async () => {
    const { harness, socket, terminal } = await attached();
    void harness;
    const before = socket.sent.length;
    socket.bufferedAmount = OUTPUT_BACKPRESSURE_BYTES + 1;
    terminal.emit('flood-1');
    terminal.emit('flood-2');
    expect(socket.sent).toHaveLength(before);

    socket.bufferedAmount = 0;
    terminal.emit('recovered');
    expect(socket.last()).toEqual({
      type: 'output',
      terminalId: 't1',
      data: '\r\n[输出过快，已丢弃部分内容]\r\nrecovered',
    });
    terminal.emit('next');
    expect(socket.last()).toEqual({ type: 'output', terminalId: 't1', data: 'next' });
  });

  it('survives send failures', async () => {
    const { harness, socket, terminal } = await attached();
    vi.spyOn(socket, 'send').mockImplementation(() => { throw new Error('socket gone'); });
    expect(() => terminal.emit('boom')).not.toThrow();
    await expect(harness.handler.handleTextMessage(socket, JSON.stringify({ type: 'ping' }))).resolves.toBeUndefined();
  });
});
