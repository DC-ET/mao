import { describe, expect, it, vi } from 'vitest';
import { ActiveContextCalculator } from './active-context-calculator.js';
import { TokenEstimator } from './token-estimator.js';
import { SessionHistoryLoader } from './session-history-loader.js';
import { CompactionArchiveService } from './compaction-archive.service.js';
import { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';
import { ToolMediaInjector, SYNTHETIC_ATTACHMENT_PROMPT } from './tool-media-injector.js';
import { AgentExecutionContext } from './agent-execution-context.js';
import { PersistedChatMessage } from './persisted-chat-message.js';
import type { ContextManager } from './context-manager.js';
import type { SessionService } from '../deps.js';
import type { ChatMessage } from '../llm/chat-request.js';

describe('ActiveContextCalculator', () => {
  const calculator = new ActiveContextCalculator(new TokenEstimator());

  it('usesAnchorPlusDeltaWhenValid', () => {
    const delta = { role: 'assistant', content: 'abcd' };
    const active = calculator.active(100, 10, [delta], null);
    expect(active).toBe(100 + calculator.estimateMessages([delta]));
  });

  it('fallsBackToFullRequestWithoutAnchor', () => {
    const msg = { role: 'user', content: 'hello' };
    const request = { messages: [msg] };
    const active = calculator.active(0, 0, null, request);
    expect(active).toBe(calculator.estimateRequestTokens(request));
  });

  it('activeFromMessageSuffixUsesCoveredCount', () => {
    const a = { role: 'user', content: 'aa' };
    const b = { role: 'assistant', content: 'bbbb' };
    const active = calculator.activeFromMessageSuffix(50, 9, [a, b], 1, null);
    expect(active).toBe(50 + calculator.estimateMessages([b]));
  });

  it('activeFromMessageSuffixIncludesMessagesAddedAfterCoveredIndex', () => {
    const user = { role: 'user', content: 'question' };
    const assistant = { role: 'assistant', content: 'calling tool' };
    const tool = { role: 'tool', toolCallId: 'c1', content: 'tool result payload' };
    const active = calculator.activeFromMessageSuffix(1000, 42, [user, assistant, tool], 1, null);
    expect(active).toBe(1000 + calculator.estimateMessages([assistant, tool]));
    expect(active).toBeGreaterThan(1000);
  });

  it('activeFromMessageSuffixFallsBackWhenCoveredUnset', () => {
    const msg = { role: 'user', content: 'x' };
    const request = { messages: [msg] };
    const active = calculator.activeFromMessageSuffix(500, 9, [msg], -1, request);
    expect(active).toBe(calculator.estimateRequestTokens(request));
    expect(active).not.toBe(500);
  });
});

describe('SessionHistoryLoader', () => {
  const archiveService = new CompactionArchiveService(
    RuntimeDataResolver.forTest('/nonexistent-mao-test-root', '/nonexistent-mao-test-home'));

  it('applyHistoryRestoresEphemeralSystemMessagesAtTail', async () => {
    const contextManager = {
      prependSessionSummary: vi.fn((summary: string | null, increment: ChatMessage[]) => {
        const result: ChatMessage[] = [];
        if (summary) result.push({ role: 'system', content: summary });
        result.push(...increment);
        return result;
      }),
    } as unknown as ContextManager;
    const loader = new SessionHistoryLoader({} as SessionService, contextManager, archiveService);
    const context = new AgentExecutionContext();
    const messagesRef = context.messages;
    context.addSystemMessage('background task result');
    expect(context.ephemeralSystemMessages).toHaveLength(1);

    const user = { id: 10, role: 'USER', content: 'hello' };
    await loader.applyHistory(context, 'summary text', {
      snapshotMessageIds: [10],
      normalizedEntities: [user],
      persistedMessages: [PersistedChatMessage.from(10, { role: 'user', content: 'hello' })],
    });

    expect(context.messages).toBe(messagesRef);
    // addSystemMessage 现在注入 user role（外裹 <system-notice> 标签），
    // 避免许多模型不支持中途 system message 的问题
    expect(context.messages.map((m) => m.role)).toEqual(['system', 'user', 'user']);
    expect(String(context.messages[2].content)).toContain('background task result');
    expect(String(context.messages[2].content)).toContain('<system-notice>');
    expect(context.sessionSummary).toBe('summary text');
  });

  it('applyHistoryReinjectsLastRealUserWhenIncrementalHasNone', async () => {
    const contextManager = {
      prependSessionSummary: vi.fn((
        summary: string | null,
        increment: ChatMessage[],
        _hint?: string | null,
        latestUser?: ChatMessage | null,
      ) => {
        const result: ChatMessage[] = [];
        if (summary) result.push({ role: 'user', content: `## 会话任务交接\n\n${summary}` });
        result.push(...increment);
        if (latestUser) result.push(latestUser);
        return result;
      }),
    } as unknown as ContextManager;
    const sessionService = {
      getLastUserMessage: vi.fn().mockResolvedValue({ id: 8, role: 'USER', content: '把前后端都发布到测试和预发环境' }),
    } as unknown as SessionService;
    const loader = new SessionHistoryLoader(sessionService, contextManager, archiveService);
    const context = new AgentExecutionContext();
    context.sessionId = 42;
    context.addSystemMessage('ephemeral');

    await loader.applyHistory(context, '压缩摘要', {
      snapshotMessageIds: [12],
      normalizedEntities: [{ id: 12, role: 'ASSISTANT', content: 'next' }],
      persistedMessages: [PersistedChatMessage.from(12, { role: 'assistant', content: 'next' })],
    });

    expect(sessionService.getLastUserMessage).toHaveBeenCalledWith(42);
    expect(context.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user']);
    expect(String(context.messages[0].content)).toContain('会话任务交接');
    expect(context.messages[2].content).toBe('把前后端都发布到测试和预发环境');
    expect(String(context.messages[3].content)).toContain('<system-notice>');
  });

  it('applyHistoryDoesNotFetchLastUserWhenIncrementalAlreadyHasOne', async () => {
    const contextManager = {
      prependSessionSummary: vi.fn((summary: string | null, increment: ChatMessage[]) => {
        const result: ChatMessage[] = [];
        if (summary) result.push({ role: 'user', content: `## 会话任务交接\n\n${summary}` });
        result.push(...increment);
        return result;
      }),
    } as unknown as ContextManager;
    const sessionService = {
      getLastUserMessage: vi.fn(),
    } as unknown as SessionService;
    const loader = new SessionHistoryLoader(sessionService, contextManager, archiveService);
    const context = new AgentExecutionContext();
    context.sessionId = 42;

    await loader.applyHistory(context, '压缩摘要', {
      snapshotMessageIds: [9],
      normalizedEntities: [{ id: 9, role: 'USER', content: '把前后端都发布到测试和预发环境' }],
      persistedMessages: [PersistedChatMessage.from(9, { role: 'user', content: '把前后端都发布到测试和预发环境' })],
    });

    expect(sessionService.getLastUserMessage).not.toHaveBeenCalled();
    expect(context.messages.map((m) => m.role)).toEqual(['user', 'user']);
    expect(context.messages[1].content).toBe('把前后端都发布到测试和预发环境');
  });

  it('loadHistoryAfterBoundaryBuildsPersistedMessages', async () => {
    const sessionService = {
      getMessagesAfterId: vi.fn().mockResolvedValue([{ id: 5, role: 'USER', content: 'hi' }]),
    } as unknown as SessionService;
    const loader = new SessionHistoryLoader(sessionService, {} as ContextManager, archiveService);
    const snapshot = await loader.loadHistoryAfterBoundary(3, 0);
    expect(snapshot.snapshotMessageIds).toEqual([5]);
    expect(snapshot.persistedMessages).toHaveLength(1);
    expect(snapshot.persistedMessages[0].chatMessage.role).toBe('user');
  });

  it('loadHistoryRestoresReasoningContentForAssistantMessages', async () => {
    const sessionService = {
      getMessagesAfterId: vi.fn().mockResolvedValue([
        { id: 7, role: 'ASSISTANT', content: '答案', thinkingContent: '思考过程' },
      ]),
    } as unknown as SessionService;
    const loader = new SessionHistoryLoader(sessionService, {} as ContextManager, archiveService);
    const snapshot = await loader.loadHistoryAfterBoundary(3, 0);
    expect(snapshot.persistedMessages[0].chatMessage.reasoningContent).toBe('思考过程');
  });
});

describe('ToolMediaInjector', () => {
  const injector = new ToolMediaInjector();

  it('injectsSyntheticUserMessageAfterToolWithImageAttachment', () => {
    const messages = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1' }] },
      { role: 'tool', toolCallId: 'call-1', content: '{"content":"ok"}' },
    ];
    const attachments = new Map([['call-1', { mime: 'image/png', path: 'a.png', dataUri: 'data:image/png;base64,abc' }]]);
    const injected = injector.inject(messages, attachments, { supportsVision: true });
    expect(injected).toHaveLength(3);
    expect(injected![2].role).toBe('user');
    expect(Array.isArray(injected![2].content)).toBe(true);
    const parts = injected![2].content as Array<{ type?: string; text?: string; imageUrl?: { url: string } }>;
    expect(parts).toHaveLength(2);
    expect(parts[0].text).toBe(SYNTHETIC_ATTACHMENT_PROMPT);
    expect(parts[1].type).toBe('image_url');
    expect(parts[1].imageUrl?.url).toBe('data:image/png;base64,abc');
  });

  it('skipsInjectionWhenVisionUnsupported', () => {
    const messages = [{ role: 'tool', toolCallId: 'call-1', content: '{"content":"ok"}' }];
    const attachments = { 'call-1': { mime: 'image/png', path: 'a.png', dataUri: 'data:image/png;base64,abc' } };
    const injected = injector.inject(messages, attachments, { supportsVision: false });
    expect(injected).toHaveLength(1);
  });

  it('leavesNonToolMessagesUntouched', () => {
    const messages = [{ role: 'user', content: 'hello' }];
    const injected = injector.inject(messages, new Map(), { supportsVision: true });
    expect(injected).toHaveLength(1);
    expect(injected![0].content).toBe('hello');
  });
});
