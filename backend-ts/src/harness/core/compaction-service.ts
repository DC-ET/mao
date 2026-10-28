import type { ChatMessage, ChatRequest, ChatUsage, LlmAdapter, LlmModelConfig, ToolCall } from '../llm/chat-request.js';
import type { AgentEventListener } from './agent-event-listener.js';
import { CompactionConfig } from './compaction-config.js';
import type { PersistedChatMessage } from './persisted-chat-message.js';
import { TokenEstimator } from './token-estimator.js';
import { RequestSizeEstimator } from './request-size.js';
import { stripImagesForCompaction } from './compaction-image-stripper.js';
import { harnessLog } from '../log.js';

const HANDOFF_PATTERN = /<handoff>(.*?)<\/handoff>/s;
const SYSTEM_NOTICE_OPEN = '<system-notice>';
const HANDOFF_USER_HEADER = '## 会话压缩摘要';
/** 压缩请求接近供应商上限时的兜底余量：给摘要指令、JSON 转义与网关开销留空间。 */
const COMPACTION_PAYLOAD_SAFETY_MARGIN_BYTES = 64 * 1024;
/**
 * 未声明供应商上限时的剥图安全线（字节）。
 * 与 `harness.compaction.triggerPayloadBytes` 解耦：后者 0 = 关闭触发，但仍需防 413。
 */
const DEFAULT_COMPACTION_STRIP_LIMIT_BYTES = 40 * 1024 * 1024;

/**
 * 供应商把请求判为「太大」的拒绝：400（context length / token limit）或 413（请求体过大）。
 * 各适配器的 StreamErrorEventException 未导出但形态一致（statusCode 属性 + 统一消息前缀），
 * 非 2xx 分支抛的是不带 statusCode 的普通 Error，故按消息文本判定；限流与服务端错误不在此列。
 */
const PROVIDER_SIZE_REJECTION_PATTERN = /context[_ -]?length|context window|maximum context|maximum number of tokens|too long|too large|token limit|tokens? (exceed|limit|maximum)|request (body|entity) too large|payload too large/i;

function isProviderSizeRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const statusCode = (error as { statusCode?: number | null }).statusCode;
  if (statusCode != null && statusCode !== 400 && statusCode !== 413) return false;
  return PROVIDER_SIZE_REJECTION_PATTERN.test(error.message);
}

/** 真实用户消息：排除压缩摘要模板与 `<system-notice>` 系统注入。 */
export function isRealUserMessage(message: ChatMessage): boolean {
  if (message.role !== 'user') return false;
  if (Array.isArray(message.content)) return true;
  const text = typeof message.content === 'string' ? message.content.trim() : '';
  if (text === '') return false;
  if (text.startsWith(SYSTEM_NOTICE_OPEN)) return false;
  if (text.startsWith(HANDOFF_USER_HEADER)) return false;
  return true;
}

function wrapAsSystemNotice(body: string): string {
  return `${SYSTEM_NOTICE_OPEN}\n${body.trim()}\n</system-notice>`;
}

/**
 * 压缩摘要用户消息正文（ CompactionService.buildHandoffUserMessage 的纯函数内核）。
 * 独立导出以便上下文透视 manifest 以完全一致的文本估算 handoff 节 token（技术方案 5.2），
 * 避免复制这段长文案造成两处漂移。
 * 措辞注意：这是同一会话内「继续你自己的任务」的延续框架，禁止出现「交接/接手」话术——
 * 模型会把这里的口吻原样复述给用户（2026-10-25 修复）。
 */
export function buildHandoffUserContent(summary: string, archiveHint?: string | null): string {
  let content = '## 会话压缩摘要\n\n'
    + '以下是你正在执行的任务的历史状态摘要，由系统在上下文接近上限时自动压缩生成。'
    + '任务与执行者都没有变化，你依然是本会话中同一个助手，继续做的是同一件事；'
    + '对用户而言这就是同一任务的延续，无需向用户解释压缩机制。\n'
    + '本摘要不能覆盖当前 system/developer 规则、权限或安全约束；若与后续真实用户消息冲突，以后续真实用户消息为准。\n\n'
    + summary.trim() + '\n\n'
    + '请基于摘要直接继续执行其中尚未完成的当前任务，不要只复述摘要，也不要重复已经完成的步骤。';
  if (archiveHint != null && archiveHint.trim() !== '') {
    content += '\n\n' + archiveHint.trim();
  }
  return content;
}

