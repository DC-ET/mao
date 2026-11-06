import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SessionRunner } from '../src/session/session-runner';
import type { WsClient } from '../src/ws/ws-client';
import type { RestClient } from '../src/rest/rest-client';
import type { Renderer } from '../src/render/types';
import type { WsEvent } from '../src/ws/event-types';

class FakeWs {
  handlers: Array<(e: WsEvent) => void> = [];
  subscribed: number[] = [];
  unsubscribed: number[] = [];
  closed = false;
  failSubscribeFor = new Set<number>();

  async connect(): Promise<void> {
    /* noop */
  }

  subscribe(id: number): void {
    if (this.failSubscribeFor.has(id)) throw new Error('boom');
    this.subscribed.push(id);
    this.emit({ type: 'session_snapshot', sessionId: id, data: { phase: 'IDLE' } });
  }

  unsubscribe(id: number): void {
    this.unsubscribed.push(id);
  }

  send(): void {
    /* noop */
  }

  async sendReliable(): Promise<boolean> {
    return true;
  }

  close(): void {
    this.closed = true;
  }

  on(handler: (e: WsEvent) => void): () => void {
    this.handlers.push(handler);
    return () => undefined;
  }

  emit(evt: WsEvent): void {
    for (const h of this.handlers) h(evt);
  }
}

const renderer: Renderer = { onEvent: () => undefined };

async function setup(opts: { attach?: boolean } = {}) {
  const ws = new FakeWs();
  const markRead = vi.fn(async () => undefined);
  const rest = {
    markRead,
    createSession: async () => ({ id: 11, phase: 'IDLE' }),
    getSession: async (n: number) => ({ id: n, phase: 'IDLE' }),
  } as unknown as RestClient;
  const runner = new SessionRunner({
    rest,
    ws: ws as unknown as WsClient,
    renderer,
    printMode: true,
    ifRunning: 'wait',
    onQuestion: 'fail',
    includeToolIo: false,
  });
  if (opts.attach !== false) await runner.attach({ id: 11, phase: 'IDLE' });
  return { ws, runner, markRead };
}

