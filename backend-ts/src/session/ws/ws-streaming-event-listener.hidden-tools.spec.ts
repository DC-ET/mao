import { describe, expect, it, vi } from 'vitest';
import { WsStreamingEventListener } from './ws-streaming-event-listener.js';

/**
 * 用户隐藏工具（report_issue，技术方案 2026-11-27 §6.3 #1-3）：
 * start / result / argsDelta 三个回调都不向用户发 WS 事件、不落 session_activity；
 * 但 toolCallInfo 登记与 trackActiveToolCall 照做（结果回调要恢复工具名、重放按名过滤）。
 */
function makeListener() {
  const registry = {
    send: vi.fn(),
    trackActiveToolCall: vi.fn(),
    updateActiveToolCallArguments: vi.fn(),
    completeActiveToolCall: vi.fn(),
    clearActiveToolCalls: vi.fn(),
    isSessionThinking: vi.fn(() => false), setSessionThinking: vi.fn(),
    setSessionExecution: vi.fn(),
  };
  const activityService = { record: vi.fn(async () => ({ id: 42 })) };
  const activityHeartbeat = { touch: vi.fn() };
  const sessionTodoMapper = { selectBySessionId: vi.fn(async () => []) };
  const sessionService = { updateContextTokens: vi.fn(async () => undefined) };
  const listener = new WsStreamingEventListener(
    { registry, activityService, activityHeartbeat, sessionTodoMapper, sessionService } as never,
    11, 7, 'exec-1', true,
  );
  return { listener, registry, activityService };
}

function sentTypes(registry: { send: ReturnType<typeof vi.fn> }): string[] {
  return registry.send.mock.calls.map((c) => (c[1] as { type: string }).type);
}

describe('WsStreamingEventListener 用户隐藏工具（report_issue）', () => {
  it('start 不发 tool_call_start，但登记 toolCallInfo 与活跃注册表', () => {
    const { listener, registry } = makeListener();
    listener.onToolCallStart({ id: 'tc-1', function: { name: 'report_issue', arguments: '{"title":"x"}' } } as never);
    expect(sentTypes(registry)).not.toContain('tool_call_start');
    // 登记照做：结果回调要从 toolCallInfo 恢复工具名；重连重放按名过滤（handleSubscribe）
    expect(registry.trackActiveToolCall).toHaveBeenCalledWith(11, 'exec-1', 'tc-1', 'report_issue', '{"title":"x"}');
  });

  it('result 不发 tool_call_result、不落 activity；completeActiveToolCall 照常（注册表清理）', async () => {
    const { listener, registry, activityService } = makeListener();
    listener.onToolCallStart({ id: 'tc-2', function: { name: 'report_issue', arguments: '{}' } } as never);
    listener.onToolCallResult('tc-2', JSON.stringify({ received: true, duplicate: false }), { status: 'success' });
    expect(sentTypes(registry)).not.toContain('tool_call_result');
    expect(sentTypes(registry)).not.toContain('activity');
    // 等一拍确认 recordActivity 的异步分支也没落
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(activityService.record).not.toHaveBeenCalled();
    expect(registry.completeActiveToolCall).toHaveBeenCalledWith(11, 'tc-2');
  });

  it('argsDelta 不下发、不更新活跃注册表（toolCallInfo 快照仍更新供结果回调使用）', () => {
    const { listener, registry } = makeListener();
    listener.onToolCallStart({ id: 'tc-3', function: { name: 'report_issue', arguments: '' } } as never);
    listener.onToolCallArgsDelta?.('tc-3', '{"title":"x"}');
    expect(registry.updateActiveToolCallArguments).not.toHaveBeenCalled();
    expect(sentTypes(registry)).not.toContain('tool_call_args_delta');
  });

  it('普通工具不受影响：start/result/argsDelta 照常下发', async () => {
    const { listener, registry, activityService } = makeListener();
    listener.onToolCallStart({ id: 'tc-4', function: { name: 'shell', arguments: '{"command":"ls"}' } } as never);
    listener.onToolCallArgsDelta?.('tc-4', '{"command":"ls"}');
    listener.onToolCallResult('tc-4', '{"ok":true}', { status: 'success' });
    const types = sentTypes(registry);
    expect(types).toContain('tool_call_start');
    expect(types).toContain('tool_call_result');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(activityService.record).toHaveBeenCalled();
  });
});
