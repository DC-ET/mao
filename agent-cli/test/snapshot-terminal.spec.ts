import { describe, expect, it } from 'vitest';
import { SessionRunner } from '../src/session/session-runner';
import type { WsClient } from '../src/ws/ws-client';
import type { RestClient } from '../src/rest/rest-client';
import type { AskHandler, CliEvent, Renderer } from '../src/render/types';
import type { SessionVO } from '../src/rest/types';
import type { WsEvent } from '../src/ws/event-types';

/**
 * 逻辑回归用例（round2 审查修复后转正）：
 * 断线重连后服务端回传的终态 session_snapshot 不能结束本轮等待，
 * 打印模式进程永久挂起。预期：快照 phase 为终态时应与 session_status 一样 settle。
 */

class CollectingRenderer implements Renderer {
  events: CliEvent[] = [];
  onEvent(evt: CliEvent): void {
    this.events.push(evt);
  }
}

class FakeWs {
  handlers: Array<(e: WsEvent) => void> = [];
  sent: object[] = [];
  subscribed: number[] = [];
  closed = false;
  snapshot: WsEvent = { type: 'session_snapshot', sessionId: 11, data: { phase: 'IDLE' } };

  async connect(): Promise<void> { /* open */ }
  subscribe(id: number): void {
    this.subscribed.push(id);
    this.emit(this.snapshot);
  }
  unsubscribe(): void { /* noop */ }
  send(payload: object): void { this.sent.push(payload); }
  async sendReliable(payload: object): Promise<boolean> {
    this.sent.push(payload);
    return true;
  }
  close(): void { this.closed = true; }
  on(handler: (e: WsEvent) => void): () => void {
    this.handlers.push(handler);
    return () => undefined;
  }
  emit(evt: WsEvent): void {
    for (const h of this.handlers) h(evt);
  }
}

function restStub(): RestClient {
  return {
    markRead: async () => undefined,
    createSession: async () => ({ id: 11, phase: 'IDLE' }),
  } as unknown as RestClient;
}

function session(): SessionVO {
  return { id: 11, phase: 'IDLE', agentName: '通用助手', modelName: 'gpt' };
}

async function attached(opts?: { printMode?: boolean; onQuestion?: 'ask' | 'fail'; askHandler?: AskHandler }) {
  const ws = new FakeWs();
  const renderer = new CollectingRenderer();
  const runner = new SessionRunner({
    rest: restStub(),
    ws: ws as unknown as WsClient,
    renderer,
    printMode: opts?.printMode ?? true,
    ifRunning: 'wait',
    onQuestion: opts?.onQuestion ?? 'fail',
    askHandler: opts?.askHandler,
    includeToolIo: true,
  });
  await runner.attach(session());
  return { ws, renderer, runner };
}

function hangGuard<T>(p: Promise<T>, ms = 500): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('runPrompt 未结算（挂起）')), ms)),
  ]);
}

describe('终态 session_snapshot 必须结算本轮等待', () => {
  it('重连后收到的 COMPLETED 快照结束本轮（不挂起）', async () => {
    const { ws, runner } = await attached();
    const p = runner.runPrompt('x');
    await Promise.resolve();
    const send = ws.sent.find((m) => (m as { type: string }).type === 'send_message') as { data: { eventId: string } };
    // 断线期间任务已跑完：重连后服务端只回传终态快照，不再重放 session_status
    ws.emit({ type: 'session_snapshot', sessionId: 11, data: { phase: 'COMPLETED', executionId: send.data.eventId } });
    const result = await hangGuard(p);
    expect((result as { status: string }).status).toBe('COMPLETED');
  });

  it('无 executionId 的 FAILED 快照同样结束本轮', async () => {
    const { ws, runner } = await attached();
    const p = runner.runPrompt('x');
    await Promise.resolve();
    ws.emit({ type: 'session_snapshot', sessionId: 11, data: { phase: 'FAILED' } });
    const result = await hangGuard(p);
    expect((result as { status: string }).status).toBe('FAILED');
  });

  it('对照组：终态 session_status 仍能正常结算（现有行为不回退）', async () => {
    const { ws, runner } = await attached();
    const p = runner.runPrompt('x');
    await Promise.resolve();
    const send = ws.sent.find((m) => (m as { type: string }).type === 'send_message') as { data: { eventId: string } };
    ws.emit({ type: 'session_status', sessionId: 11, data: { phase: 'RUNNING', executionId: send.data.eventId } });
    ws.emit({ type: 'session_status', sessionId: 11, data: { phase: 'COMPLETED', executionId: send.data.eventId } });
    const result = await hangGuard(p);
    expect((result as { status: string }).status).toBe('COMPLETED');
  });

  it('非终态快照（RUNNING）不应提前结算', async () => {
    const { ws, runner } = await attached();
    const p = runner.runPrompt('x');
    await Promise.resolve();
    const send = ws.sent.find((m) => (m as { type: string }).type === 'send_message') as { data: { eventId: string } };
    ws.emit({ type: 'session_snapshot', sessionId: 11, data: { phase: 'RUNNING', executionId: send.data.eventId } });
    // RUNNING 快照之后补发终态 session_status，本轮才应结束
    ws.emit({ type: 'session_status', sessionId: 11, data: { phase: 'COMPLETED', executionId: send.data.eventId } });
    const result = await hangGuard(p);
    expect((result as { status: string }).status).toBe('COMPLETED');
  });
});
