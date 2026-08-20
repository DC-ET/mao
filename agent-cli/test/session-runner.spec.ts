import { describe, expect, it } from 'vitest';
import { SessionRunner } from '../src/session/session-runner';
import type { WsClient } from '../src/ws/ws-client';
import type { RestClient } from '../src/rest/rest-client';
import type { AskHandler, CliEvent, Renderer } from '../src/render/types';
import type { SessionVO } from '../src/rest/types';
import type { WsEvent } from '../src/ws/event-types';

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

function terminal(ws: FakeWs, executionId: string, phase = 'COMPLETED'): void {
  ws.emit({ type: 'session_status', sessionId: 11, data: { phase: 'RUNNING', executionId } });
  ws.emit({ type: 'session_status', sessionId: 11, data: { phase, executionId, unread: true } });
}

describe('SessionRunner', () => {
  it('completes a normal round and captures last assistant text after tools', async () => {
    const { ws, renderer, runner } = await attached();
    const p = runner.runPrompt('hello');
    await Promise.resolve();
    const send = ws.sent.find((m) => (m as { type: string }).type === 'send_message') as { data: { eventId: string } };
    const eid = send.data.eventId;
    ws.emit({ type: 'content_delta', sessionId: 11, data: { delta: '先看', executionId: eid } });
    ws.emit({ type: 'tool_call_start', sessionId: 11, data: { tool_call_id: 'tc_1', tool_name: 'shell', arguments: '{}', executionId: eid } });
    ws.emit({ type: 'tool_call_result', sessionId: 11, data: { tool_call_id: 'tc_1', status: 'SUCCESS', executionId: eid } });
    ws.emit({ type: 'content_delta', sessionId: 11, data: { delta: '已完成', executionId: eid } });
    ws.emit({ type: 'file_change', sessionId: 11, data: { path: 'a.ts', type: 'MODIFY', lines_added: 1, lines_deleted: 0, executionId: eid } });
    ws.emit({ type: 'message_end', sessionId: 11, data: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, executionId: eid } });
    terminal(ws, eid);
    const result = await p;
    expect(result.status).toBe('COMPLETED');
    expect(result.result).toBe('已完成');
    expect(result.usage.totalTokens).toBe(12);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.fileChanges[0].path).toBe('a.ts');
    expect(renderer.events.some((e) => e.type === 'session_started')).toBe(true);
  });

  it('FAILED terminal maps to FAILED', async () => {
    const { ws, runner } = await attached();
    const p = runner.runPrompt('x');
    await Promise.resolve();
    const eid = (ws.sent.find((m) => (m as { type: string }).type === 'send_message') as { data: { eventId: string } }).data.eventId;
    terminal(ws, eid, 'FAILED');
    expect((await p).status).toBe('FAILED');
  });

  it('CANCELLED terminal maps to CANCELLED', async () => {
    const { ws, runner } = await attached();
    const p = runner.runPrompt('x');
    await Promise.resolve();
    const eid = (ws.sent.find((m) => (m as { type: string }).type === 'send_message') as { data: { eventId: string } }).data.eventId;
    terminal(ws, eid, 'CANCELLED');
    expect((await p).status).toBe('CANCELLED');
  });

  it('REPL session_already_running abandons the send', async () => {
    const { ws, renderer, runner } = await attached({ printMode: false });
    const p = runner.runPrompt('x');
    await Promise.resolve();
    ws.emit({ type: 'session_already_running', sessionId: 11, data: { code: 'session_already_running', message: 'busy' } });
    const result = await p;
    expect(result.status).toBe('ALREADY_RUNNING');
    expect(renderer.events.some((e) => e.type === 'session_already_running')).toBe(true);
  });

  it('ask_user_questions fail path sends cancel (must not just exit)', async () => {
    const { ws, runner } = await attached({ printMode: true, onQuestion: 'fail' });
    const p = runner.runPrompt('x');
    await Promise.resolve();
    const eid = (ws.sent.find((m) => (m as { type: string }).type === 'send_message') as { data: { eventId: string } }).data.eventId;
    ws.emit({
      type: 'ask_user_questions',
      sessionId: 11,
      data: { requestId: 'q1', questions: [{ question: '选一个?', options: [{ label: 'A' }, { label: 'B' }] }], executionId: eid },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(ws.sent.some((m) => (m as { type: string }).type === 'cancel')).toBe(true);
    expect(runner.questionFailed).toBe(true);
    terminal(ws, eid, 'CANCELLED');
    await p;
  });

  it('ask_user_questions ask path sends answers via sendReliable', async () => {
    const { ws, runner } = await attached({
      printMode: false,
      onQuestion: 'ask',
      askHandler: async () => [{ question: '选一个?', selectedLabels: ['A'] }],
    });
    const p = runner.runPrompt('x');
    await Promise.resolve();
    const eid = (ws.sent.find((m) => (m as { type: string }).type === 'send_message') as { data: { eventId: string } }).data.eventId;
    ws.emit({
      type: 'ask_user_questions',
      sessionId: 11,
      data: { requestId: 'q1', questions: [{ question: '选一个?', options: [{ label: 'A' }] }], executionId: eid },
    });
    await new Promise((r) => setTimeout(r, 20));
    const answer = ws.sent.find((m) => (m as { type: string }).type === 'ask_user_questions_result') as {
      data: { requestId: string; answers: unknown[] };
    };
    expect(answer.data.requestId).toBe('q1');
    expect(answer.data.answers).toEqual([{ question: '选一个?', selectedLabels: ['A'] }]);
    terminal(ws, eid);
    await p;
  });

  it('dedups replayed tool_call_start after reconnect', async () => {
    const { ws, runner } = await attached();
    const p = runner.runPrompt('x');
    await Promise.resolve();
    const eid = (ws.sent.find((m) => (m as { type: string }).type === 'send_message') as { data: { eventId: string } }).data.eventId;
    const start = { type: 'tool_call_start', sessionId: 11, data: { tool_call_id: 'tc_1', tool_name: 'shell', arguments: '{}', executionId: eid } };
    ws.emit(start as WsEvent);
    runner.markReconnected();
    ws.emit(start as WsEvent);
    terminal(ws, eid);
    const result = await p;
    expect(result.toolCalls).toHaveLength(1);
    expect(result.reconnected).toBe(true);
  });

  it('ignores other sessions so -p does not exit early', async () => {
    const { ws, runner } = await attached();
    const p = runner.runPrompt('x');
    await Promise.resolve();
    const eid = (ws.sent.find((m) => (m as { type: string }).type === 'send_message') as { data: { eventId: string } }).data.eventId;
    ws.emit({ type: 'session_status', sessionId: 99, data: { phase: 'COMPLETED', executionId: 'other' } });
    let settled = false;
    void p.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    terminal(ws, eid);
    expect((await p).status).toBe('COMPLETED');
  });

  it('isRunning is true from send until settle, even before session_status RUNNING', async () => {
    const { ws, runner } = await attached({ printMode: false });
    const p = runner.runPrompt('hello');
    await Promise.resolve();
    expect(runner.isRunning()).toBe(true);
    await expect(runner.runPrompt('???')).rejects.toThrow(/仍在执行/);
    const eid = (ws.sent.find((m) => (m as { type: string }).type === 'send_message') as { data: { eventId: string } }).data.eventId;
    terminal(ws, eid);
    expect((await p).status).toBe('COMPLETED');
    expect(runner.isRunning()).toBe(false);
  });
});