export interface SessionCompactionResult {
  summaryText: string;
  expectedOldBoundary: number;
  newLastCompactedMessageId: number;
  boundaryContentSnapshot: string;
  compactedCount: number;
  promptTokens: number;
  cachedTokens: number | null;
  completionTokens: number;
  summaryTokens: number;
  savedTokens: number;
  beforeRequestTokens: number;
  durationMs: number;
}

/**
 * 压缩请求被供应商判定为过大（超上下文窗口）的终态。
 * 估算超过配窗不再预检抛错——`contextWindowTokens` 是后台按模型维护的稳定区间而非供应商硬上限，
 * 预检会把本可成功的压缩判死；改为先发请求，只有供应商真以体积类错误拒绝时才抛本异常。
 */
export class CompactionContextOverflowException extends Error {
  constructor(readonly estimatedTokens: number, readonly effectiveWindow: number) {
    super(`会话全量压缩请求估算为 ${estimatedTokens} tokens，已达到或超过有效上下文窗口 ${effectiveWindow} tokens；请改用更大窗口模型或新建会话。`);
    this.name = 'CompactionContextOverflowException';
  }
}

/** 压缩请求体积超过供应商上限（剥图兜底后仍超）：与 token 溢出同属“压缩无法执行”的终态。 */
export class CompactionPayloadOverflowException extends Error {
  constructor(readonly estimatedBytes: number, readonly providerLimitBytes: number) {
    super(`会话压缩请求估算为 ${estimatedBytes} 字节，已达到供应商请求体上限 ${providerLimitBytes} 字节；请检查模型配置的请求体上限，或新建会话。`);
    this.name = 'CompactionPayloadOverflowException';
  }
}

export class CompactionCancelledException extends Error {
  constructor(cause?: unknown) {
    super('Cancelled by user');
    this.name = 'CompactionCancelledException';
    this.cause = cause;
  }
}

interface ValidatedHandoff {
  text: string;
  usage?: ChatUsage;
}

export class CompactionService {
  constructor(
    private readonly llmAdapter: LlmAdapter,
    private readonly tokenEstimator: TokenEstimator,
    private readonly requestSizeEstimator = new RequestSizeEstimator(),
  ) {}

