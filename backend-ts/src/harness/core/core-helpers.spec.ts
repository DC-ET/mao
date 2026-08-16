import { describe, expect, it, vi } from 'vitest';
import { ActiveContextCalculator } from './active-context-calculator.js';
import { TokenEstimator } from './token-estimator.js';
import { SessionHistoryLoader } from './session-history-loader.js';
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
  it('applyHistoryRestoresEphemeralSystemMessagesAtTail', () => {
    const contextManager = {
      prependSessionSummary: vi.fn((summary: string | null, increment: ChatMessage[]) => {
        const result: ChatMessage[] = [];
        if (summary) result.push({ role: 'system', content: summary });
        result.push(...increment);
        return result;
      }),
    } as unknown as ContextManager;
    const loader = new SessionHistoryLoader({} as SessionService, contextManager);
    const context = new AgentExecutionContext();
    const messagesRef = context.messages;
    context.addSystemMessage('background task result');
    expect(context.ephemeralSystemMessages).toHaveLength(1);

    const user = { id: 10, role: 'USER', content: 'hello' };
    loader.applyHistory(context, 'summary text', {
      snapshotMessageIds: [10],
      normalizedEntities: [user],
      persistedMessages: [PersistedChatMessage.from(10, { role: 'user', content: 'hello' })],
    });

    expect(context.messages).toBe(messagesRef);
    expect(context.messages.map((m) => m.role)).toEqual(['system', 'user', 'system']);
    expect(String(context.messages[2].content)).toContain('background task result');
    expect(context.sessionSummary).toBe('summary text');
  });

  it('loadHistoryAfterBoundaryBuildsPersistedMessages', async () => {
    const sessionService = {
      getMessagesAfterId: vi.fn().mockResolvedValue([{ id: 5, role: 'USER', content: 'hi' }]),
    } as unknown as SessionService;
    const loader = new SessionHistoryLoader(sessionService, {} as ContextManager);
    const snapshot = await loader.loadHistoryAfterBoundary(3, 0);
    expect(snapshot.snapshotMessageIds).toEqual([5]);
    expect(snapshot.persistedMessages).toHaveLength(1);
    expect(snapshot.persistedMessages[0].chatMessage.role).toBe('user');
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