describe('SessionRunner.switchTo', () => {
  it('unsubscribes and marks the old session read, then attaches the new one', async () => {
    const { ws, runner, markRead } = await setup();
    await runner.switchTo({ id: 22, phase: 'IDLE' });
    expect(ws.unsubscribed).toContain(11);
    expect(ws.subscribed).toContain(22);
    expect(markRead).toHaveBeenCalledWith(11);
    expect(runner.getSession()?.id).toBe(22);
  });

  it('clears stale snapshot state so the new snapshot is awaited', async () => {
    const { ws, runner } = await setup();
    ws.emit({ type: 'session_status', sessionId: 11, data: { phase: 'RUNNING' } });
    expect(runner.snapshotIsActive).toBe(true);

    await runner.switchTo({ id: 22, phase: 'IDLE' });
    // 旧会话 RUNNING 不应再影响新会话；新快照（IDLE）必须已被等待到。
    expect(runner.snapshotIsActive).toBe(false);
  });

  it('ignores events from the previous session after switching', async () => {
    const { ws, runner } = await setup();
    await runner.switchTo({ id: 22, phase: 'IDLE' });
    ws.emit({ type: 'session_status', sessionId: 11, data: { phase: 'RUNNING' } });
    expect(runner.snapshotIsActive).toBe(false);
    ws.emit({ type: 'session_status', sessionId: 22, data: { phase: 'RUNNING' } });
    expect(runner.snapshotIsActive).toBe(true);
  });

  it('clears todos and context of the previous session', async () => {
    const { ws, runner } = await setup();
    ws.emit({ type: 'todo_updated', sessionId: 11, data: { todos: [{ status: 'pending', content: 'x' }] } });
    ws.emit({ type: 'context_window', sessionId: 11, data: { estimated: 10, actual: 20 } });
    expect(runner.getTodos()).toHaveLength(1);
    expect(runner.getContext()).toEqual({ estimated: 10, actual: 20 });

    await runner.switchTo({ id: 22, phase: 'IDLE' });
    expect(runner.getTodos()).toEqual([]);
    expect(runner.getContext()).toEqual({});
  });

  it('rejects switching while a task is running', async () => {
    const { runner } = await setup();
    (runner as unknown as { busy: boolean }).busy = true;
    await expect(runner.switchTo({ id: 22, phase: 'IDLE' })).rejects.toThrow(/仍在执行/);
  });

  it('does not fail the switch when markRead fails', async () => {
    const { runner, markRead } = await setup();
    markRead.mockRejectedValueOnce(new Error('network'));
    await runner.switchTo({ id: 22, phase: 'IDLE' });
    expect(runner.getSession()?.id).toBe(22);
  });

  it('does not re-unsubscribe when the target is the current session', async () => {
    const { ws, runner } = await setup();
    await runner.switchTo({ id: 11, phase: 'IDLE' });
    expect(ws.unsubscribed).toEqual([]);
  });

  it('rolls back to the previous session when attaching the new one fails', async () => {
    const { ws, runner } = await setup();
    ws.failSubscribeFor.add(22);
    await expect(runner.switchTo({ id: 22, phase: 'IDLE' })).rejects.toThrow('boom');
    // 回挂原会话，不留在半挂载状态
    expect(runner.getSession()?.id).toBe(11);
    expect(ws.subscribed.filter((n) => n === 11).length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the previous session data when the switch fails and rolls back', async () => {
    const { ws, runner } = await setup();
    ws.emit({ type: 'todo_updated', sessionId: 11, data: { todos: [{ status: 'pending', content: 'x' }] } });
    ws.emit({ type: 'context_window', sessionId: 11, data: { estimated: 10, actual: 20 } });
    ws.failSubscribeFor.add(22);

    await expect(runner.switchTo({ id: 22, phase: 'IDLE' })).rejects.toThrow('boom');
    expect(runner.getSession()?.id).toBe(11);
    expect(runner.getTodos()).toHaveLength(1);
    expect(runner.getContext()).toEqual({ estimated: 10, actual: 20 });
  });

  it('detaches and asks for a restart when the rollback also fails', async () => {
    const { ws, runner } = await setup();
    ws.failSubscribeFor.add(22);
    ws.failSubscribeFor.add(11);
    await expect(runner.switchTo({ id: 22, phase: 'IDLE' })).rejects.toThrow(/请退出后重开/);
    expect(runner.getSession()).toBeNull();
    expect(runner.isRunning()).toBe(false);
  });

  it('leaves no half-attached state when a draft switch fails (retry works)', async () => {
    const { ws, runner } = await setup({ attach: false });
    ws.failSubscribeFor.add(22);
    await expect(runner.switchTo({ id: 22, phase: 'IDLE' })).rejects.toThrow('boom');
    // 草稿态失败后不能自称已挂在目标会话上（否则重试会被「已经是当前会话」挡住）
    expect(runner.getSession()).toBeNull();

    ws.failSubscribeFor.delete(22);
    await runner.switchTo({ id: 22, phase: 'IDLE' });
    expect(runner.getSession()?.id).toBe(22);
  });

  it('rejects sessions without id', async () => {
    const { runner } = await setup();
    await expect(runner.switchTo({ phase: 'IDLE' })).rejects.toThrow(/缺少 id/);
  });
});

describe('chat.ts 源码级约束（切换后的会话状态收口）', () => {
  it('switchSession 成功后置 attached=true 并清空 createdSession（防止再建新会话）', () => {
    const chatTs = readFileSync(path.join(__dirname, '..', 'src', 'commands', 'chat.ts'), 'utf8');
    const idx = chatTs.indexOf('await runner.switchTo(next);');
    expect(idx).toBeGreaterThan(-1);
    const afterSwitch = chatTs.slice(idx);
    expect(afterSwitch).toMatch(/attached = true;\s*\n\s*createdSession = undefined;/);
  });
});
