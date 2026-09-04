import { describe, expect, it } from 'vitest';
import { ChatStore } from './store';
import type { WsServerEvent } from '@mao/contracts';

function ev(type: string, sessionId: number | null, data?: Record<string, unknown>): WsServerEvent {
  return { type, sessionId, data } as WsServerEvent;
}

describe('ChatStore', () => {
  it('content_delta 聚合到最后一条 assistant 消息', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('content_delta', 1, { delta: '你好' }));
    store.handleEvent(ev('content_delta', 1, { delta: '世界' }));
    expect(store.messages.value.length).toBe(1);
    expect(store.messages.value[0].content).toBe('你好世界');
    expect(store.messages.value[0].streaming).toBe(true);
  });

  it('stale executionId 事件被丢弃', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('content_delta', 1, { delta: 'a' }));
    // 旧执行的事件
    store.handleEvent(ev('content_delta', 1, { delta: 'stale', executionId: 'e0' }));
    expect(store.messages.value[0].content).toBe('a');
  });

  it('cancel 后抑制流事件，新 RUNNING 恢复', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('content_delta', 1, { delta: 'x' }));
    store.markCancelled();
    // 被抑制
    store.handleEvent(ev('content_delta', 1, { delta: 'y' }));
    expect(store.messages.value[0].content).toBe('x');
    // 新一轮 RUNNING（无 executionId 的旧事件也要防）
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e2' }));
    store.handleEvent(ev('content_delta', 1, { delta: 'new' }));
    expect(store.messages.value.length).toBe(2);
    expect(store.messages.value[1].content).toBe('new');
  });

  it('CANCELLED 终态终结 running 工具与流式气泡', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('tool_call_start', 1, { tool_call_id: 't1', tool_name: 'fs.read' }));
    store.handleEvent(ev('session_status', 1, { phase: 'CANCELLED' }));
    const m = store.messages.value[0];
    expect(m.streaming).toBe(false);
    expect(m.toolCalls[0].status).toBe('error');
    expect(store.phase.value).toBe('CANCELLED');
  });

  it('tool_call_args_delta / result 更新对应卡片（后端 snake_case 字段）', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('tool_call_start', 1, { tool_call_id: 't1', tool_name: 'web_search', arguments: '{"q"' }));
    store.handleEvent(ev('tool_call_args_delta', 1, { tool_call_id: 't1', arguments: ':"mao"}' }));
    store.handleEvent(ev('tool_call_result', 1, { tool_call_id: 't1', result: 'raw', summary: 'ok', status: 'success' }));
    const tc = store.messages.value[0].toolCalls[0];
    expect(tc.toolCallId).toBe('t1');
    expect(tc.argsText).toBe('{"q":"mao"}');
    expect(tc.status).toBe('done');
    expect(tc.resultText).toBe('ok');
  });

  it('tool_call_result error 状态标记卡片失败', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('tool_call_start', 1, { tool_call_id: 't2', tool_name: 'fs.write' }));
    store.handleEvent(ev('tool_call_result', 1, { tool_call_id: 't2', result: 'boom', status: 'error' }));
    const tc = store.messages.value[0].toolCalls[0];
    expect(tc.status).toBe('error');
    expect(tc.resultText).toBe('boom');
  });

  it('其他会话的事件被忽略', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 2, { phase: 'RUNNING', executionId: 'e9' }));
    store.handleEvent(ev('content_delta', 2, { delta: 'no' }));
    expect(store.messages.value.length).toBe(0);
    expect(store.phase.value).toBeNull();
  });

  it('error 事件置 FAILED 并收口流式气泡', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('content_delta', 1, { delta: 'partial' }));
    store.handleEvent(ev('error', 1, { message: 'boom' }));
    expect(store.phase.value).toBe('FAILED');
    expect(store.sessionError.value).toBe('boom');
    expect(store.messages.value[0].streaming).toBe(false);
    expect(store.messages.value[0].error).toBe(true);
  });

  it('session_snapshot 恢复 executionId 供对账', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_snapshot', 1, { phase: 'RUNNING', executionId: 'e7' }));
    // 重连后旧执行的事件（e6）应被丢弃
    store.handleEvent(ev('content_delta', 1, { delta: 'old', executionId: 'e6' }));
    expect(store.messages.value.length).toBe(0);
    store.handleEvent(ev('content_delta', 1, { delta: 'fresh' }));
    expect(store.messages.value[0].content).toBe('fresh');
  });
});
