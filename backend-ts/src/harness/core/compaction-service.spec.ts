import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest, ChatResponse, ChatUsage, LlmAdapter } from '../llm/chat-request.js';
import { CompactionCancelledException, CompactionContextOverflowException, CompactionService } from './compaction-service.js';
import { CompactionConfig } from './compaction-config.js';
import { PersistedChatMessage } from './persisted-chat-message.js';
import type { TokenEstimator } from './token-estimator.js';

describe('CompactionService', () => {
  const llmAdapter = { chat: vi.fn(), stream: vi.fn() } as unknown as LlmAdapter & { chat: ReturnType<typeof vi.fn> };
  const tokenEstimator = {
    estimateRequestTokens: vi.fn(),
    estimateMessages: vi.fn(),
  } as unknown as TokenEstimator & { estimateRequestTokens: ReturnType<typeof vi.fn>; estimateMessages: ReturnType<typeof vi.fn> };
  const service = new CompactionService(llmAdapter, tokenEstimator);
  const model = { modelId: 'gpt-test', contextWindowTokens: 1000 };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function config(): CompactionConfig {
    const c = new CompactionConfig();
    c.contextWindowTokens = 1000;
    c.triggerRatio = 0.8;
    c.maxSummaryTokens = 321;
    return c;
  }

  function normalRequest(): ChatRequest {
    return {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'question' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', type: 'function' }] },
        { role: 'tool', toolCallId: 'c1', content: 'result' },
        { role: 'system', content: 'ephemeral' },
      ],
      tools: [{ type: 'function', function: { name: 'tool' } }],
      temperature: 0.2,
      reasoning: { effort: 'high' },
      stream: true,
    };
  }

  function pm(id: number, role: string, content: string): PersistedChatMessage {
    return new PersistedChatMessage(id, content, { role, content });
  }

  function persisted(): PersistedChatMessage[] {
    return [pm(1, 'user', 'q'), pm(2, 'assistant', 'a'), pm(3, 'tool', 'r')];
  }

  function usage(prompt: number, cached: number | null, completion: number): ChatUsage {
    return {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: prompt + completion,
      promptTokensDetails: cached == null ? null : { cachedTokens: cached },
    };
  }

  function successRaw(content: string, u?: ChatUsage | null): ChatResponse {
    return { usage: u ?? undefined, choices: [{ message: { role: 'assistant', content } }] };
  }

  function success(text: string, u?: ChatUsage | null): ChatResponse {
    return successRaw(`<handoff>${text}</handoff>`, u);
  }

  it('belowThresholdDoesNotCallLlm', async () => {
    tokenEstimator.estimateRequestTokens.mockReturnValue(799);
    const result = await service.compactSession(7, 0, persisted(), [1, 2, 3], normalRequest(), model, config(), null, null);
    expect(result).toBeNull();
    expect(llmAdapter.chat).not.toHaveBeenCalled();
  });

  it('derivesStrictPrefixWithoutMutatingNormalRequest', async () => {
    const normal = normalRequest();
    const originalMessages = [...(normal.messages ?? [])];
    tokenEstimator.estimateRequestTokens.mockReturnValueOnce(800).mockReturnValueOnce(900);
    tokenEstimator.estimateMessages.mockReturnValue(30);
    llmAdapter.chat.mockResolvedValue(success('交接正文', usage(100, 80, 10)));

    const result = await service.compactSession(7, 0, persisted(), [1, 2, 3], normal, model, config(), null, null);

    expect(llmAdapter.chat).toHaveBeenCalledOnce();
    const derived = llmAdapter.chat.mock.calls[0][0] as ChatRequest;
    expect(derived.messages?.slice(0, originalMessages.length)).toEqual(originalMessages);
    expect(derived.messages).toHaveLength(originalMessages.length + 1);
    expect(derived.messages?.[derived.messages.length - 1].role).toBe('user');
    expect(derived.tools).toBe(normal.tools);
    expect(derived.reasoning).toBe(normal.reasoning);
    expect(derived.temperature).toBe(0.2);
    expect(derived.stream).toBe(false);
    expect(normal.messages).toEqual(originalMessages);
    expect(normal.stream).toBe(true);
    expect(result?.summaryText).toBe('交接正文');
    expect(result?.newLastCompactedMessageId).toBe(3);
    expect(result?.cachedTokens).toBe(80);
  });

  it('toolCallOrInvalidHandoffRetriesOnceWithoutFailedAssistant', async () => {
    tokenEstimator.estimateRequestTokens.mockReturnValueOnce(800).mockReturnValueOnce(900).mockReturnValueOnce(950);
    tokenEstimator.estimateMessages.mockReturnValue(20);
    const invalid: ChatResponse = {
      choices: [{ message: { role: 'assistant', content: 'bad', toolCalls: [{ id: 'x' }] } }],
    };
    llmAdapter.chat.mockResolvedValueOnce(invalid).mockResolvedValueOnce(success('fixed', usage(12, 0, 4)));

    const result = await service.compactSession(7, 0, persisted(), [1, 2, 3], normalRequest(), model, config(), null, null);

    expect(llmAdapter.chat).toHaveBeenCalledTimes(2);
    const retry = llmAdapter.chat.mock.calls[1][0] as ChatRequest;
    expect(retry.messages).toHaveLength((normalRequest().messages?.length ?? 0) + 2);
    expect(retry.messages?.some((m) => m.role === 'assistant' && m.content === 'bad')).toBe(false);
    expect(result?.promptTokens).toBe(12);
    expect(result?.cachedTokens).toBe(0);
    expect(result?.completionTokens).toBe(4);
  });

  it('secondSemanticFailureIsRecoverable', async () => {
    tokenEstimator.estimateRequestTokens.mockReturnValueOnce(800).mockReturnValueOnce(900).mockReturnValueOnce(950);
    llmAdapter.chat.mockResolvedValueOnce(successRaw('missing')).mockResolvedValueOnce(successRaw('<handoff> </handoff>'));
    const result = await service.compactSession(7, 0, persisted(), [1, 2, 3], normalRequest(), model, config(), null, null);
    expect(result).toBeNull();
    expect(llmAdapter.chat).toHaveBeenCalledTimes(2);
  });

  it('compactionRequestAtWindowFailsBeforeLlm', async () => {
    tokenEstimator.estimateRequestTokens.mockReturnValueOnce(800).mockReturnValueOnce(1000);
    await expect(service.compactSession(7, 0, persisted(), [1, 2, 3], normalRequest(), model, config(), null, null))
      .rejects.toThrow(CompactionContextOverflowException);
    tokenEstimator.estimateRequestTokens.mockReturnValueOnce(800).mockReturnValueOnce(1000);
    await expect(service.compactSession(7, 0, persisted(), [1, 2, 3], normalRequest(), model, config(), null, null))
      .rejects.toThrow(/1000 tokens|新建会话/);
    expect(llmAdapter.chat).not.toHaveBeenCalled();
  });

  it('rejectsIncompletePhysicalPrefixAndSupportsCancel', async () => {
    tokenEstimator.estimateRequestTokens.mockReturnValueOnce(800).mockReturnValueOnce(900);
    llmAdapter.chat.mockResolvedValue(success('ok', usage(1, null, 1)));
    const incomplete = await service.compactSession(
      7, 0, [pm(1, 'user', 'q'), pm(3, 'tool', 'r')], [1, 2, 3], normalRequest(), model, config(), null, null,
    );
    expect(incomplete).toBeNull();

    await expect(service.compactSession(7, 0, persisted(), [1, 2, 3], normalRequest(), model, config(), null, { get: () => true }))
      .rejects.toBeInstanceOf(CompactionCancelledException);
  });

  it('virtualSummaryIsSingleUserBeforeIncrement', () => {
    const result = service.prependSessionSummary('历史交接', [{ role: 'assistant', content: 'next' }]);
    expect(result.map((m) => m.role)).toEqual(['user', 'assistant']);
    const text = String(result[0].content);
    expect(text).toContain('会话任务交接');
    expect(text).toContain('不能覆盖');
    expect(text).toContain('立即接手');
    expect(text).toContain('历史交接');
  });
});