  async compactSession(
    sessionId: number | null,
    expectedOldBoundary: number,
    messages: PersistedChatMessage[] | null,
    snapshotMessageIds: number[] | null,
    normalRequest: ChatRequest | null,
    modelConfig: LlmModelConfig,
    config: CompactionConfig,
    listener: AgentEventListener | null,
    cancelFlag: { get(): boolean } | null,
    activeTokensHint?: number | null,
    force = false,
    /** 会话主模型。触发阈值用它的窗口；缺省时用 config 兜底窗口，不用压缩模型窗口。 */
    sessionModelConfig?: LlmModelConfig | null,
    /** 本次请求体估算字节数（与 manifest.requestBytes 同源）；未传按 0 处理。 */
    payloadBytes?: number | null,
  ): Promise<SessionCompactionResult | null> {
    // 决策 6：enabled=false 只关「自动整理」，不禁止人工动作。force（手动压缩）旁路 enabled 门，
    // 但缺消息 / 缺请求仍无从压缩，照常短路。
    if (messages == null || messages.length === 0 || normalRequest == null || (!config.enabled && !force)) {
      return null;
    }
    this.checkCancelled(cancelFlag);

    // 触发判断优先采信调用方提供的活跃 tokens（锚点法，含真实 prompt usage）。
    // 内部估算器（utf8 字节/4）对中文与工具调用普遍显著低估，
    // 单独依赖它会在真实用量已超阈值时静默跳过压缩。
    const normalRequestTokens = this.tokenEstimator.estimateRequestTokens(normalRequest);
    // 触发阈值跟会话主模型走（与 agent-loop mid-loop 门同一口径），防止会话请求撑爆会话模型。
    // 压缩模型窗口只用于下面的溢出保护，防止摘要请求撑爆压缩模型。两者不能混用。
    const triggerWindow = CompactionConfig.resolveEffectiveContextWindow(sessionModelConfig, config);
    const overflowWindow = CompactionConfig.resolveEffectiveContextWindow(modelConfig, config);
    const measuredTokens = activeTokensHint != null && activeTokensHint > normalRequestTokens
      ? activeTokensHint
      : normalRequestTokens;
    const effectiveTriggerBytes = CompactionConfig.resolveEffectiveTriggerBytes(sessionModelConfig, config);
    const measuredBytes = payloadBytes != null && payloadBytes > 0 ? payloadBytes : 0;
    // force 旁路阈值判定：手动压缩即便未达阈值也强制执行（技术方案 5.4 / 决策 5）
    if (!force) {
      const trigger = CompactionConfig.shouldTrigger({
        tokens: measuredTokens,
        payloadBytes: measuredBytes,
        triggerWindowTokens: triggerWindow,
        effectiveTriggerBytes,
        config,
      });
      if (trigger == null) {
        harnessLog('info', `Session handoff compaction skipped below threshold: sessionId=${sessionId}`
          + `, measuredTokens=${measuredTokens}, estimatorTokens=${normalRequestTokens}`
          + `, payloadBytes=${measuredBytes}, payloadThreshold=${effectiveTriggerBytes}`);
        return null;
      }
      harnessLog('info', `Session handoff compaction trigger=${trigger}: sessionId=${sessionId}`
        + `, tokens=${measuredTokens}/${Math.floor(triggerWindow * config.triggerRatio)}`
        + `, bytes=${measuredBytes}/${effectiveTriggerBytes}`);
    }

    const started = Date.now();
    let compactionRequest = this.deriveRequest(normalRequest, this.buildHandoffInstruction(config.maxSummaryTokens));
    const compactionRequestTokens = this.tokenEstimator.estimateRequestTokens(compactionRequest);
    // 体积兜底（技术方案 2026-10-22 §6.4）：默认不剥图以复用主请求的前缀缓存；
    // 只有压缩请求贴近供应商上限时才剥图，保证压缩动作能执行（这一次会 miss 缓存）。
    // 未声明供应商上限时用独立安全线（40MiB）兜底：不能复用 triggerPayloadBytes——
    // 它设 0 表示「关闭体积触发」，若剥图线跟着变 0，token 触发/手动整理一个 50MB 会话时
    // 压缩请求会原样发出去撞 413；反向把 agent 级 trigger 调小也不该让每次压缩都剥图 miss 缓存。
    const providerLimitBytes = modelConfig.maxRequestBodyBytes ?? 0;
    if (sessionModelConfig != null && sessionModelConfig.modelId !== modelConfig.modelId) {
      // 压缩模型与会话模型不同 → 压缩请求前缀必然 miss 缓存（设计 §6.3 要求留空或保持一致）。
      harnessLog('warn', `Compaction model differs from session model, prompt cache will miss:`
        + ` sessionId=${sessionId} sessionModel=${sessionModelConfig.modelId} compactionModel=${modelConfig.modelId}`);
    }
    const stripLimitBytes = providerLimitBytes > 0
      ? Math.max(1, providerLimitBytes - COMPACTION_PAYLOAD_SAFETY_MARGIN_BYTES)
      : DEFAULT_COMPACTION_STRIP_LIMIT_BYTES;
    if (stripLimitBytes > 0) {
      const compactionBytes = this.requestSizeEstimator.estimate(compactionRequest, modelConfig.modelId);
      if (compactionBytes >= stripLimitBytes) {
        compactionRequest = stripImagesForCompaction(compactionRequest);
        harnessLog('warn', `Compaction request exceeded payload limit, images stripped (this call misses prompt cache):`
          + ` sessionId=${sessionId} bytes=${compactionBytes} limit=${stripLimitBytes}`
          + ` providerLimit=${providerLimitBytes > 0 ? providerLimitBytes : 'unknown'}`);
        const strippedBytes = this.requestSizeEstimator.estimate(compactionRequest, modelConfig.modelId);
        // 只有「已知供应商硬上限」才中断：未声明上限时剥图是尽力而为，
        // 剥完仍大也继续尝试（纯文本超大会话没有图可剥，直接失败会让用户会话彻底卡死）。
        if (providerLimitBytes > 0 && strippedBytes >= providerLimitBytes) {
          throw new CompactionPayloadOverflowException(strippedBytes, providerLimitBytes);
        }
      }
    }

    listener?.onCompactionStart?.('session', messages.length, measuredTokens);
    harnessLog('info', `Session handoff compaction triggered: sessionId=${sessionId}, messages=${messages.length}`
      + `, requestEstimate=${compactionRequestTokens}, compactionWindow=${overflowWindow}`);

    try {
      let handoff = await this.invokeAndValidate(compactionRequest, modelConfig, cancelFlag, listener);
      if (handoff == null) {
        // 纠正指令与首次请求同量级：首次已被供应商接受时，重试必然也能发，不再做二次预检。
        const retryRequest = this.deriveRequest(compactionRequest, this.correctionInstruction());
        handoff = await this.invokeAndValidate(retryRequest, modelConfig, cancelFlag, listener);
      }
      if (handoff == null) {
        harnessLog('warn', `Session handoff compaction failed semantic contract after one correction: sessionId=${sessionId}`);
        listener?.onCompactionEnd?.('session', 0, 0, Date.now() - started);
        return null;
      }
      const result = this.buildSafeResult(expectedOldBoundary, messages, snapshotMessageIds, handoff, measuredTokens, started);
      if (result == null) {
        harnessLog('warn', `Session handoff compaction rejected non-physical-prefix snapshot: sessionId=${sessionId}`);
        listener?.onCompactionEnd?.('session', 0, 0, Date.now() - started);
        return null;
      }
      return result;
    } catch (e) {
      listener?.onCompactionEnd?.('session', 0, 0, Date.now() - started);
      if (isProviderSizeRejection(e)) {
        harnessLog('warn', `Compaction request rejected by provider as too large: sessionId=${sessionId}`
          + `, requestEstimate=${compactionRequestTokens}, compactionWindow=${overflowWindow}`, e);
        throw new CompactionContextOverflowException(compactionRequestTokens, overflowWindow);
      }
      throw e;
    }
  }

