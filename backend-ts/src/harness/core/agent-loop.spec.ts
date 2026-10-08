import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentLoop } from './agent-loop.js';
import { AgentExecutionContext } from './agent-execution-context.js';
import { CompactionConfig } from './compaction-config.js';
import { CompactionSignalBus } from './compaction-signal-bus.js';
import { AtomicBoolean } from '../atomic-boolean.js';
import type { AgentEventListener } from './agent-event-listener.js';
import type { PromptEngine } from './prompt-engine.js';
import type { ContextManager } from './context-manager.js';
import type { BackgroundTaskManager } from './background-task-manager.js';
import type { SessionCompactionOrchestrator } from './session-compaction-orchestrator.js';
import type { ActiveContextCalculator } from './active-context-calculator.js';
import type { ToolDispatcher } from '../tool/tool-dispatcher.js';
import type { LlmAdapter, StreamCallback, StreamChunk, ToolCall } from '../llm/chat-request.js';
import type { ShellSessionManager } from '../shell/shell-session-manager.js';
import type { SessionService } from '../deps.js';
import type { McpClientManager } from '../mcp/mcp-client-manager.js';
import type { Tool } from '../tool/tool.js';
import { ToolCallContext } from '../tool/tool-call-context.js';

describe('AgentLoop', () => {
  const llmAdapter = { stream: vi.fn(), chat: vi.fn() } as unknown as LlmAdapter & { stream: ReturnType<typeof vi.fn> };
  const promptEngine = { buildRequest: vi.fn() } as unknown as PromptEngine & { buildRequest: ReturnType<typeof vi.fn> };
  const contextManager = {} as ContextManager;
  const toolDispatcher = { dispatchInvocation: vi.fn() } as unknown as ToolDispatcher & { dispatchInvocation: ReturnType<typeof vi.fn> };
  const backgroundTaskManager = {
    consumeCompletedResults: vi.fn(),
  } as unknown as BackgroundTaskManager & { consumeCompletedResults: ReturnType<typeof vi.fn> };
  const shellSessionManager = {
    closeByConversation: vi.fn(),
  } as unknown as ShellSessionManager & { closeByConversation: ReturnType<typeof vi.fn> };
  const activityHeartbeat = { touch: vi.fn(), start: vi.fn(), stop: vi.fn(), clear: vi.fn() };
  const sessionService = {
    loadContextAnchor: vi.fn(),
    getMaxMessageId: vi.fn(),
    getSession: vi.fn(),
    updateContextAnchor: vi.fn(),
  } as unknown as SessionService & {
    loadContextAnchor: ReturnType<typeof vi.fn>;
    getMaxMessageId: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
  };
  const sessionCompactionOrchestrator = {
    compact: vi.fn(),
  } as unknown as SessionCompactionOrchestrator & { compact: ReturnType<typeof vi.fn> };
  const activeContextCalculator = {
    activeFromMessageSuffix: vi.fn(),
  } as unknown as ActiveContextCalculator & { activeFromMessageSuffix: ReturnType<typeof vi.fn> };
  const mcpClientManager = { closeSession: vi.fn() } as unknown as McpClientManager;
  const agentLoop = new AgentLoop(
    llmAdapter, promptEngine, contextManager, toolDispatcher, backgroundTaskManager,
    shellSessionManager, activityHeartbeat, sessionService, sessionCompactionOrchestrator,
    activeContextCalculator, mcpClientManager,
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function stubActiveContext(tokens: number): void {
    activeContextCalculator.activeFromMessageSuffix.mockReturnValue(tokens);
    sessionService.loadContextAnchor.mockResolvedValue({ lastPromptTokens: 0, contextAnchorMsgId: 0 });
    sessionService.getMaxMessageId.mockResolvedValue(1);
    sessionService.getSession.mockResolvedValue({ phase: 'RUNNING' });
  }

  function toolResult(content: string, status: 'success' | 'error' = 'success') {
    return { callId: 'call', status, content };
  }

  function listener(): AgentEventListener & Record<string, ReturnType<typeof vi.fn>> {
    return {
      onContentDelta: vi.fn(),
      onToolCallStart: vi.fn(),
      onToolCallResult: vi.fn(),
      onToolCallArgsDelta: vi.fn(),
      onMessageEnd: vi.fn(),
      onError: vi.fn(),
      onThinkingDelta: vi.fn(),
      onLlmStreamReset: vi.fn(),
      onContextWindow: vi.fn(),
      onThinkingStart: vi.fn(),
      onThinkingEnd: vi.fn(),
      onRoundStart: vi.fn(),
      onRoundEnd: vi.fn(),
    };
  }

  function persistence() {
    return { onSaveAssistantMessage: vi.fn(), onSaveToolMessage: vi.fn() };
  }

  function namedTool(name: string): Tool {
    return { getName: () => name, getDescription: () => name, getInputSchema: () => ({}), getOutputSchema: () => ({}), execute: () => '' };
  }

  function context(): AgentExecutionContext {
    const ctx = new AgentExecutionContext();
    ctx.sessionId = 11;
    ctx.userId = 7;
    ctx.executionMode = 'CLOUD';
    ctx.workspace = '/repo';
    ctx.permissionLevel = 'READ_ONLY';
    ctx.addUserMessage('hi');
    ctx.tools = [namedTool('read_file')];
    return ctx;
  }

  function contextWithMidLoopConfig(window: number, triggerRatio: number): AgentExecutionContext {
    const ctx = context();
    const cfg = new CompactionConfig();
    cfg.enabled = true;
    cfg.loopMidwayCompact = true;
    cfg.contextWindowTokens = window;
    cfg.triggerRatio = triggerRatio;
    ctx.compactionConfig = cfg;
    ctx.modelConfig = { contextWindowTokens: window };
    return ctx;
  }

  function contentChunk(reasoning: string | null, content: string | null): StreamChunk {
    return { choices: [{ delta: { reasoningContent: reasoning ?? undefined, content: content ?? undefined } }] };
  }

  function toolChunk(toolCall: ToolCall): StreamChunk {
    return { choices: [{ delta: { toolCalls: [toolCall] } }] };
  }

  function stubToolThenDone(): void {
    let call = 0;
    llmAdapter.stream.mockImplementation(async (_r: unknown, _c: unknown, callback: StreamCallback) => {
      if (call++ === 0) {
        callback.onChunk(toolChunk({
          id: 'call-1',
          function: { name: 'read_file', arguments: '{"path":"a"}' },
        }));
        callback.onComplete({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
      } else {
        callback.onChunk(contentChunk(null, 'done'));
        callback.onComplete({ promptTokens: 4, completionTokens: 1, totalTokens: 5 });
      }
    });
  }

  it.each([
    'LLM API returned 400: invalid summary',
    'LLM call failed: timeout',
  ])('preserves the original LLM error across repeated callbacks: %s', async (message) => {
    const failure = new Error(message);
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    stubActiveContext(42);
    llmAdapter.stream.mockImplementation(async (_r: unknown, _c: unknown, callback: StreamCallback) => {
      try {
        callback.onError(failure);
      } catch (error) {
        callback.onError(error);
      }
    });

    await expect(agentLoop.execute(context(), listener(), persistence())).rejects.toBe(failure);
    expect(failure.message).toBe(message);
  });

  it('executeStreamsPlainAssistantMessageAndPersistsIt', async () => {
    const ctx = context();
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    backgroundTaskManager.consumeCompletedResults.mockReturnValueOnce({ 'task-1': 'done' }).mockReturnValue({});
    stubActiveContext(42);
    llmAdapter.stream.mockImplementation(async (_r: unknown, _c: unknown, callback: StreamCallback) => {
      callback.onChunk(contentChunk('thinking', null));
      callback.onChunk(contentChunk(null, 'hello'));
      callback.onComplete({ promptTokens: 10, completionTokens: 2, totalTokens: 12 });
    });

    await agentLoop.execute(ctx, l, p);

    expect(ctx.messages.map((m) => m.role)).toEqual(expect.arrayContaining(['user', 'assistant']));
    expect(l.onThinkingDelta).toHaveBeenCalledWith('thinking');
    expect(l.onContentDelta).toHaveBeenCalledWith('hello');
    expect(l.onMessageEnd).toHaveBeenCalled();
    expect(p.onSaveAssistantMessage).toHaveBeenCalledWith('hello', 'thinking', [], expect.objectContaining({ totalTokens: 12 }));
    expect(shellSessionManager.closeByConversation).toHaveBeenCalledWith(11);
  });

  it('executeAwaitsAssistantPersistBeforeReturning', async () => {
    const ctx = context();
    const l = listener();
    let persistFinished = false;
    const p = {
      onSaveAssistantMessage: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 30));
        persistFinished = true;
      }),
      onSaveToolMessage: vi.fn(),
    };
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    stubActiveContext(42);
    llmAdapter.stream.mockImplementation(async (_r: unknown, _c: unknown, callback: StreamCallback) => {
      callback.onChunk(contentChunk(null, 'hello'));
      callback.onComplete({ promptTokens: 10, completionTokens: 2, totalTokens: 12 });
    });

    await agentLoop.execute(ctx, l, p);
    expect(persistFinished).toBe(true);
  });

  it('executeDiscardsPartialOutputWhenStreamIsRetried', async () => {
    const ctx = context();
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    stubActiveContext(42);
    llmAdapter.stream.mockImplementation(async (_r: unknown, _c: unknown, callback: StreamCallback) => {
      callback.onChunk(contentChunk('old thinking', null));
      callback.onChunk(contentChunk(null, 'partial'));
      callback.onStreamReset?.();
      callback.onChunk(contentChunk('new thinking', null));
      callback.onChunk(contentChunk(null, 'replacement'));
      callback.onComplete({ promptTokens: 10, completionTokens: 2, totalTokens: 12 });
    });

    await agentLoop.execute(ctx, l, p);

    expect(l.onLlmStreamReset).toHaveBeenCalled();
    expect(p.onSaveAssistantMessage).toHaveBeenCalledWith('replacement', 'new thinking', [], expect.anything());
  });

  it('executeRunsToolCallThenContinuesToSynthesisRound', async () => {
    const ctx = context();
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    stubActiveContext(5);
    toolDispatcher.dispatchInvocation.mockResolvedValue(toolResult('{"ok":true,"_private_diff":{"diff_mode":"PATCH"}}'));
    let call = 0;
    llmAdapter.stream.mockImplementation(async (_r: unknown, _c: unknown, callback: StreamCallback) => {
      if (call++ === 0) {
        callback.onChunk(toolChunk({
          id: 'call-1',
          function: { name: 'read_file', arguments: '{' },
        }));
        callback.onChunk(toolChunk({
          function: { arguments: '"path":"a"}' },
        }));
        callback.onComplete({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
      } else {
        callback.onChunk(contentChunk(null, 'done'));
        callback.onComplete({ promptTokens: 4, completionTokens: 1, totalTokens: 5 });
      }
    });

    await agentLoop.execute(ctx, l, p);

    expect(p.onSaveAssistantMessage.mock.calls[0][3]).toEqual(expect.objectContaining({ 'call-1': expect.any(String) }));
    expect(p.onSaveToolMessage).toHaveBeenCalledWith('call-1', '{"ok":true,"_private_diff":{"diff_mode":"PATCH"}}', null);
    expect(p.onSaveAssistantMessage).toHaveBeenCalledWith('done', null, [], expect.anything());
    expect(l.onToolCallStart).toHaveBeenCalledTimes(2);
    expect(l.onToolCallStart).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'call-1',
      function: expect.objectContaining({ arguments: '{"path":"a"}' }),
    }));
    expect(l.onToolCallResult).toHaveBeenCalledWith('call-1', expect.any(String), expect.objectContaining({ status: 'success' }));
    expect(ctx.messages.map((m) => m.role)).toEqual(expect.arrayContaining(['assistant', 'tool', 'assistant']));
  });

  it('sniffsBackendTruncationIntoBothMetadataAndLiveMeta', async () => {
    // 技术方案 5.6：结果 JSON 顶层 truncated===true → 落库 metadataJson（历史回放）+ meta 通道（实时事件）双写。
    const ctx = context();
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    stubActiveContext(5);
    toolDispatcher.dispatchInvocation.mockResolvedValue(
      { ...toolResult('{"content":"xxxxx","truncated":true}'), approvalMark: { mode: 'llm', approved: true, reason: '符合用户指令' } },
    );
    let call = 0;
    llmAdapter.stream.mockImplementation(async (_r: unknown, _c: unknown, callback: StreamCallback) => {
      if (call++ === 0) {
        callback.onChunk(toolChunk({ id: 'call-1', function: { name: 'read_file', arguments: '{"path":"a"}' } }));
        callback.onComplete({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
      } else {
        callback.onChunk(contentChunk(null, 'done'));
        callback.onComplete({ promptTokens: 4, completionTokens: 1, totalTokens: 5 });
      }
    });

    await agentLoop.execute(ctx, l, p);

    expect(l.onToolCallResult).toHaveBeenCalledWith(
      'call-1', expect.any(String), expect.objectContaining({ status: 'success', resultTruncated: true }),
    );
    const saved = p.onSaveToolMessage.mock.calls[0];
    expect(saved[0]).toBe('call-1');
    const meta = JSON.parse(saved[2] as string);
    // 与 approvalMark 共存、互不覆盖。
    expect(meta.resultTruncated).toBe(true);
    expect(meta.approvalMark).toEqual({ mode: 'llm', approved: true, reason: '符合用户指令' });
  });

  it('doesNotMarkTruncationForNonJsonOrFlaglessResults', async () => {
    const ctx = context();
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    stubActiveContext(5);
    toolDispatcher.dispatchInvocation.mockResolvedValue(toolResult('plain text, not json'));
    let call = 0;
    llmAdapter.stream.mockImplementation(async (_r: unknown, _c: unknown, callback: StreamCallback) => {
      if (call++ === 0) {
        callback.onChunk(toolChunk({ id: 'call-2', function: { name: 'read_file', arguments: '{"path":"a"}' } }));
        callback.onComplete({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
      } else {
        callback.onChunk(contentChunk(null, 'done'));
        callback.onComplete({ promptTokens: 4, completionTokens: 1, totalTokens: 5 });
      }
    });

    await agentLoop.execute(ctx, l, p);

    const [, , meta] = (l.onToolCallResult.mock.calls[0] ?? []) as [string, string, Record<string, unknown> | undefined];
    expect(meta?.resultTruncated ?? undefined).toBeUndefined();
    expect(p.onSaveToolMessage.mock.calls[0][2]).toBeNull();
  });

  it('merges repeated tool-call chunks that carry the same id instead of starting each chunk', async () => {
    const ctx = context();
    ctx.tools = [namedTool('write_file')];
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    stubActiveContext(5);
    toolDispatcher.dispatchInvocation.mockResolvedValue(toolResult('{"ok":true}'));
    let call = 0;
    llmAdapter.stream.mockImplementation(async (_r: unknown, _c: unknown, callback: StreamCallback) => {
      if (call++ === 0) {
        callback.onChunk(toolChunk({
          id: 'call_80eb756f08f94773b4f97c60',
          function: { name: 'write_file', arguments: '{"path":' },
        }));
        callback.onChunk(toolChunk({
          id: 'call_80eb756f08f94773b4f97c60',
          function: { name: 'write_file', arguments: '"a.html",' },
        }));
        callback.onChunk(toolChunk({
          id: 'call_80eb756f08f94773b4f97c60',
          function: { name: 'write_file', arguments: '"content":"x"}' },
        }));
        callback.onComplete({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
      } else {
        callback.onChunk(contentChunk(null, 'done'));
        callback.onComplete({ promptTokens: 4, completionTokens: 1, totalTokens: 5 });
      }
    });

    await agentLoop.execute(ctx, l, p);

    expect(l.onToolCallStart).toHaveBeenCalledTimes(2);
    expect(l.onToolCallStart).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'call_80eb756f08f94773b4f97c60',
      function: expect.objectContaining({ name: 'write_file', arguments: '{"path":"a.html","content":"x"}' }),
    }));
    expect(toolDispatcher.dispatchInvocation).toHaveBeenCalledTimes(1);
    expect(toolDispatcher.dispatchInvocation).toHaveBeenCalledWith(expect.objectContaining({
      callId: 'call_80eb756f08f94773b4f97c60',
      toolName: 'write_file',
      argumentsJson: '{"path":"a.html","content":"x"}',
      executionMode: 'CLOUD',
      sessionId: 11,
      userId: 7,
      executionUserId: ctx.executionUserId ?? null,
      workspace: '/repo',
      permissionLevel: 'READ_ONLY',
      sessionTools: ctx.tools,
    }));
    expect(p.onSaveAssistantMessage.mock.calls[0][2]).toHaveLength(1);
    expect(p.onSaveAssistantMessage.mock.calls[0][2][0]).toEqual(expect.objectContaining({
      id: 'call_80eb756f08f94773b4f97c60',
      summary: '写入 a.html',
    }));
  });

  it('keeps parallel tool_call_id isolated after awaits', async () => {
    const ctx = context();
    ctx.tools = [namedTool('read_file'), namedTool('shell')];
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    stubActiveContext(5);
    const seen: string[] = [];
    toolDispatcher.dispatchInvocation.mockImplementation(async (inv: { toolName: string }) => {
      const name = inv.toolName;
      await new Promise((r) => setTimeout(r, name === 'read_file' ? 25 : 5));
      seen.push(`${name}:${ToolCallContext.getToolCallId() ?? ''}`);
      return toolResult('{"ok":true}');
    });
    llmAdapter.stream.mockImplementationOnce(async (_r: unknown, _c: unknown, callback: StreamCallback) => {
      callback.onChunk(toolChunk({ id: 'call-read', index: 0, function: { name: 'read_file', arguments: '{"path":"a"}' } }));
      callback.onChunk(toolChunk({ id: 'call-shell', index: 1, function: { name: 'shell', arguments: '{"command":"pwd"}' } }));
      callback.onComplete({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    });

    await agentLoop.execute(ctx, l, p);

    expect(seen.sort()).toEqual(['read_file:call-read', 'shell:call-shell']);
  });

  it('does not process or persist parallel tool results after cancellation wins the race', async () => {
    const ctx = context();
    ctx.tools = [namedTool('read_file'), namedTool('shell')];
    const l = listener();
    const p = persistence();
    const cancelFlag = agentLoop.registerCancelFlag(11);
    // 停机收尾据此枚举本实例全部在途执行（含飞书/钉钉/微信入站，它们不经 wsHandler 登记）。
    expect(agentLoop.listActiveSessionIds()).toContain(11);
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    stubActiveContext(5);
    let dispatchCount = 0;
    toolDispatcher.dispatchInvocation.mockImplementation(async () => {
      dispatchCount++;
      if (dispatchCount === 2) cancelFlag.set(true);
      return toolResult(dispatchCount === 1 ? '{"total_lines":2}' : '{"exit_code":0}');
    });
    llmAdapter.stream.mockImplementationOnce(async (_r: unknown, _c: unknown, callback: StreamCallback) => {
      callback.onChunk(toolChunk({ id: 'call-read', index: 0, function: { name: 'read_file', arguments: '{"path":"a"}' } }));
      callback.onChunk(toolChunk({ id: 'call-shell', index: 1, function: { name: 'shell', arguments: '{"command":"pwd"}' } }));
      callback.onComplete({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    });

    await agentLoop.execute(ctx, l, p);

    expect(l.onToolCallResult).not.toHaveBeenCalled();
    expect(p.onSaveAssistantMessage).not.toHaveBeenCalled();
    expect(p.onSaveToolMessage).not.toHaveBeenCalled();
    expect(ctx.messages.some((m) => m.role === 'assistant' || m.role === 'tool')).toBe(false);
    expect(l.onMessageEnd).toHaveBeenCalledTimes(1);
    // 执行结束（无论正常收尾还是被取消）必须摘除标志：否则停机收尾会一直以为该会话在跑，
    // 每次部署都白等满 grace，孤儿巡检也会永久跳过它。
    expect(agentLoop.listActiveSessionIds()).not.toContain(11);
    expect(activityHeartbeat.stop).toHaveBeenCalledWith(11);
  });

  it('keeps interleaved tool-call argument chunks bound to their index', async () => {
    const ctx = context();
    ctx.tools = [namedTool('shell'), namedTool('read_file')];
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    stubActiveContext(5);
    toolDispatcher.dispatchInvocation.mockResolvedValue(toolResult('{"ok":true}'));
    let call = 0;
    llmAdapter.stream.mockImplementation(async (_r: unknown, _c: unknown, callback: StreamCallback) => {
      if (call++ === 0) {
        callback.onChunk(toolChunk({
          index: 0,
          id: 'call-shell',
          function: { name: 'shell', arguments: '{"command":' },
        }));
        callback.onChunk(toolChunk({
          index: 1,
          id: 'call-read',
          function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
        }));
        callback.onChunk(toolChunk({
          index: 0,
          function: { arguments: '"pwd"}' },
        }));
        callback.onComplete({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
      } else {
        callback.onChunk(contentChunk(null, 'done'));
        callback.onComplete({ promptTokens: 4, completionTokens: 1, totalTokens: 5 });
      }
    });

    await agentLoop.execute(ctx, l, p);

    expect(l.onToolCallArgsDelta).toHaveBeenCalledWith('call-shell', '{"command":"pwd"}');
    expect(l.onToolCallArgsDelta).toHaveBeenCalledWith('call-read', '{"path":"a.ts"}');
    expect(l.onToolCallStart).toHaveBeenCalledWith(expect.objectContaining({
      id: 'call-shell',
      function: expect.objectContaining({ arguments: '{"command":"pwd"}' }),
    }));
    expect(l.onToolCallStart).toHaveBeenCalledWith(expect.objectContaining({
      id: 'call-read',
      function: expect.objectContaining({ arguments: '{"path":"a.ts"}' }),
    }));
    expect(vi.mocked(l.onToolCallStart).mock.calls.filter(([tc]) => tc.id === 'call-shell')).toHaveLength(2);
    expect(vi.mocked(l.onToolCallStart).mock.calls.filter(([tc]) => tc.id === 'call-read')).toHaveLength(2);
    expect(toolDispatcher.dispatchInvocation).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'shell',
      argumentsJson: '{"command":"pwd"}',
      executionMode: 'CLOUD',
      sessionId: 11,
      userId: 7,
      executionUserId: ctx.executionUserId ?? null,
      workspace: '/repo',
      permissionLevel: 'READ_ONLY',
      sessionTools: ctx.tools,
    }));
  });

  it('creates tool calls from index-only deltas whose gateway never sends ids', async () => {
    // 部分 OpenAI 兼容网关只按 index 分片、从不回传 id：mergeToolCall 必须把这类
    // 分片当新 tool call 追加，否则整段调用被静默丢弃（连第一个都进不了 toolCalls）。
    const ctx = context();
    ctx.tools = [namedTool('shell'), namedTool('read_file')];
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    stubActiveContext(5);
    toolDispatcher.dispatchInvocation.mockResolvedValue(toolResult('{"ok":true}'));
    let call = 0;
    llmAdapter.stream.mockImplementation(async (_r: unknown, _c: unknown, callback: StreamCallback) => {
      if (call++ === 0) {
        callback.onChunk(toolChunk({ index: 0, function: { name: 'shell', arguments: '{"command":"pwd"}' } }));
        callback.onChunk(toolChunk({ index: 1, function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }));
        callback.onComplete({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
      } else {
        callback.onChunk(contentChunk(null, 'done'));
        callback.onComplete({ promptTokens: 4, completionTokens: 1, totalTokens: 5 });
      }
    });

    await agentLoop.execute(ctx, l, p);

    expect(toolDispatcher.dispatchInvocation).toHaveBeenCalledTimes(2);
    expect(toolDispatcher.dispatchInvocation).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'shell',
      argumentsJson: '{"command":"pwd"}',
    }));
    expect(toolDispatcher.dispatchInvocation).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'read_file',
      argumentsJson: '{"path":"a.ts"}',
    }));
    // 派发时必须带上合成 id：缺 id 时 tool 消息的 toolCallId 为空，normalizeChatMessages
    // 会把第 2 轮起的 tool 结果整体剥掉，严格网关还会因 tool_calls[].id 缺失 400
    for (const [invocation] of vi.mocked(toolDispatcher.dispatchInvocation).mock.calls) {
      expect(invocation.callId).toMatch(/^call-/);
    }
    // 助手 tool_calls 与 tool 消息必须按 id 一一配对（历史归一化与持久化的前提）
    const assistant = ctx.messages.find((m) => m.role === 'assistant' && m.toolCalls?.length);
    expect(assistant).toBeDefined();
    const callIds = assistant!.toolCalls!.map((tc) => tc.id);
    expect(callIds.every((id) => typeof id === 'string' && id !== '')).toBe(true);
    expect(new Set(callIds).size).toBe(2);
    expect(ctx.messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId).sort())
      .toEqual([...callIds].sort());
    expect(vi.mocked(p.onSaveToolMessage).mock.calls.map(([toolCallId]) => toolCallId).sort())
      .toEqual([...callIds].sort());
    // 首片即派发开始事件（early start 也依赖 id 去重）
    expect(vi.mocked(l.onToolCallStart).mock.calls.every(([tc]) => typeof tc.id === 'string' && tc.id !== '')).toBe(true);
  });

  it('keeps synthesized ids distinct when index-only calls repeat in later rounds', async () => {
    // 同一 index 会在后续轮次复用：按 index 推导 id 会让 normalizeChatMessages 的配对表
    // 跨轮错并（两轮的 tool 消息都被当成同一调用的结果），必须按调用唯一。
    const ctx = context();
    ctx.tools = [namedTool('shell'), namedTool('read_file')];
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    stubActiveContext(5);
    toolDispatcher.dispatchInvocation.mockResolvedValue(toolResult('{"ok":true}'));
    let call = 0;
    llmAdapter.stream.mockImplementation(async (_r: unknown, _c: unknown, callback: StreamCallback) => {
      if (call === 0) {
        call++;
        callback.onChunk(toolChunk({ index: 0, function: { name: 'shell', arguments: '{"command":"pwd"}' } }));
        callback.onComplete({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
      } else if (call === 1) {
        call++;
        callback.onChunk(toolChunk({ index: 0, function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }));
        callback.onComplete({ promptTokens: 4, completionTokens: 2, totalTokens: 6 });
      } else {
        callback.onChunk(contentChunk(null, 'done'));
        callback.onComplete({ promptTokens: 5, completionTokens: 1, totalTokens: 6 });
      }
    });

    await agentLoop.execute(ctx, l, p);

    expect(toolDispatcher.dispatchInvocation).toHaveBeenCalledTimes(2);
    const [assistant1, tool1, assistant2, tool2] = ctx.messages.filter(
      (m) => m.role === 'assistant' || m.role === 'tool',
    );
    const id1 = assistant1.toolCalls![0].id;
    const id2 = assistant2.toolCalls![0].id;
    expect(id1).toMatch(/^call-/);
    expect(id2).toMatch(/^call-/);
    expect(id2).not.toBe(id1);
    expect(tool1.toolCallId).toBe(id1);
    expect(tool2.toolCallId).toBe(id2);
  });

  it('merges a late id-bearing delta into an id-less first chunk without duplicating dispatch', async () => {
    // 首片无 id、后续分片才带回 id 的网关：合成占位后按 index 归并，整条调用只派发一次。
    const ctx = context();
    ctx.tools = [namedTool('shell')];
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    stubActiveContext(5);
    toolDispatcher.dispatchInvocation.mockResolvedValue(toolResult('{"ok":true}'));
    let call = 0;
    llmAdapter.stream.mockImplementation(async (_r: unknown, _c: unknown, callback: StreamCallback) => {
      if (call++ === 0) {
        callback.onChunk(toolChunk({ index: 0, function: { name: 'shell', arguments: '{"command":' } }));
        callback.onChunk(toolChunk({ index: 0, id: 'call-real', function: { arguments: '"pwd"}' } }));
        callback.onComplete({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
      } else {
        callback.onChunk(contentChunk(null, 'done'));
        callback.onComplete({ promptTokens: 4, completionTokens: 1, totalTokens: 5 });
      }
    });

    await agentLoop.execute(ctx, l, p);

    expect(toolDispatcher.dispatchInvocation).toHaveBeenCalledTimes(1);
    expect(toolDispatcher.dispatchInvocation).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'shell',
      argumentsJson: '{"command":"pwd"}',
    }));
    const assistant = ctx.messages.find((m) => m.role === 'assistant' && m.toolCalls?.length);
    expect(assistant!.toolCalls).toHaveLength(1);
    expect(assistant!.toolCalls![0].id).toMatch(/^call-/);
  });

  it('executeStripsImageDataUriFromPersistedToolMessage', async () => {
    const ctx = context();
    ctx.modelConfig = { supportsVision: true };
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    stubActiveContext(5);
    const imageResult = '{"content":"图片读取成功：a.png","total_lines":0,"media_type":"image","mime":"image/png","path":"a.png","size_bytes":10,"data_uri":"data:image/png;base64,abc"}';
    toolDispatcher.dispatchInvocation.mockResolvedValue(toolResult(imageResult));
    let call = 0;
    llmAdapter.stream.mockImplementation(async (_r: unknown, _c: unknown, callback: StreamCallback) => {
      if (call++ === 0) {
        callback.onChunk(toolChunk({
          id: 'call-img',
          function: { name: 'read_file', arguments: '{"path":"a.png"}' },
        }));
        callback.onComplete({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
      } else {
        callback.onChunk(contentChunk(null, 'seen'));
        callback.onComplete({ promptTokens: 4, completionTokens: 1, totalTokens: 5 });
      }
    });

    await agentLoop.execute(ctx, l, p);

    const save = p.onSaveToolMessage.mock.calls[0];
    const persistedAssistantToolCalls = p.onSaveAssistantMessage.mock.calls[0][2] as ToolCall[];
    expect(persistedAssistantToolCalls[0]).toEqual(expect.objectContaining({
      id: 'call-img',
      summary: '读取 a.png (图片)',
    }));
    expect(save[0]).toBe('call-img');
    expect(save[1]).toContain('图片读取成功');
    expect(save[1]).not.toContain('data_uri');
    expect(save[2]).toContain('data_uri');
    expect(ctx.toolAttachments.get('call-img')?.dataUri).toMatch(/^data:image\/png;base64,/);
  });

  it('executeStopsWhenInheritedParentCancelFlagIsSet', async () => {
    const ctx = context();
    ctx.sessionId = 99;
    ctx.cancelFlag = new AtomicBoolean(true);
    const l = listener();
    await agentLoop.execute(ctx, l, null);
    expect(llmAdapter.stream).not.toHaveBeenCalled();
    expect(shellSessionManager.closeByConversation).toHaveBeenCalledWith(99);
    expect(l.onRoundEnd).toHaveBeenCalledTimes(1);
    expect(l.onMessageEnd).toHaveBeenCalledTimes(1);
  });

  it('requestCancelSetsRegisteredFlag', () => {
    const flag = agentLoop.registerCancelFlag(42);
    expect(flag.get()).toBe(false);
    agentLoop.requestCancel(42);
    expect(flag.get()).toBe(true);
    expect(agentLoop.getCancelFlag(42)).toBe(flag);
    agentLoop.removeCancelFlag(42);
    expect(agentLoop.getCancelFlag(42)).toBeUndefined();
  });

  it('executeStopsBeforeLlmWhenCancelFlagIsSet', async () => {
    const ctx = context();
    const l = listener();
    const cancelFlag = agentLoop.registerCancelFlag(11);
    cancelFlag.set(true);
    await agentLoop.execute(ctx, l, null);
    expect(llmAdapter.stream).not.toHaveBeenCalled();
    expect(shellSessionManager.closeByConversation).toHaveBeenCalledWith(11);
    // 取消路径也必须成对收尾，否则监听器回合状态悬挂
    expect(l.onRoundStart).toHaveBeenCalled();
    expect(l.onRoundEnd).toHaveBeenCalledTimes(1);
    expect(l.onMessageEnd).toHaveBeenCalledTimes(1);
    expect(l.onRoundEnd.mock.calls[0][0]).toBe(l.onRoundStart.mock.calls[0][0]);
  });

  it('cancelBeforeLlmDoesNotReportCancelledRoundUsage', async () => {
    const ctx = context();
    ctx.totalUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
    const l = listener();
    const cancelFlag = agentLoop.registerCancelFlag(11);
    cancelFlag.set(true);
    await agentLoop.execute(ctx, l, null);
    // 轮首取消：本轮无增量用量，onMessageEnd 只带既有累计
    expect(l.onMessageEnd).toHaveBeenCalledWith({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it('midLoopCompactionTriggersWhenRequestNearWindow', async () => {
    const ctx = contextWithMidLoopConfig(100, 0.5);
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    stubActiveContext(80);
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    toolDispatcher.dispatchInvocation.mockResolvedValue(toolResult('{"ok":true}'));
    sessionCompactionOrchestrator.compact.mockResolvedValue(true);
    stubToolThenDone();
    await agentLoop.execute(ctx, l, p);
    expect(sessionCompactionOrchestrator.compact).toHaveBeenCalled();
    expect(sessionCompactionOrchestrator.compact.mock.calls[0][0]).toBe(11);
    expect(sessionCompactionOrchestrator.compact.mock.calls[0][5]).toBe(true);
  });

  it('midLoopCompactionSkippedWithoutPersistenceCallback', async () => {
    const ctx = contextWithMidLoopConfig(100, 0.5);
    const l = listener();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    stubActiveContext(80);
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    toolDispatcher.dispatchInvocation.mockResolvedValue(toolResult('{"ok":true}'));
    stubToolThenDone();
    await agentLoop.execute(ctx, l, null);
    expect(sessionCompactionOrchestrator.compact).not.toHaveBeenCalled();
  });

  it('midLoopCompactionMayRetryAfterNoProgressOnLaterToolRound', async () => {
    const ctx = contextWithMidLoopConfig(100, 0.5);
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    stubActiveContext(80);
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    toolDispatcher.dispatchInvocation.mockResolvedValue(toolResult('{"ok":true}'));
    sessionCompactionOrchestrator.compact.mockResolvedValue(false);
    let call = 0;
    llmAdapter.stream.mockImplementation(async (_r: unknown, _c: unknown, callback: StreamCallback) => {
      if (call++ < 2) {
        callback.onChunk(toolChunk({
          id: 'call-' + call,
          function: { name: 'read_file', arguments: '{"path":"a"}' },
        }));
        callback.onComplete({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
      } else {
        callback.onChunk(contentChunk(null, 'done'));
        callback.onComplete({ promptTokens: 4, completionTokens: 1, totalTokens: 5 });
      }
    });
    await agentLoop.execute(ctx, l, p);
    expect(sessionCompactionOrchestrator.compact).toHaveBeenCalled();
  });

  it('midLoopCompactionNotTriggeredBelowThreshold', async () => {
    const ctx = contextWithMidLoopConfig(100, 0.9);
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    stubActiveContext(50);
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    toolDispatcher.dispatchInvocation.mockResolvedValue(toolResult('{"ok":true}'));
    stubToolThenDone();
    await agentLoop.execute(ctx, l, p);
    expect(sessionCompactionOrchestrator.compact).not.toHaveBeenCalled();
  });

  it('retriesOnEmptyLlmResponseAndSucceedsOnSecondAttempt', async () => {
    const ctx = context();
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    stubActiveContext(42);
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    let call = 0;
    llmAdapter.stream.mockImplementation(async (_r: unknown, _c: unknown, callback: StreamCallback) => {
      call++;
      if (call === 1) {
        // 第 1 次：空响应（无 content、无 tool_calls）
        callback.onComplete({ promptTokens: 10, completionTokens: 0, totalTokens: 10 });
      } else {
        // 第 2 次：正常响应
        callback.onChunk(contentChunk(null, 'done'));
        callback.onComplete({ promptTokens: 10, completionTokens: 2, totalTokens: 12 });
      }
    });
    await agentLoop.execute(ctx, l, p);
    expect(l.onMessageEnd).toHaveBeenCalled();
    expect(l.onError).not.toHaveBeenCalled();
    expect(call).toBe(2);
    // 空响应后应重试，不再注入系统提示（addSystemMessage 现在使用 user role）
    expect(promptEngine.buildRequest).toHaveBeenCalled();
    const secondCallMessages = promptEngine.buildRequest.mock.calls[0][0]?.messages;
    const allMsgs = secondCallMessages ?? [];
    expect(allMsgs.some((m: { content: string }) => String(m.content).includes('上一轮模型未产生有效输出'))).toBe(false);
  });

  it('throwsFriendlyErrorAfterTenConsecutiveEmptyResponses', async () => {
    vi.useFakeTimers();
    try {
      const ctx = context();
      const l = listener();
      const p = persistence();
      promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
      stubActiveContext(42);
      backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
      let call = 0;
      llmAdapter.stream.mockImplementation(async (_r: unknown, _c: unknown, callback: StreamCallback) => {
        call++;
        callback.onComplete({ promptTokens: 10, completionTokens: 0, totalTokens: 10 });
      });
      const promise = agentLoop.execute(ctx, l, p);
      // 防止 unhandled rejection：立即捕获
      const assertion = promise.then(
        () => { throw new Error('expected rejection but resolved'); },
        (e: Error) => e,
      );
      // 指数退避：1+2+4+8+16+30+30+30+30 = 151s，快进定时器
      await vi.advanceTimersByTimeAsync(200_000);
      const err = await assertion;
      expect(err.message).toBe('LLM 连续返回空响应，自动重试已耗尽，请重试');
      expect(call).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });

  // —— 手动压缩 loop 边界消费（技术方案 5.4 / 决策 6、11）——
  function loopWithBus(bus: CompactionSignalBus): AgentLoop {
    return new AgentLoop(
      llmAdapter, promptEngine, contextManager, toolDispatcher, backgroundTaskManager,
      shellSessionManager, activityHeartbeat, sessionService, sessionCompactionOrchestrator,
      activeContextCalculator, mcpClientManager, null, bus,
    );
  }

  it('手动信号在工具轮边界执行压缩，即使自动整理 enabled=false（决策 6：关闭自动≠禁止手动）', async () => {
    const bus = new CompactionSignalBus();
    const loop = loopWithBus(bus);
    const ctx = context();
    // enabled=false + loopMidwayCompact=false：自动路径全程关闭，手动仍必须运行。
    const cfg = new CompactionConfig();
    cfg.enabled = false;
    cfg.loopMidwayCompact = false;
    cfg.contextWindowTokens = 100;
    cfg.triggerRatio = 0.9;
    ctx.compactionConfig = cfg;
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    // 低于阈值：自动 mid_loop 不会触发，唯一能解释 compact 被调的就是手动信号消费。
    stubActiveContext(5);
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    toolDispatcher.dispatchInvocation.mockImplementation(async () => {
      bus.signal(11); // 模拟执行中 handleCompactNow 置位（运行中路径）
      return toolResult('{"ok":true}');
    });
    sessionCompactionOrchestrator.compact.mockResolvedValue(true);
    stubToolThenDone();

    await loop.execute(ctx, l, p);

    const manualCall = vi.mocked(sessionCompactionOrchestrator.compact).mock.calls
      .find((args) => args[8] === 'manual');
    expect(manualCall).toBeDefined();
    expect(manualCall![0]).toBe(11);
    expect(manualCall![5]).toBe(true);   // compactCurrentTurn=true（loop 边界）
    expect(manualCall![8]).toBe('manual');
    expect(manualCall![9]).toBe(true);   // force=true
  });

  it('纯文本收尾轮期间置位的手动信号在退出前执行压缩，不被 finally 静默丢弃', async () => {
    const bus = new CompactionSignalBus();
    const loop = loopWithBus(bus);
    const ctx = context();
    const cfg = new CompactionConfig();
    cfg.enabled = false;
    cfg.loopMidwayCompact = false;
    cfg.contextWindowTokens = 100;
    cfg.triggerRatio = 0.9;
    ctx.compactionConfig = cfg;
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    stubActiveContext(5);
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    toolDispatcher.dispatchInvocation.mockResolvedValue(toolResult('{"ok":true}'));
    sessionCompactionOrchestrator.compact.mockResolvedValue(true);
    let call = 0;
    llmAdapter.stream.mockImplementation(async (_r: unknown, _c: unknown, callback: StreamCallback) => {
      if (call++ === 0) {
        callback.onChunk(toolChunk({
          id: 'call-1',
          function: { name: 'read_file', arguments: '{"path":"a"}' },
        }));
        callback.onComplete({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
        return;
      }
      // 最后一轮工具已经结束，模型正在以纯文本收尾；此时用户点击「立即整理」。
      bus.signal(11);
      callback.onChunk(contentChunk(null, 'done'));
      callback.onComplete({ promptTokens: 4, completionTokens: 1, totalTokens: 5 });
    });

    await loop.execute(ctx, l, p);

    const manualCall = vi.mocked(sessionCompactionOrchestrator.compact).mock.calls
      .find((args) => args[8] === 'manual');
    expect(manualCall).toBeDefined();
    expect(manualCall![0]).toBe(11);
    expect(manualCall![8]).toBe('manual');
    expect(manualCall![9]).toBe(true);
    expect(l.onError).not.toHaveBeenCalled();
    expect(bus.has(11)).toBe(false);
  });

  it('执行启动丢弃陈旧信号：上一轮残留的置位不在本轮触发压缩', async () => {
    const bus = new CompactionSignalBus();
    const loop = loopWithBus(bus);
    const ctx = context();
    const cfg = new CompactionConfig();
    cfg.enabled = true;
    cfg.loopMidwayCompact = true;
    cfg.contextWindowTokens = 100;
    cfg.triggerRatio = 0.9;
    ctx.compactionConfig = cfg;
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    stubActiveContext(5);
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    toolDispatcher.dispatchInvocation.mockResolvedValue(toolResult('{"ok":true}'));
    stubToolThenDone();

    bus.signal(11); // 陈旧信号：execute() 启动时应 clear 掉
    await loop.execute(ctx, l, p);

    // 既无手动（信号被启动清理丢弃），也未达阈值（自动也不触发）
    expect(sessionCompactionOrchestrator.compact).not.toHaveBeenCalled();
    expect(bus.has(11)).toBe(false);
  });

  it('finally 随执行收尾清理信号：本轮未消费的置位不残留给下次执行', async () => {
    const bus = new CompactionSignalBus();
    const loop = loopWithBus(bus);
    const ctx = context();
    const cfg = new CompactionConfig();
    cfg.enabled = false; // 关闭自动：手动块前提 persistenceCallback!=null 不满足时 consume 被短路，信号留到 finally
    ctx.compactionConfig = cfg;
    const l = listener();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    stubActiveContext(5);
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    toolDispatcher.dispatchInvocation.mockImplementation(async () => {
      bus.signal(11);
      return toolResult('{"ok":true}');
    });
    stubToolThenDone();

    // persistence 为 null：手动块 guard 短路，consume 不被调用 → 信号本轮未被消费
    await loop.execute(ctx, l, null);

    expect(sessionCompactionOrchestrator.compact).not.toHaveBeenCalled();
    // finally 必须清掉未消费信号，否则下次执行首个工具轮边界会误压缩
    expect(bus.has(11)).toBe(false);
  });
});
