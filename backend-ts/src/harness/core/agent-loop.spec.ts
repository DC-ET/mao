import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentLoop } from './agent-loop.js';
import { AgentExecutionContext } from './agent-execution-context.js';
import { CompactionConfig } from './compaction-config.js';
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
  const toolDispatcher = { dispatch: vi.fn() } as unknown as ToolDispatcher & { dispatch: ReturnType<typeof vi.fn> };
  const backgroundTaskManager = {
    consumeCompletedResults: vi.fn(),
  } as unknown as BackgroundTaskManager & { consumeCompletedResults: ReturnType<typeof vi.fn> };
  const shellSessionManager = {
    closeByConversation: vi.fn(),
  } as unknown as ShellSessionManager & { closeByConversation: ReturnType<typeof vi.fn> };
  const activityHeartbeat = { touch: vi.fn(), clear: vi.fn() };
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

    expect(ctx.messages.map((m) => m.role)).toEqual(expect.arrayContaining(['system', 'assistant']));
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
    toolDispatcher.dispatch.mockResolvedValue('{"ok":true,"_private_diff":{"diff_mode":"PATCH"}}');
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
    expect(l.onToolCallResult).toHaveBeenCalledWith('call-1', expect.any(String));
    expect(ctx.messages.map((m) => m.role)).toEqual(expect.arrayContaining(['assistant', 'tool', 'assistant']));
  });

  it('merges repeated tool-call chunks that carry the same id instead of starting each chunk', async () => {
    const ctx = context();
    ctx.tools = [namedTool('write_file')];
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    stubActiveContext(5);
    toolDispatcher.dispatch.mockResolvedValue('{"ok":true}');
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
    expect(toolDispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(toolDispatcher.dispatch).toHaveBeenCalledWith(
      'write_file',
      '{"path":"a.html","content":"x"}',
      'CLOUD',
      11,
      7,
      '/repo',
      'READ_ONLY',
      undefined,
      ctx.tools,
    );
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
    toolDispatcher.dispatch.mockImplementation(async (name: string) => {
      await new Promise((r) => setTimeout(r, name === 'read_file' ? 25 : 5));
      seen.push(`${name}:${ToolCallContext.getToolCallId() ?? ''}`);
      return '{"ok":true}';
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
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    stubActiveContext(5);
    let dispatchCount = 0;
    toolDispatcher.dispatch.mockImplementation(async () => {
      dispatchCount++;
      if (dispatchCount === 2) cancelFlag.set(true);
      return dispatchCount === 1 ? '{"total_lines":2}' : '{"exit_code":0}';
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
  });

  it('keeps interleaved tool-call argument chunks bound to their index', async () => {
    const ctx = context();
    ctx.tools = [namedTool('shell'), namedTool('read_file')];
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    stubActiveContext(5);
    toolDispatcher.dispatch.mockResolvedValue('{"ok":true}');
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
    expect(toolDispatcher.dispatch).toHaveBeenCalledWith(
      'shell', '{"command":"pwd"}', 'CLOUD', 11, 7, '/repo', 'READ_ONLY', undefined, ctx.tools,
    );
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
    toolDispatcher.dispatch.mockResolvedValue(imageResult);
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
  });

  it('midLoopCompactionTriggersWhenRequestNearWindow', async () => {
    const ctx = contextWithMidLoopConfig(100, 0.5);
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    stubActiveContext(80);
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    toolDispatcher.dispatch.mockResolvedValue('{"ok":true}');
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
    toolDispatcher.dispatch.mockResolvedValue('{"ok":true}');
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
    toolDispatcher.dispatch.mockResolvedValue('{"ok":true}');
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
    toolDispatcher.dispatch.mockResolvedValue('{"ok":true}');
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
    // 第 2 次调用的消息中应包含系统提示注入
    expect(promptEngine.buildRequest).toHaveBeenCalled();
    const secondCallMessages = promptEngine.buildRequest.mock.calls[0][0]?.messages;
    const systemMsg = secondCallMessages?.find((m: { role: string }) => m.role === 'system');
    expect(systemMsg?.content).toContain('上一轮模型未产生有效输出');
  });

  it('throwsFriendlyErrorAfterThreeConsecutiveEmptyResponses', async () => {
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
    await expect(agentLoop.execute(ctx, l, p)).rejects.toThrow('LLM 连续返回空响应，自动重试已耗尽，请重试');
    expect(call).toBe(3);
  });
});
