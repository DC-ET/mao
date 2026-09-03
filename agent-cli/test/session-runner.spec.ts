import { describe, expect, it } from 'vitest';
import { SessionRunner, resolveModelId } from '../src/session/session-runner';
import type { WsClient } from '../src/ws/ws-client';
import type { RestClient } from '../src/rest/rest-client';
import type { AskHandler, CliEvent, Renderer } from '../src/render/types';
import type { SafeModelVO, SessionVO } from '../src/rest/types';
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

  it('REPL session_already_running waits for the busy run and resends input', async () => {
    const { ws, renderer, runner } = await attached({ printMode: false });
    const p = runner.runPrompt('x');
    await Promise.resolve();
    ws.emit({ type: 'session_already_running', sessionId: 11, data: { code: 'session_already_running', message: 'busy', executionId: 'other-eid' } });
    await new Promise((r) => setTimeout(r, 10));
    // 占用会话的执行结束，CLI 应自动重发此前被拒的输入
    terminal(ws, 'other-eid', 'COMPLETED');
    await new Promise((r) => setTimeout(r, 10));
    const sends = ws.sent.filter((m) => (m as { type: string }).type === 'send_message');
    expect(sends.length).toBe(2);
    // 本轮结果取决于重发执行的终态，而不是占用方的终态
    const resentEid = (sends[1] as { data: { eventId: string } }).data.eventId;
    expect(resentEid).not.toBe((sends[0] as { data: { eventId: string } }).data.eventId);
    terminal(ws, resentEid, 'COMPLETED');
    const result = await p;
    expect(result.status).toBe('COMPLETED');
    expect(result.executionId).toBe(resentEid);
    expect(renderer.events.some((e) => e.type === 'session_already_running')).toBe(true);
  });

  it('REPL resend keeps waiting when the resent run fails', async () => {
    const { ws, runner } = await attached({ printMode: false });
    const p = runner.runPrompt('x');
    await Promise.resolve();
    ws.emit({ type: 'session_already_running', sessionId: 11, data: { code: 'session_already_running', message: 'busy', executionId: 'other-eid' } });
    await new Promise((r) => setTimeout(r, 10));
    terminal(ws, 'other-eid', 'COMPLETED');
    await new Promise((r) => setTimeout(r, 10));
    let settled = false;
    void p.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    const sends = ws.sent.filter((m) => (m as { type: string }).type === 'send_message');
    terminal(ws, (sends[1] as { data: { eventId: string } }).data.eventId, 'FAILED');
    expect((await p).status).toBe('FAILED');
  });

  it('REPL gives up when the resend is rejected again', async () => {
    const { ws, runner } = await attached({ printMode: false });
    const p = runner.runPrompt('x');
    await Promise.resolve();
    const busy = { type: 'session_already_running', sessionId: 11, data: { code: 'session_already_running', message: 'busy', executionId: 'other-eid' } };
    ws.emit(busy as WsEvent);
    await new Promise((r) => setTimeout(r, 10));
    terminal(ws, 'other-eid', 'COMPLETED');
    await new Promise((r) => setTimeout(r, 10));
    ws.emit(busy as WsEvent);
    expect((await p).status).toBe('ALREADY_RUNNING');
    const sends = ws.sent.filter((m) => (m as { type: string }).type === 'send_message');
    expect(sends.length).toBe(2);
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
    await expect(runner.runPrompt('???')).rejects.toThrow(/上一条还在跑/);
    const eid = (ws.sent.find((m) => (m as { type: string }).type === 'send_message') as { data: { eventId: string } }).data.eventId;
    terminal(ws, eid);
    expect((await p).status).toBe('COMPLETED');
    expect(runner.isRunning()).toBe(false);
  });
});

/** 取自线上活跃 text 模型的真实形态：显示名带尾随空格，且同一 modelId 对应多条配置。 */
const MODELS: SafeModelVO[] = [
  { id: 5, name: 'ds-v4-pro（official）', modelId: 'deepseek-v4-pro' },
  { id: 69, name: 'glm-5.3-flash（free）', modelId: 'glm-5.3-flash' },
  { id: 78, name: 'ds-v4-vision（free） ', modelId: 'deepseek-v4-flash-vision-exp' },
  { id: 58, name: 'ds-v4-vision（agentrouter）', modelId: 'deepseek-v4-flash-vision-exp' },
  { id: 60, name: 'ds-v4-flash（free）', modelId: 'deepseek-v4-flash' },
  { id: 50, name: 'ds-v4-flash（official）', modelId: 'deepseek-v4-flash' },
  { id: 54, name: 'ds-v4-flash（agentrouter）', modelId: 'deepseek-v4-flash' },
];

function modelRest(models: SafeModelVO[] = MODELS): RestClient {
  return { listActiveModels: async () => models } as unknown as RestClient;
}

describe('resolveModelId', () => {
  it('matches a display name whose stored value has trailing whitespace', async () => {
    // 用户手输 / Tab 补全都不会带尾随空格，严格全等会判「找不到」
    expect(await resolveModelId(modelRest(), 'ds-v4-vision（free）')).toBe(78);
  });

  it('prefers the display name over another row sharing that vendor model id', async () => {
    // 78 与 58 同 modelId：按显示名仍应唯一命中，而不是报「多个同名」
    expect(await resolveModelId(modelRest(), 'ds-v4-vision（agentrouter）')).toBe(58);
  });

  it('falls back to the vendor model id only when no display name matches', async () => {
    expect(await resolveModelId(modelRest(), 'glm-5.3-flash')).toBe(69);
  });

  it('asks for an id when a vendor model id maps to several configurations', async () => {
    await expect(resolveModelId(modelRest(), 'deepseek-v4-flash')).rejects.toThrow(/厂商模型串/);
    await expect(resolveModelId(modelRest(), 'deepseek-v4-flash')).rejects.toThrow(/60=|50=|54=/);
  });

  it('asks for an id when two rows really share a display name', async () => {
    const dup: SafeModelVO[] = [
      { id: 1, name: '同名', modelId: 'a' },
      { id: 2, name: '同名 ', modelId: 'b' },
    ];
    await expect(resolveModelId(modelRest(dup), '同名')).rejects.toThrow(/多个模型名/);
  });

  it('matches a display name case-insensitively as a fallback', async () => {
    expect(await resolveModelId(modelRest(), 'GLM-5.3-FLASH（FREE）')).toBe(69);
  });

  it('resolves a numeric spec as an id and reports a missing one', async () => {
    expect(await resolveModelId(modelRest(), '5')).toBe(5);
    await expect(resolveModelId(modelRest(), '999')).rejects.toThrow(/找不到模型 id=999/);
  });

  it('reports an unknown name instead of silently falling back', async () => {
    await expect(resolveModelId(modelRest(), '不存在的模型')).rejects.toThrow(/找不到名为/);
  });

  it('returns the fallback id without a spec and undefined with neither', async () => {
    expect(await resolveModelId(modelRest(), undefined, 50)).toBe(50);
    expect(await resolveModelId(modelRest())).toBeUndefined();
  });
});
