import { describe, expect, it, vi } from 'vitest';
import { WsStreamingEventListener, contentParts } from './ws-streaming-event-listener.js';

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
  const sessionTodoMapper = { selectBySessionId: vi.fn(async () => [{ id: 1, content: 'todo', status: 'pending' }]) };
  const sessionService = { updateContextTokens: vi.fn(async () => undefined) };
  const listener = new WsStreamingEventListener(
    { registry, activityService, activityHeartbeat, sessionTodoMapper, sessionService } as never,
    11, 7, 'exec-1', true,
  );
  return { listener, registry, activityService, sessionTodoMapper, sessionService };
}

describe('WsStreamingEventListener', () => {
  it('prefers meta success status over heuristic for tool result', () => {
    const { listener, registry } = makeListener();
    listener.onToolCallStart({ id: 'tc-ok', function: { name: 'shell', arguments: '{"command":"ls"}' } } as never);
    listener.onToolCallResult('tc-ok', JSON.stringify({ error: 'x' }), { status: 'success' });
    const event = vi.mocked(registry.send).mock.calls
      .map((c) => c[1] as { type: string; data?: Record<string, unknown> })
      .find((e) => e.type === 'tool_call_result');
    expect(event?.data?.status).toBe('success');
  });

  it('forwards result_truncated flag from meta to tool_call_result payload', () => {
    const { listener, registry } = makeListener();
    listener.onToolCallStart({ id: 'tc-tr', function: { name: 'read_file', arguments: '{}' } } as never);
    listener.onToolCallResult('tc-tr', JSON.stringify({ content: 'x', truncated: true }), { status: 'success', resultTruncated: true });
    const event = vi.mocked(registry.send).mock.calls
      .map((c) => c[1] as { type: string; data?: Record<string, unknown> })
      .find((e) => e.type === 'tool_call_result');
    expect(event?.data?.result_truncated).toBe(true);
  });

  it('omits result_truncated when meta has no truncation', () => {
    const { listener, registry } = makeListener();
    listener.onToolCallStart({ id: 'tc-nt', function: { name: 'read_file', arguments: '{}' } } as never);
    listener.onToolCallResult('tc-nt', JSON.stringify({ ok: true }), { status: 'success' });
    const event = vi.mocked(registry.send).mock.calls
      .map((c) => c[1] as { type: string; data?: Record<string, unknown> })
      .find((e) => e.type === 'tool_call_result');
    expect('result_truncated' in (event?.data ?? {})).toBe(false);
  });

  it('uses meta error status even when content looks successful', () => {
    const { listener, registry } = makeListener();
    listener.onToolCallStart({ id: 'tc-err', function: { name: 'read_file', arguments: '{}' } } as never);
    listener.onToolCallResult('tc-err', '{"ok":true}', { status: 'error', errorMessage: 'boom' });
    const event = vi.mocked(registry.send).mock.calls
      .map((c) => c[1] as { type: string; data?: Record<string, unknown> })
      .find((e) => e.type === 'tool_call_result');
    expect(event?.data?.status).toBe('error');
  });
  it('tracks thinking state on the registry for snapshot recovery', () => {
    const { listener, registry } = makeListener();
    listener.onThinkingStart();
    expect(registry.setSessionThinking).toHaveBeenCalledWith(11, true);
    listener.onThinkingEnd();
    expect(registry.setSessionThinking).toHaveBeenLastCalledWith(11, false);
  });

  it('registers the current session execution id on construction for reconnect snapshots', () => {
    const { registry } = makeListener();
    expect(registry.setSessionExecution).toHaveBeenCalledWith(11, 'exec-1');
  });

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

  it('context_window payload carries manifest when provided', () => {
    const { listener, registry } = makeListener();
    const manifest = {
      sections: [{ key: 'system-prompt', label: 'Agent 人格', tokens: 100 }],
      memoryIds: [1, 2, 3],
      estimatedWindowTokens: 200000,
    };
    listener.onContextWindow(1000, 900, manifest as never);
    const event = vi.mocked(registry.send).mock.calls
      .map((c) => c[1] as { type: string; data?: Record<string, unknown> })
      .find((e) => e.type === 'context_window');
    expect(event?.data?.estimated).toBe(1000);
    expect(event?.data?.actual).toBe(900);
    expect(event?.data?.manifest).toEqual(manifest);
  });

  it('context_window payload omits manifest field when null', () => {
    const { listener, registry } = makeListener();
    listener.onContextWindow(50, 40);
    const event = vi.mocked(registry.send).mock.calls
      .map((c) => c[1] as { type: string; data?: Record<string, unknown> })
      .find((e) => e.type === 'context_window');
    expect('manifest' in (event?.data ?? {})).toBe(false);
  });

  it('context_window trims memoryIds when manifest exceeds size cap', () => {
    const { listener, registry } = makeListener();
    // 构造一个远超 8KB 的 manifest：sections 里塞一段巨大 label，memoryIds 也填满
    const huge = 'x'.repeat(9000);
    const manifest = {
      sections: [{ key: 'k', label: huge, tokens: 1 }, { key: 'messages', label: '会话消息', tokens: 2 }],
      memoryIds: Array.from({ length: 100 }, (_, i) => i + 1),
      estimatedWindowTokens: 200000,
    };
    listener.onContextWindow(10, 10, manifest as never);
    const event = vi.mocked(registry.send).mock.calls
      .map((c) => c[1] as { type: string; data?: Record<string, unknown> })
      .find((e) => e.type === 'context_window');
    // sections 本身无法裁剪 → 整体丢弃 manifest（水位字段仍在），避免超大帧
    expect(event?.data?.estimated).toBe(10);
    expect('manifest' in (event?.data ?? {})).toBe(false);
  });

  it('sends tool_call_start only once per id and keeps latest arguments', () => {
    const { listener, registry } = makeListener();
    listener.onToolCallStart({ id: 'tc-w', function: { name: 'write_file', arguments: '{"path":' } } as never);
    listener.onToolCallArgsDelta('tc-w', '{"path":"/a.ts"}');
    listener.onToolCallStart({ id: 'tc-w', function: { name: 'write_file', arguments: '{"path":"/a.ts"}' } } as never);
    listener.onToolCallResult('tc-w', '{"success":true,"bytes_written":12}');
    const events = vi.mocked(registry.send).mock.calls.map((c) => c[1] as { type: string; data?: { summary?: string; tool_name?: string } });
    const starts = events.filter((e) => e.type === 'tool_call_start');
    expect(starts).toHaveLength(1);
    expect(events.find((e) => e.type === 'tool_call_result')?.data?.summary).toBe('写入 /a.ts (12B)');
    expect(events.find((e) => e.type === 'tool_call_result')?.data?.tool_name).toBe('write_file');
  });

  it('strips private diff records file change and todos', async () => {
    const { listener, registry, activityService, sessionTodoMapper } = makeListener();
    listener.onToolCallStart({ id: 'tc-w', function: { name: 'write_file', arguments: '{"path":"/a.ts"}' } } as never);
    listener.onToolCallResult('tc-w', JSON.stringify({
      success: true,
      file_change: { path: '/a.ts', type: 'created', lines_added: 2, lines_deleted: 0 },
      file_change_diff: { diff_mode: 'SNAPSHOT', before_content: '', after_content: 'x' },
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
      .map((c) => c[1] as { type: string; data?: { summary?: string; result?: string } })
      .filter((e) => e.type === 'tool_call_result');
    expect(resultEvents[0]?.data?.summary).toBe('写入 /a.ts (+2行 -0行)');
    expect(resultEvents[0]?.data?.result).not.toContain('file_change_diff');
    expect(resultEvents[0]?.data?.result).not.toContain('"after_content":"x"');
    const fileChange = vi.mocked(registry.send).mock.calls
      .map((c) => c[1] as { type: string; data?: Record<string, unknown> })
      .find((e) => e.type === 'file_change');
    expect(fileChange?.data?.diff_mode).toBe('SNAPSHOT');
    expect(fileChange?.data?.after_content).toBe('x');
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

  it('coalesces content deltas into one flushed frame', async () => {
    vi.useFakeTimers();
    try {
      const { listener, registry } = makeListener();
      listener.onContentDelta('你');
      listener.onContentDelta('好');
      listener.onContentDelta('，');
      // flush 前：无任何 content_delta 发出
      let types = vi.mocked(registry.send).mock.calls.map((c) => (c[1] as { type: string }).type);
      expect(types).not.toContain('content_delta');
      await vi.advanceTimersByTimeAsync(50);
      types = vi.mocked(registry.send).mock.calls.map((c) => (c[1] as { type: string }).type);
      expect(types.filter((t) => t === 'content_delta')).toHaveLength(1);
      const event = vi.mocked(registry.send).mock.calls
        .map((c) => c[1] as { type: string; data?: { delta?: string } })
        .find((e) => e.type === 'content_delta');
      expect(event?.data?.delta).toBe('你好，');
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces thinking deltas separately from content deltas', async () => {
    vi.useFakeTimers();
    try {
      const { listener, registry } = makeListener();
      listener.onThinkingDelta('a');
      listener.onThinkingDelta('b');
      listener.onContentDelta('x');
      await vi.advanceTimersByTimeAsync(50);
      const events = vi.mocked(registry.send).mock.calls.map((c) => c[1] as { type: string; data?: { delta?: string } });
      const thinking = events.filter((e) => e.type === 'thinking_delta');
      const content = events.filter((e) => e.type === 'content_delta');
      expect(thinking).toHaveLength(1);
      expect(thinking[0]?.data?.delta).toBe('ab');
      expect(content).toHaveLength(1);
      expect(content[0]?.data?.delta).toBe('x');
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes pending deltas before non-delta events to preserve ordering', () => {
    const { listener, registry } = makeListener();
    listener.onContentDelta('partial');
    listener.onThinkingStart();
    const calls = vi.mocked(registry.send).mock.calls.map((c) => c[1] as { type: string });
    // thinking_start 发出时，积压的 content_delta 已先行发出
    const contentIdx = calls.findIndex((e) => e.type === 'content_delta');
    const startIdx = calls.findIndex((e) => e.type === 'thinking_start');
    expect(contentIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBe(contentIdx + 1);
  });

  it('sends latest full-args snapshot per tool call at reduced rate', async () => {
    vi.useFakeTimers();
    try {
      const { listener, registry } = makeListener();
      listener.onToolCallStart({ id: 'tc-1', function: { name: 'write_file', arguments: '{"a"' } } as never);
      registry.send.mockClear();
      // 同一 toolCall 的多次 args delta 只保留最新全量快照
      listener.onToolCallArgsDelta('tc-1', '{"a":1');
      listener.onToolCallArgsDelta('tc-1', '{"a":12');
      listener.onToolCallArgsDelta('tc-1', '{"a":123}');
      // 并行第二个 toolCall 的快照互不覆盖
      listener.onToolCallArgsDelta('tc-2', '{"b":9}');
      await vi.advanceTimersByTimeAsync(50);
      const events = vi.mocked(registry.send).mock.calls
        .map((c) => c[1] as { type: string; data?: { tool_call_id?: string; arguments?: string } })
        .filter((e) => e.type === 'tool_call_args_delta');
      expect(events).toHaveLength(2);
      expect(events.find((e) => e.data?.tool_call_id === 'tc-1')?.data?.arguments).toBe('{"a":123}');
      expect(events.find((e) => e.data?.tool_call_id === 'tc-2')?.data?.arguments).toBe('{"b":9}');
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose flushes trailing deltas and stops the timer', async () => {
    vi.useFakeTimers();
    try {
      const { listener, registry } = makeListener();
      listener.onContentDelta('tail');
      listener.dispose();
      const types = vi.mocked(registry.send).mock.calls.map((c) => (c[1] as { type: string }).type);
      expect(types).toContain('content_delta');
      // 定时器已清：推进时间不应再产生重复事件
      await vi.advanceTimersByTimeAsync(100);
      const count = vi.mocked(registry.send).mock.calls
        .filter((c) => (c[1] as { type: string }).type === 'content_delta').length;
      expect(count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
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