  deriveRequest(source: ChatRequest, appendedUserContent: string): ChatRequest {
    const messages: ChatMessage[] = source.messages ? [...source.messages] : [];
    messages.push({ role: 'user', content: appendedUserContent });
    // 展开源请求以保留 promptCacheKey：Responses 网关按该键做上游粘性路由，
    // 丢掉后压缩请求无法打到主请求刚写过的前缀缓存分片。
    return {
      ...source,
      messages,
      stream: true,
    };
  }

  private async invokeAndValidate(
    request: ChatRequest,
    modelConfig: LlmModelConfig,
    cancelFlag: { get(): boolean } | null,
    listener: AgentEventListener | null,
  ): Promise<ValidatedHandoff | null> {
    this.checkCancelled(cancelFlag);
    try {
      const content: string[] = [];
      const toolCalls: ToolCall[] = [];
      let usage: ChatUsage | undefined;
      let streamError: unknown;
      await this.llmAdapter.stream(request, modelConfig, {
        onChunk: (chunk) => {
          for (const choice of chunk.choices ?? []) {
            const delta = choice.delta;
            if (!delta) continue;
            if (delta.content) content.push(delta.content);
            if (delta.toolCalls) toolCalls.push(...delta.toolCalls);
          }
        },
        onComplete: (u) => {
          usage = u;
        },
        onError: (t) => {
          streamError = t;
        },
        onStreamReset: () => {
          content.length = 0;
          toolCalls.length = 0;
          usage = undefined;
        },
        onWaiting: (phase, elapsedSeconds) => listener?.onLlmWaiting?.(phase, elapsedSeconds),
        onRetry: (reason, statusCode, attempt, maxRetries, delaySeconds) => {
          listener?.onLlmRetry?.(reason, statusCode, attempt, maxRetries, delaySeconds);
        },
      }, cancelFlag);
      if (streamError) throw streamError;
      this.checkCancelled(cancelFlag);
      if (toolCalls.length > 0) {
        harnessLog('warn', `Compaction response attempted ${toolCalls.length} tool call(s); ignored`);
        return null;
      }
      const raw = content.join('');
      if (raw === '') return null;
      const matcher = raw.match(HANDOFF_PATTERN);
      if (!matcher) return null;
      const text = matcher[1].trim();
      if (text === '') return null;
      return { text, usage };
    } catch (e) {
      if (e instanceof CompactionCancelledException) throw e;
      if (this.isCancelled(cancelFlag) || (e instanceof Error && e.message.includes('Cancelled by user'))) {
        throw new CompactionCancelledException(e);
      }
      throw e;
    }
  }

