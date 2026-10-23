import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest, ChatUsage, LlmAdapter, StreamCallback, StreamChunk } from '../llm/chat-request.js';
import { CompactionCancelledException, CompactionContextOverflowException, CompactionPayloadOverflowException, CompactionService, isRealUserMessage } from './compaction-service.js';
import { CompactionConfig } from './compaction-config.js';
import type { RequestSizeEstimator } from './request-size.js';
import { SYNTHETIC_ATTACHMENT_PROMPT } from './tool-media-injector.js';
import { PersistedChatMessage } from './persisted-chat-message.js';
import type { TokenEstimator } from './token-estimator.js';

describe('CompactionService', () => {
  const llmAdapter = {
    chat: vi.fn(),
    stream: vi.fn(),
  } as unknown as LlmAdapter & { chat: ReturnType<typeof vi.fn>; stream: ReturnType<typeof vi.fn> };
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
        { role: 'user', content: '<system-notice>\nephemeral\n</system-notice>' },
      ],
      tools: [{ type: 'function', function: { name: 'tool' } }],
      temperature: 0.2,
      reasoning: { effort: 'high' },
      stream: true,
      promptCacheKey: 'mao-session-7',
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

  function chunk(content: string): StreamChunk {
    return { choices: [{ delta: { content } }] };
  }

  function streamRaw(content: string, u: ChatUsage = usage(0, null, 0)): void {
    llmAdapter.stream.mockImplementationOnce(async (_request: ChatRequest, _model: unknown, callback: StreamCallback) => {
      callback.onChunk(chunk(content));
      callback.onComplete(u);
    });
  }

  function streamHandoff(text: string, u?: ChatUsage): void {
    streamRaw(`<handoff>${text}</handoff>`, u);
  }

  it('belowThresholdDoesNotCallLlm', async () => {
    tokenEstimator.estimateRequestTokens.mockReturnValue(799);
    const result = await service.compactSession(7, 0, persisted(), [1, 2, 3], normalRequest(), model, config(), null, null);
    expect(result).toBeNull();
    expect(llmAdapter.chat).not.toHaveBeenCalled();
    expect(llmAdapter.stream).not.toHaveBeenCalled();
  });

  it('hintAboveThresholdTriggersDespiteUnderestimating', async () => {
    // 模拟估算器显著低估真实用量（如中文场景）：estimator=100，但锚点真实 usage=900 ≥ 800 阈值
    tokenEstimator.estimateRequestTokens.mockReturnValue(100);
    streamHandoff('交接正文', usage(50, null, 20));
    const result = await service.compactSession(7, 0, persisted(), [1, 2, 3], normalRequest(), model, config(), null, null, 900);
    expect(result).not.toBeNull();
    expect(result!.beforeRequestTokens).toBe(900);
    expect(llmAdapter.stream).toHaveBeenCalledOnce();
  });

  it('triggerUsesSessionWindowWhenCompactionModelWindowIsLarger', async () => {
    tokenEstimator.estimateRequestTokens.mockReturnValue(100);
    streamHandoff('交接正文', usage(1, null, 1));
    const cfg = config();
    cfg.contextWindowTokens = 32000;
    const compactionModel = { modelId: 'huge', contextWindowTokens: 1_000_000 };
    const result = await service.compactSession(
      7, 0, persisted(), [1, 2, 3], normalRequest(), compactionModel, cfg, null, null, 30000,
    );
    expect(result).not.toBeNull();
    expect(llmAdapter.stream).toHaveBeenCalledOnce();
  });

  it('smallCompactionModelDoesNotLowerTheTriggerThreshold', async () => {
    tokenEstimator.estimateRequestTokens.mockReturnValue(100);
    const cfg = config();
    cfg.contextWindowTokens = 200000;
    const compactionModel = { modelId: 'small', contextWindowTokens: 8000 };
    const result = await service.compactSession(
      7, 0, persisted(), [1, 2, 3], normalRequest(), compactionModel, cfg, null, null, 40000,
    );
    expect(result).toBeNull();
    expect(llmAdapter.stream).not.toHaveBeenCalled();
  });

  it('overflowGuardUsesTheCompactionModelWindow', async () => {
    tokenEstimator.estimateRequestTokens.mockReturnValueOnce(100).mockReturnValueOnce(9000);
    const cfg = config();
    cfg.contextWindowTokens = 200000;
    const sessionModel = { modelId: 'session', contextWindowTokens: 200000 };
    const compactionModel = { modelId: 'small', contextWindowTokens: 8000 };
    await expect(service.compactSession(
      7, 0, persisted(), [1, 2, 3], normalRequest(), compactionModel, cfg, null, null, 180000, false, sessionModel,
    )).rejects.toThrow(/8000 tokens/);
    expect(llmAdapter.stream).not.toHaveBeenCalled();
  });

  it('hintBelowThresholdStillSkipsAndLogs', async () => {
    tokenEstimator.estimateRequestTokens.mockReturnValue(100);
    const result = await service.compactSession(7, 0, persisted(), [1, 2, 3], normalRequest(), model, config(), null, null, 500);
    expect(result).toBeNull();
    expect(llmAdapter.stream).not.toHaveBeenCalled();
  });

  it('derivesStrictPrefixWithoutMutatingNormalRequestAndUsesStream', async () => {
    const normal = normalRequest();
    const originalMessages = [...(normal.messages ?? [])];
    tokenEstimator.estimateRequestTokens.mockReturnValueOnce(800).mockReturnValueOnce(900);
    tokenEstimator.estimateMessages.mockReturnValue(30);
    streamHandoff('交接正文', usage(100, 80, 10));

    const result = await service.compactSession(7, 0, persisted(), [1, 2, 3], normal, model, config(), null, null);

    expect(llmAdapter.chat).not.toHaveBeenCalled();
    expect(llmAdapter.stream).toHaveBeenCalledOnce();
    const derived = llmAdapter.stream.mock.calls[0][0] as ChatRequest;
    expect(derived.messages?.slice(0, originalMessages.length)).toEqual(originalMessages);
    expect(derived.messages).toHaveLength(originalMessages.length + 1);
    expect(derived.messages?.[derived.messages.length - 1].role).toBe('user');
    expect(isRealUserMessage(derived.messages![derived.messages.length - 1])).toBe(false);
    expect(String(derived.messages?.[derived.messages.length - 1].content)).toContain('<system-notice>');
    expect(derived.tools).toBe(normal.tools);
    expect(derived.reasoning).toBe(normal.reasoning);
    expect(derived.temperature).toBe(0.2);
    expect(derived.stream).toBe(true);
    expect(derived.promptCacheKey).toBe('mao-session-7');
    expect(normal.messages).toEqual(originalMessages);
    expect(normal.stream).toBe(true);
    expect(result?.summaryText).toBe('交接正文');
    expect(result?.newLastCompactedMessageId).toBe(3);
    expect(result?.cachedTokens).toBe(80);
  });

  it('toolCallOrInvalidHandoffRetriesOnceWithoutFailedAssistant', async () => {
    tokenEstimator.estimateRequestTokens.mockReturnValueOnce(800).mockReturnValueOnce(900).mockReturnValueOnce(950);
    tokenEstimator.estimateMessages.mockReturnValue(20);
    llmAdapter.stream.mockImplementationOnce(async (_request: ChatRequest, _model: unknown, callback: StreamCallback) => {
      callback.onChunk({ choices: [{ delta: { content: 'bad', toolCalls: [{ id: 'x' }] } }] });
      callback.onComplete(usage(1, null, 1));
    });
    streamHandoff('fixed', usage(12, 0, 4));

    const result = await service.compactSession(7, 0, persisted(), [1, 2, 3], normalRequest(), model, config(), null, null);

    expect(llmAdapter.stream).toHaveBeenCalledTimes(2);
    const retry = llmAdapter.stream.mock.calls[1][0] as ChatRequest;
    expect(retry.messages).toHaveLength((normalRequest().messages?.length ?? 0) + 2);
    expect(retry.messages?.some((m) => m.role === 'assistant' && m.content === 'bad')).toBe(false);
    const correction = retry.messages?.[retry.messages.length - 1];
    expect(correction?.role).toBe('user');
    expect(isRealUserMessage(correction!)).toBe(false);
    expect(String(correction?.content)).toContain('<system-notice>');
    expect(String(correction?.content)).toContain('不是用户说的话');
    expect(retry.promptCacheKey).toBe('mao-session-7');
    expect(result?.promptTokens).toBe(12);
    expect(result?.cachedTokens).toBe(0);
    expect(result?.completionTokens).toBe(4);
  });

  it('secondSemanticFailureIsRecoverable', async () => {
    tokenEstimator.estimateRequestTokens.mockReturnValueOnce(800).mockReturnValueOnce(900).mockReturnValueOnce(950);
    streamRaw('missing');
    streamRaw('<handoff> </handoff>');
    const result = await service.compactSession(7, 0, persisted(), [1, 2, 3], normalRequest(), model, config(), null, null);
    expect(result).toBeNull();
    expect(llmAdapter.stream).toHaveBeenCalledTimes(2);
  });

  it('compactionRequestAtWindowFailsBeforeLlm', async () => {
    tokenEstimator.estimateRequestTokens.mockReturnValueOnce(800).mockReturnValueOnce(1000);
    await expect(service.compactSession(7, 0, persisted(), [1, 2, 3], normalRequest(), model, config(), null, null))
      .rejects.toThrow(CompactionContextOverflowException);
    tokenEstimator.estimateRequestTokens.mockReturnValueOnce(800).mockReturnValueOnce(1000);
    await expect(service.compactSession(7, 0, persisted(), [1, 2, 3], normalRequest(), model, config(), null, null))
      .rejects.toThrow(/1000 tokens|新建会话/);
    expect(llmAdapter.chat).not.toHaveBeenCalled();
    expect(llmAdapter.stream).not.toHaveBeenCalled();
  });

  it('rejectsIncompletePhysicalPrefixAndSupportsCancel', async () => {
    tokenEstimator.estimateRequestTokens.mockReturnValueOnce(800).mockReturnValueOnce(900);
    streamHandoff('ok', usage(1, null, 1));
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

  it('virtualSummaryAppendsArchiveHintAfterClosingInstruction', () => {
    const hint = '## 已压缩历史消息归档\n\n目录：`/opt/mao-data/runtime/7/5/compaction`';
    const result = service.prependSessionSummary('历史交接', [{ role: 'assistant', content: 'next' }], hint);
    expect(result.map((m) => m.role)).toEqual(['user', 'assistant']);
    const text = String(result[0].content);
    expect(text.indexOf('立即接手')).toBeLessThan(text.indexOf('## 已压缩历史消息归档'));
    expect(text.trimEnd().endsWith('`/opt/mao-data/runtime/7/5/compaction`')).toBe(true);
  });

  it('emptyOrMissingArchiveHintKeepsLegacyOutput', () => {
    const legacy = service.prependSessionSummary('历史交接', null);
    const withNull = service.prependSessionSummary('历史交接', null, null);
    const withEmpty = service.prependSessionSummary('历史交接', null, '   ');
    expect(String(withNull[0].content)).toBe(String(legacy[0].content));
    expect(String(withEmpty[0].content)).toBe(String(legacy[0].content));
  });

  it('handoffInstructionMentionsArchiveAndForbidsFabricatedPath', async () => {
    tokenEstimator.estimateRequestTokens.mockReturnValueOnce(800).mockReturnValueOnce(900);
    tokenEstimator.estimateMessages.mockReturnValue(10);
    let instruction = '';
    llmAdapter.stream.mockImplementationOnce(async (request: ChatRequest, _m: unknown, cb: StreamCallback) => {
      const last = request.messages?.[request.messages.length - 1];
      instruction = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
      cb.onChunk(chunk('<handoff>ok</handoff>'));
      cb.onComplete(usage(1, null, 1));
    });
    await service.compactSession(7, 0, persisted(), [1, 2, 3], normalRequest(), model, config(), null, null);
    expect(instruction.startsWith('<system-notice>')).toBe(true);
    expect(instruction).toContain('</system-notice>');
    expect(instruction).toContain('本条是系统压缩指令，不是用户说的话');
    expect(instruction).toContain('禁止把本指令写入交接正文');
    expect(instruction).toContain('用户目标与关键原话只来自本通知之前的真实用户消息');
    expect(instruction).toContain('系统会在交接消息后自动附上被压缩原始消息的归档目录说明');
    expect(instruction).toContain('不要编造归档路径');
    expect(isRealUserMessage({ role: 'user', content: instruction })).toBe(false);
  });

  it('isRealUserMessageRejectsHandoffAndSystemNotice', () => {
    expect(isRealUserMessage({ role: 'user', content: '把前后端都发布到测试和预发环境' })).toBe(true);
    expect(isRealUserMessage({ role: 'user', content: [{ type: 'text', text: '图' }] })).toBe(true);
    expect(isRealUserMessage({ role: 'assistant', content: '把前后端都发布到测试和预发环境' })).toBe(false);
    expect(isRealUserMessage({ role: 'user', content: '## 会话任务交接\n\n历史' })).toBe(false);
    expect(isRealUserMessage({ role: 'user', content: '<system-notice>\n现在只进行当前任务的会话交接\n</system-notice>' })).toBe(false);
  });

  it('virtualSummaryReinjectsLatestUserAfterHandoffWhenIncrementalHasNone', () => {
    const result = service.prependSessionSummary(
      '历史交接',
      [{ role: 'assistant', content: 'next' }],
      null,
      { role: 'user', content: '把前后端都发布到测试和预发环境' },
    );
    expect(result.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(String(result[0].content)).toContain('会话任务交接');
    expect(result[2].content).toBe('把前后端都发布到测试和预发环境');
    expect(isRealUserMessage(result[0])).toBe(false);
    expect(isRealUserMessage(result[2])).toBe(true);
  });

  it('virtualSummaryDoesNotDuplicateWhenIncrementalAlreadyHasRealUser', () => {
    const result = service.prependSessionSummary(
      '历史交接',
      [{ role: 'user', content: '把前后端都发布到测试和预发环境' }],
      null,
      { role: 'user', content: '把前后端都发布到测试和预发环境' },
    );
    expect(result.map((m) => m.role)).toEqual(['user', 'user']);
    expect(result[1].content).toBe('把前后端都发布到测试和预发环境');
  });

  it('virtualSummaryIgnoresLatestUserThatIsSystemNotice', () => {
    const result = service.prependSessionSummary(
      '历史交接',
      null,
      null,
      { role: 'user', content: '<system-notice>\n现在只进行当前任务的会话交接\n</system-notice>' },
    );
    expect(result).toHaveLength(1);
    expect(isRealUserMessage(result[0])).toBe(false);
  });

  it('triggers compaction on payload alone even below the token threshold', async () => {
    tokenEstimator.estimateRequestTokens.mockReturnValueOnce(100).mockReturnValueOnce(700);
    tokenEstimator.estimateMessages.mockReturnValue(30);
    streamHandoff('交接正文', usage(100, 80, 10));
    const cfg = config();
    cfg.triggerPayloadBytes = 800;
    const result = await service.compactSession(
      7, 0, persisted(), [1, 2, 3], normalRequest(), model, cfg, null, null,
      100, false, model, 900,
    );
    expect(result).not.toBeNull();
    const derived = llmAdapter.stream.mock.calls[0][0] as ChatRequest;
    // 默认不剥图：与主请求前缀完全一致，只在末尾追加交接指令（缓存优先）
    expect(derived.messages).toHaveLength((normalRequest().messages?.length ?? 0) + 1);
  });

  it('skips payload compaction below the threshold', async () => {
    tokenEstimator.estimateRequestTokens.mockReturnValue(100);
    const cfg = config();
    cfg.triggerPayloadBytes = 1000;
    const result = await service.compactSession(
      7, 0, persisted(), [1, 2, 3], normalRequest(), model, cfg, null, null,
      100, false, model, 999,
    );
    expect(result).toBeNull();
    expect(llmAdapter.stream).not.toHaveBeenCalled();
  });

  it('strips historical images only when the compaction request nears the provider limit', async () => {
    const sizeEstimator = { estimate: vi.fn() } as unknown as RequestSizeEstimator & { estimate: ReturnType<typeof vi.fn> };
    const svc = new CompactionService(llmAdapter, tokenEstimator, sizeEstimator);
    tokenEstimator.estimateRequestTokens.mockReturnValueOnce(100).mockReturnValueOnce(500);
    tokenEstimator.estimateMessages.mockReturnValue(30);
    streamHandoff('交接正文', usage(1, 0, 1));
    // 用真实量级的上限（800KB）：64KB 安全余量才能体现边界，而非「恒为负 → 永远剥图」
    sizeEstimator.estimate.mockReturnValueOnce(900_000).mockReturnValueOnce(100_000);

    const cfg = config();
    cfg.triggerPayloadBytes = 800;
    const withImage: ChatRequest = {
      ...normalRequest(),
      messages: [
        ...(normalRequest().messages ?? []),
        {
          role: 'user',
          content: [
            { type: 'text', text: SYNTHETIC_ATTACHMENT_PROMPT },
            { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAA' } },
          ],
        },
      ],
    };
    const sessionModel = { modelId: 's', contextWindowTokens: 1000 };
    const compactionModel = { modelId: 's', contextWindowTokens: 1000, maxRequestBodyBytes: 800_000 };
    const result = await svc.compactSession(
      7, 0, persisted(), [1, 2, 3], withImage, compactionModel, cfg, null, null,
      100, false, sessionModel, 900,
    );
    expect(result).not.toBeNull();
    const derived = llmAdapter.stream.mock.calls[0][0] as ChatRequest;
    const hasImage = (derived.messages ?? []).some((m) => Array.isArray(m.content)
      && (m.content as Array<Record<string, unknown>>).some((p) => p.type === 'image_url'));
    expect(hasImage).toBe(false);
    expect(derived.messages).toHaveLength((withImage.messages?.length ?? 0));
  });

  it('keeps images when the compaction request is just below the provider strip line', async () => {
    const sizeEstimator = { estimate: vi.fn() } as unknown as RequestSizeEstimator & { estimate: ReturnType<typeof vi.fn> };
    const svc = new CompactionService(llmAdapter, tokenEstimator, sizeEstimator);
    tokenEstimator.estimateRequestTokens.mockReturnValueOnce(100).mockReturnValueOnce(500);
    tokenEstimator.estimateMessages.mockReturnValue(30);
    streamHandoff('交接正文', usage(1, 0, 1));
    // 上限 800000 → 剥图线 = 800000-65536 = 734464；734463 不应剥图（否则每次压缩都 miss 缓存）
    sizeEstimator.estimate.mockReturnValue(734_463);
    const cfg = config();
    cfg.triggerPayloadBytes = 800;
    const withImage: ChatRequest = {
      ...normalRequest(),
      messages: [
        ...(normalRequest().messages ?? []),
        {
          role: 'user',
          content: [
            { type: 'text', text: SYNTHETIC_ATTACHMENT_PROMPT },
            { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAA' } },
          ],
        },
      ],
    };
    const compactionModel = { modelId: 's', contextWindowTokens: 1000, maxRequestBodyBytes: 800_000 };
    const result = await svc.compactSession(
      7, 0, persisted(), [1, 2, 3], withImage, compactionModel, cfg, null, null,
      100, false, compactionModel, 900,
    );
    expect(result).not.toBeNull();
    const derived = llmAdapter.stream.mock.calls[0][0] as ChatRequest;
    const hasImage = (derived.messages ?? []).some((m) => Array.isArray(m.content)
      && (m.content as Array<Record<string, unknown>>).some((p) => p.type === 'image_url'));
    expect(hasImage).toBe(true);
  });

  it('strips exactly at the provider strip line', async () => {
    const sizeEstimator = { estimate: vi.fn() } as unknown as RequestSizeEstimator & { estimate: ReturnType<typeof vi.fn> };
    const svc = new CompactionService(llmAdapter, tokenEstimator, sizeEstimator);
    tokenEstimator.estimateRequestTokens.mockReturnValueOnce(100).mockReturnValueOnce(500);
    tokenEstimator.estimateMessages.mockReturnValue(30);
    streamHandoff('交接正文', usage(1, 0, 1));
    // 734464 = 800000 - 65536（64KiB 安全余量）：恰好到线即剥图
    sizeEstimator.estimate.mockReturnValueOnce(734_464).mockReturnValueOnce(1024);
    const cfg = config();
    cfg.triggerPayloadBytes = 800;
    const compactionModel = { modelId: 's', contextWindowTokens: 1000, maxRequestBodyBytes: 800_000 };
    const withImage: ChatRequest = {
      ...normalRequest(),
      messages: [
        ...(normalRequest().messages ?? []),
        {
          role: 'user',
          content: [
            { type: 'text', text: SYNTHETIC_ATTACHMENT_PROMPT },
            { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAA' } },
          ],
        },
      ],
    };
    const result = await svc.compactSession(
      7, 0, persisted(), [1, 2, 3], withImage, compactionModel, cfg, null, null,
      100, false, compactionModel, 900,
    );
    expect(result).not.toBeNull();
    const derived = llmAdapter.stream.mock.calls[0][0] as ChatRequest;
    const hasImage = (derived.messages ?? []).some((m) => Array.isArray(m.content)
      && (m.content as Array<Record<string, unknown>>).some((p) => p.type === 'image_url'));
    expect(hasImage).toBe(false);
  });

  it('throws payload overflow when stripping still exceeds the provider limit', async () => {
    const sizeEstimator = { estimate: vi.fn() } as unknown as RequestSizeEstimator & { estimate: ReturnType<typeof vi.fn> };
    const svc = new CompactionService(llmAdapter, tokenEstimator, sizeEstimator);
    tokenEstimator.estimateRequestTokens.mockReturnValueOnce(100).mockReturnValueOnce(500);
    tokenEstimator.estimateMessages.mockReturnValue(30);
    sizeEstimator.estimate.mockReturnValueOnce(900_000).mockReturnValue(900_000);
    const cfg = config();
    cfg.triggerPayloadBytes = 800;
    const compactionModel = { modelId: 's', contextWindowTokens: 1000, maxRequestBodyBytes: 800_000 };
    await expect(svc.compactSession(
      7, 0, persisted(), [1, 2, 3], normalRequest(), compactionModel, cfg, null, null,
      100, false, compactionModel, 900,
    )).rejects.toBeInstanceOf(CompactionPayloadOverflowException);
    expect(llmAdapter.stream).not.toHaveBeenCalled();
  });

  it('strips on a legacy huge session even when no provider limit is declared', async () => {
    const sizeEstimator = { estimate: vi.fn() } as unknown as RequestSizeEstimator & { estimate: ReturnType<typeof vi.fn> };
    const svc = new CompactionService(llmAdapter, tokenEstimator, sizeEstimator);
    tokenEstimator.estimateRequestTokens.mockReturnValueOnce(100).mockReturnValueOnce(500);
    tokenEstimator.estimateMessages.mockReturnValue(30);
    streamHandoff('交接正文', usage(1, 0, 1));
    // 未声明供应商上限（存量会话默认状态）：50MB 压缩请求必须剥图，否则原样发出去就是 413。
    // 剥图线是独立的 40MiB 常量，不受 triggerPayloadBytes（这里是 800，仅用于提前触发）影响。
    sizeEstimator.estimate.mockReturnValueOnce(50 * 1024 * 1024).mockReturnValueOnce(1024 * 1024);
    const cfg = config();
    cfg.triggerPayloadBytes = 800;
    const noLimitModel = { modelId: 's', contextWindowTokens: 1000 };
    const withImage: ChatRequest = {
      ...normalRequest(),
      messages: [
        ...(normalRequest().messages ?? []),
        {
          role: 'user',
          content: [
            { type: 'text', text: SYNTHETIC_ATTACHMENT_PROMPT },
            { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAA' } },
          ],
        },
      ],
    };
    const result = await svc.compactSession(
      7, 0, persisted(), [1, 2, 3], withImage, noLimitModel, cfg, null, null,
      100, false, noLimitModel, 900,
    );
    expect(result).not.toBeNull();
    const derived = llmAdapter.stream.mock.calls[0][0] as ChatRequest;
    const hasImage = (derived.messages ?? []).some((m) => Array.isArray(m.content)
      && (m.content as Array<Record<string, unknown>>).some((p) => p.type === 'image_url'));
    expect(hasImage).toBe(false);
  });

  it('keeps images when the compaction request is above the trigger but below the strip line', async () => {
    const sizeEstimator = { estimate: vi.fn() } as unknown as RequestSizeEstimator & { estimate: ReturnType<typeof vi.fn> };
    const svc = new CompactionService(llmAdapter, tokenEstimator, sizeEstimator);
    tokenEstimator.estimateRequestTokens.mockReturnValueOnce(100).mockReturnValueOnce(500);
    tokenEstimator.estimateMessages.mockReturnValue(30);
    streamHandoff('交接正文', usage(1, 0, 1));
    // agent 级把触发阈值调到 800 字节（提前压缩），但压缩请求只有 5MB，远低于 40MiB 剥图线：
    // 不能因为「触发了压缩」就剥图，否则每次压缩都 miss 前缀缓存。
    sizeEstimator.estimate.mockReturnValue(5 * 1024 * 1024);
    const cfg = config();
    cfg.triggerPayloadBytes = 800;
    const noLimitModel = { modelId: 's', contextWindowTokens: 1000 };
    const withImage: ChatRequest = {
      ...normalRequest(),
      messages: [
        ...(normalRequest().messages ?? []),
        {
          role: 'user',
          content: [
            { type: 'text', text: SYNTHETIC_ATTACHMENT_PROMPT },
            { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAA' } },
          ],
        },
      ],
    };
    const result = await svc.compactSession(
      7, 0, persisted(), [1, 2, 3], withImage, noLimitModel, cfg, null, null,
      100, false, noLimitModel, 900,
    );
    expect(result).not.toBeNull();
    const derived = llmAdapter.stream.mock.calls[0][0] as ChatRequest;
    const hasImage = (derived.messages ?? []).some((m) => Array.isArray(m.content)
      && (m.content as Array<Record<string, unknown>>).some((p) => p.type === 'image_url'));
    expect(hasImage).toBe(true);
  });
});
