import { describe, expect, it, vi } from 'vitest';
import { WsStreamingEventListener, contentParts } from './ws-streaming-event-listener.js';

function makeListener() {
  const registry = { send: vi.fn() };
  const activityService = { record: vi.fn(async () => ({ id: 42 })) };
  const activityHeartbeat = { touch: vi.fn() };
  const sessionTodoMapper = { selectBySessionId: vi.fn(async () => [{ id: 1, content: 'todo', status: 'pending' }]) };
  const sessionService = { updateContextTokens: vi.fn(async () => undefined) };
  const listener = new WsStreamingEventListener(
    { registry, activityService, activityHeartbeat, sessionTodoMapper, sessionService } as never,
    11, 7, 'exec-1', true,
  );
  return { listener, registry, activityService, sessionTodoMapper, sessionService };
}

describe('WsStreamingEventListener', () => {
  it('forwards stream events with executionId', () => {
    const { listener, registry } = makeListener();
    listener.onContentDelta('hi');
    listener.onThinkingStart();
    listener.onThinkingDelta('think');
    listener.onThinkingEnd();
    listener.onLlmWaiting('first_token', 3);
    listener.onLlmRetry('rate', 429, 1, 3, 2);
    listener.onLlmRetry('net', null, 2, 3, 1);
    listener.onToolCallArgsDelta('tc-1', '{"p":');
    listener.onCompactionStart('auto', 8, 1000);
    listener.onCompactionEnd('auto', 20, 80, 12);
    listener.onCompactionPersisted(9, 'auto', 1, 8, 7, 20, 80, 12);
    listener.onContextWindow(100, 90);
    listener.onMessageEnd({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
    listener.onError(new Error('boom'));
    listener.onError('x');
    const types = vi.mocked(registry.send).mock.calls.map((c) => (c[1] as { type: string }).type);
    expect(types).toEqual(expect.arrayContaining([
      'content_delta', 'thinking_start', 'thinking_end', 'llm_waiting', 'llm_retry',
      'tool_call_args_delta', 'compaction_start', 'compaction_marker', 'context_window', 'message_end', 'error',
    ]));
  });

  it('sends tool_call_start only once per id and keeps latest arguments', () => {
    const { listener, registry } = makeListener();
    listener.onToolCallStart({ id: 'tc-w', function: { name: 'write_file', arguments: '{"path":' } } as never);
    listener.onToolCallArgsDelta('tc-w', '{"path":"/a.ts"}');
    listener.onToolCallStart({ id: 'tc-w', function: { name: 'write_file', arguments: '{"path":"/a.ts"}' } } as never);
    listener.onToolCallResult('tc-w', '{"success":true,"bytes_written":12}');
    const events = vi.mocked(registry.send).mock.calls.map((c) => c[1] as { type: string; data?: { summary?: string } });
    const starts = events.filter((e) => e.type === 'tool_call_start');
    expect(starts).toHaveLength(1);
    expect(events.find((e) => e.type === 'tool_call_result')?.data?.summary).toBe('写入 /a.ts (12B)');
  });

  it('strips private diff records file change and todos', async () => {
    const { listener, registry, activityService, sessionTodoMapper } = makeListener();
    listener.onToolCallStart({ id: 'tc-w', function: { name: 'write_file', arguments: '{"path":"/a.ts"}' } } as never);
    listener.onToolCallResult('tc-w', JSON.stringify({
      success: true,
      file_change: { path: '/a.ts', type: 'created', lines_added: 2, lines_deleted: 0 },
      _private_diff: { diff_mode: 'full', before_content: '', after_content: 'x' },
    }));
    listener.onToolCallStart({ id: 'tc-t', function: { name: 'task_create', arguments: '{}' } } as never);
    listener.onToolCallResult('tc-t', JSON.stringify({ ok: true }));
    listener.onToolCallStart({ id: 'tc-e', function: { name: 'shell', arguments: '{"command":"ls"}' } } as never);
    listener.onToolCallResult('tc-e', JSON.stringify({ error: 'fail', exit_code: 1 }));
    listener.onToolCallStart({ id: 'tc-i', function: { name: 'read_file', arguments: '{"path":"p.png"}' } } as never);
    listener.onToolCallResult('tc-i', JSON.stringify({ type: 'image', mimeType: 'image/png' }));
    listener.onToolCallResult('unknown', 'not-json');
    listener.onLlmStreamReset();
    await vi.waitFor(() => expect(activityService.record).toHaveBeenCalled());
    await vi.waitFor(() => expect(sessionTodoMapper.selectBySessionId).toHaveBeenCalled());
    const types = vi.mocked(registry.send).mock.calls.map((c) => (c[1] as { type: string }).type);
    const resultEvents = vi.mocked(registry.send).mock.calls
      .map((c) => c[1] as { type: string; data?: { summary?: string } })
      .filter((e) => e.type === 'tool_call_result');
    expect(resultEvents[0]?.data?.summary).toBe('写入 /a.ts (+2行 -0行)');
    expect(types).toContain('file_change');
    expect(types).toContain('todo_updated');
    expect(types).toContain('activity');
    expect(types).toContain('llm_stream_reset');
  });

  it('sanitizes image results with the shared processor and preserves preview only', () => {
    const { listener, registry } = makeListener();
    listener.onToolCallStart({ id: 'tc-img', function: { name: 'read_file', arguments: '{"path":"p.png"}' } } as never);
    listener.onToolCallResult('tc-img', JSON.stringify({
      media_type: 'image', mime: 'image/png', path: 'p.png', data_uri: 'data:image/png;base64,abc',
    }));
    const resultEvent = vi.mocked(registry.send).mock.calls
      .map((c) => c[1] as { type: string; data?: Record<string, unknown> })
      .find((e) => e.type === 'tool_call_result');
    expect(resultEvent?.data?.result).not.toContain('data:image/png;base64,abc');
    expect(resultEvent?.data?.preview).toEqual({
      media_type: 'image', mime: 'image/png', data_uri: 'data:image/png;base64,abc',
    });
  });

  it('replaces unsupported image results with a vision error', () => {
    const { listener, registry } = makeListener();
    const unsupported = new WsStreamingEventListener(
      { registry, activityService: { record: vi.fn(async () => ({ id: 1 })) }, activityHeartbeat: { touch: vi.fn() },
        sessionTodoMapper: { selectBySessionId: vi.fn(async () => []) }, sessionService: { updateContextTokens: vi.fn(async () => undefined) } } as never,
      11, 7, 'exec-1', false,
    );
    unsupported.onToolCallStart({ id: 'tc-img', function: { name: 'read_file', arguments: '{"path":"p.png"}' } } as never);
    unsupported.onToolCallResult('tc-img', JSON.stringify({ media_type: 'image', path: 'p.png', data_uri: 'data:image/png;base64,abc' }));
    const resultEvent = vi.mocked(registry.send).mock.calls
      .map((c) => c[1] as { type: string; data?: Record<string, unknown> })
      .find((e) => e.type === 'tool_call_result');
    expect(resultEvent?.data?.result).toContain('当前模型不支持图片输入');
    expect(resultEvent?.data?.result).not.toContain('data:image/png;base64,abc');
    expect(resultEvent?.data?.preview).toBeUndefined();
  });

  it('summarizes edit_file result instead of dumping raw json', () => {
    const { listener, registry } = makeListener();
    listener.onToolCallStart({
      id: 'tc-e',
      function: { name: 'edit_file', arguments: '{"path":"src/App.vue"}' },
    } as never);
    listener.onToolCallResult('tc-e', JSON.stringify({
      success: true,
      replacements: 1,
      file_change: { path: 'src/App.vue', type: 'updated', lines_added: 3, lines_deleted: 1 },
    }));
    const resultEvent = vi.mocked(registry.send).mock.calls
      .map((c) => c[1] as { type: string; data?: { summary?: string } })
      .find((e) => e.type === 'tool_call_result');
    expect(resultEvent?.data?.summary).toBe('编辑 src/App.vue (+3行 -1行)');
    expect(resultEvent?.data?.summary).not.toMatch(/"success"/);
  });

  it('contentParts builds text and image parts', () => {
    expect(contentParts('hi', ['https://a/b.png'])).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image_url', image_url: { url: 'https://a/b.png' } },
    ]);
    expect(contentParts('  ', [])).toEqual([]);
  });

  it('ignores activity and todo failures', async () => {
    const { listener, activityService, sessionTodoMapper } = makeListener();
    activityService.record.mockRejectedValue(new Error('db'));
    sessionTodoMapper.selectBySessionId.mockRejectedValue(new Error('db'));
    listener.onToolCallStart({ id: 'tc', function: { name: 'task_list', arguments: 'not-json' } } as never);
    listener.onToolCallResult('tc', JSON.stringify({ ok: true }));
    await new Promise((r) => setTimeout(r, 20));
  });
});