  private buildSafeResult(
    oldBoundary: number,
    messages: PersistedChatMessage[],
    snapshotMessageIds: number[] | null,
    handoff: ValidatedHandoff,
    beforeRequestTokens: number,
    started: number,
  ): SessionCompactionResult | null {
    const last = messages[messages.length - 1];
    const candidateBoundary = last.messageId;
    if (candidateBoundary <= oldBoundary || !this.isCompletePhysicalPrefix(oldBoundary, candidateBoundary, snapshotMessageIds, messages)) {
      return null;
    }
    const compactedCount = (snapshotMessageIds ?? []).filter((id) => id > oldBoundary && id <= candidateBoundary).length;
    const usage = handoff.usage;
    const cachedTokens = usage?.promptTokensDetails?.cachedTokens ?? null;
    const promptTokens = usage?.promptTokens ?? 0;
    const completionTokens = usage?.completionTokens ?? 0;
    const summaryTokens = this.tokenEstimator.estimateMessages([this.buildHandoffUserMessage(handoff.text)]);
    return {
      summaryText: handoff.text,
      expectedOldBoundary: oldBoundary,
      newLastCompactedMessageId: candidateBoundary,
      boundaryContentSnapshot: last.persistedContentSnapshot,
      compactedCount,
      promptTokens,
      cachedTokens,
      completionTokens,
      summaryTokens,
      savedTokens: 0,
      beforeRequestTokens,
      durationMs: Date.now() - started,
    };
  }

  private isCompletePhysicalPrefix(
    oldBoundary: number,
    candidateBoundary: number,
    snapshotMessageIds: number[] | null,
    messages: PersistedChatMessage[],
  ): boolean {
    if (snapshotMessageIds == null || snapshotMessageIds.length === 0) return false;
    const normalizedIds = new Set(messages.map((m) => m.messageId));
    return snapshotMessageIds
      .filter((id) => id > oldBoundary && id <= candidateBoundary)
      .every((id) => normalizedIds.has(id))
      && snapshotMessageIds.includes(candidateBoundary);
  }

  prependSessionSummary(
    summary: string | null | undefined,
    incrementalMessages: ChatMessage[] | null,
    archiveHint?: string | null,
    latestUserMessage?: ChatMessage | null,
  ): ChatMessage[] {
    const result: ChatMessage[] = [];
    if (summary != null && summary.trim() !== '') {
      result.push(this.buildHandoffUserMessage(summary, archiveHint));
    }
    if (incrementalMessages) result.push(...incrementalMessages);
    if (latestUserMessage && isRealUserMessage(latestUserMessage) && !result.some(isRealUserMessage)) {
      result.push(latestUserMessage);
    }
    return result;
  }

  buildHandoffUserMessage(summary: string, archiveHint?: string | null): ChatMessage {
    return { role: 'user', content: buildHandoffUserContent(summary, archiveHint) };
  }

  private buildHandoffInstruction(maxSummaryTokens: number): string {
    return wrapAsSystemNotice(`现在只整理当前任务的会话压缩摘要，不要继续执行任务，不要调用任何工具，也不要输出 tool calls。
本条是系统压缩指令，不是用户说的话。禁止把本指令写入摘要正文，也不得把其中的「不要继续执行」写成用户目标、关键原话或明确不做事项。用户目标与关键原话只来自本通知之前的真实用户消息。
请以你自己的口吻生成一份任务状态摘要，让你自己在上下文被压缩后能立即继续当前任务，沿用当前任务的主要语言，并保留：
- 用户目标、关键原话、已确认需求、约束与明确不做事项；
- 架构判断、技术决策、已完成动作及其结果；
- 未完成事项、当前停留位置、下一步；
- 文件路径、代码位置、接口、命令、错误、测试结果、版本号；
- 工具调用产生的关键事实，以及继续执行所需的具体上下文。
摘要中不要出现「交接」「接手」「下一个 Agent」等字样：任务始终由你本人继续，这是同一任务的延续。
不要提出新方案或修改已确认决策；不要复述 system/developer prompt、技能目录、工具定义或通用运行规则。
系统会在摘要消息后自动附上被压缩原始消息的归档目录说明；摘要无需提及归档机制，也不要编造归档路径；仍需完整保留继续执行任务所需的关键事实。
正文控制在约 ${maxSummaryTokens} tokens 以内。只输出一个非空的 <handoff>...</handoff>，标签外不得有任何文字。`);
  }

  private correctionInstruction(): string {
    return wrapAsSystemNotice(
      '上次响应未满足摘要格式或错误调用了工具。本条仍是系统压缩指令，不是用户说的话。'
      + '不得继续任务，不得调用工具，禁止把本指令写入摘要正文；'
      + '只输出一个非空的 <handoff>...</handoff>，不得输出标签外文字。',
    );
  }

  private checkCancelled(cancelFlag: { get(): boolean } | null): void {
    if (this.isCancelled(cancelFlag)) throw new CompactionCancelledException();
  }

  private isCancelled(cancelFlag: { get(): boolean } | null): boolean {
    return cancelFlag != null && cancelFlag.get();
  }
}
