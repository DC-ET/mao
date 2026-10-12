import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentLoop } from './agent-loop.js';
import { AgentExecutionContext } from './agent-execution-context.js';
import { CompactionConfig } from './compaction-config.js';
import { CompactionSignalBus } from './compaction-signal-bus.js';
import { CompactionCancelledException } from './compaction-service.js';
import type { AgentEventListener } from './agent-event-listener.js';
import type { PromptEngine } from './prompt-engine.js';
import type { ContextManager } from './context-manager.js';
import type { BackgroundTaskManager } from './background-task-manager.js';
import type { SessionCompactionOrchestrator } from './session-compaction-orchestrator.js';
import type { ActiveContextCalculator } from './active-context-calculator.js';
import type { ToolDispatcher } from '../tool/tool-dispatcher.js';
import type { LlmAdapter, StreamCallback, StreamChunk } from '../llm/chat-request.js';
import type { ShellSessionManager } from '../shell/shell-session-manager.js';
import type { SessionService } from '../deps.js';
import type { McpClientManager } from '../mcp/mcp-client-manager.js';
import type { Tool } from '../tool/tool.js';

/**
 * 逻辑 BUG 验证（review 探针，非产品用例）：
 * 纯文本轮正常收尾（消息已落库、用量已 addUsage）后，手动压缩被取消时
 * abortRound() 把本轮已完成的用量一并回滚，与会话用量统计（DB tokenCount）不一致。
 * 预期：取消的是压缩这个附带动作，不应丢弃本轮回答已产生的用量。
 */

describe('review: 手动压缩被取消不得丢弃已完成轮次的用量', () => {
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
    updateContextTokens: vi.fn(async () => undefined),
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
  const compactionSignalBus = new CompactionSignalBus();
  const agentLoop = new AgentLoop(
    llmAdapter, promptEngine, contextManager, toolDispatcher, backgroundTaskManager,
    shellSessionManager, activityHeartbeat, sessionService, sessionCompactionOrchestrator,
    activeContextCalculator, mcpClientManager, null, compactionSignalBus,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    compactionSignalBus.clear(11);
  });

  function stubActiveContext(): void {
    activeContextCalculator.activeFromMessageSuffix.mockReturnValue(42);
    sessionService.loadContextAnchor.mockResolvedValue({ lastPromptTokens: 0, contextAnchorMsgId: 0 });
    sessionService.getMaxMessageId.mockResolvedValue(1);
    sessionService.getSession.mockResolvedValue({ phase: 'RUNNING' });
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
    ctx.compactionConfig = new CompactionConfig();
    return ctx;
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

  function contentChunk(content: string): StreamChunk {
    return { choices: [{ delta: { content } }] };
  }

  it('取消手动压缩后，本轮已落库的 assistant 消息用量必须保留', async () => {
    const ctx = context();
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    stubActiveContext();
    sessionCompactionOrchestrator.compact.mockRejectedValue(new CompactionCancelledException());
    llmAdapter.stream.mockImplementation(async (_r: unknown, _c: unknown, callback: StreamCallback) => {
      // 用户在 LLM 输出期间点击「压缩上下文」：信号必须在本轮执行内置位
      // （execute 启动时会 clear 陈旧信号，预先置位会被清掉）
      compactionSignalBus.signal(11);
      callback.onChunk(contentChunk('hello'));
      callback.onComplete({ promptTokens: 1200, completionTokens: 80, totalTokens: 1280 });
    });

    await agentLoop.execute(ctx, l, p);

    // 本轮已正常收尾并落库
    expect(p.onSaveAssistantMessage).toHaveBeenCalledWith('hello', null, [], expect.objectContaining({ totalTokens: 1280 }));
    // 取消压缩不应回滚已完成的用量：当前实现 ctx.totalUsage 被重置为 0 → 断言失败
    expect(ctx.totalUsage.totalTokens).toBe(1280);
    expect(l.onMessageEnd).toHaveBeenCalledWith(expect.objectContaining({ totalTokens: 1280 }));
  });

  it('对照组：无手动压缩信号时用量正常累计（现有行为不回退）', async () => {
    const ctx = context();
    const l = listener();
    const p = persistence();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    stubActiveContext();
    llmAdapter.stream.mockImplementation(async (_r: unknown, _c: unknown, callback: StreamCallback) => {
      callback.onChunk(contentChunk('hello'));
      callback.onComplete({ promptTokens: 1200, completionTokens: 80, totalTokens: 1280 });
    });

    await agentLoop.execute(ctx, l, p);

    expect(ctx.totalUsage.totalTokens).toBe(1280);
    expect(l.onMessageEnd).toHaveBeenCalledWith(expect.objectContaining({ totalTokens: 1280 }));
  });
});
