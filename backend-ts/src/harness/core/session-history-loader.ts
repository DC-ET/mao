import type { ChatMessage, ChatRequest, ToolCall } from '../llm/chat-request.js';
import type { Message, SessionService } from '../deps.js';
import type { AgentExecutionContext } from './agent-execution-context.js';
import type { CompactionArchiveService } from './compaction-archive.service.js';
import { isRealUserMessage } from './compaction-service.js';
import type { ContextManager } from './context-manager.js';
import { MessageHistoryNormalizer } from './message-history-normalizer.js';
import { PersistedChatMessage } from './persisted-chat-message.js';
import { ToolAttachmentLoader } from './tool-attachment-loader.js';
import { harnessLog } from '../log.js';

export interface HistorySnapshot {
  snapshotMessageIds: number[];
  normalizedEntities: Message[];
  persistedMessages: PersistedChatMessage[];
}

export class SessionHistoryLoader {
  constructor(
    private readonly sessionService: SessionService,
    private readonly contextManager: ContextManager,
    private readonly compactionArchiveService: CompactionArchiveService,
  ) {}

  async loadHistoryAfterBoundary(sessionId: number, boundary: number): Promise<HistorySnapshot> {
    const rawMessages = await this.sessionService.getMessagesAfterId(sessionId, boundary);
    // 快照 id 必须与持久化消息同源。孤儿 TOOL 会被归一化丢掉；若仍把原始 id 放进快照，
    // isCompletePhysicalPrefix 会因缺 id 永远拒绝压缩，边界推不过这条孤儿。
    const normalized = MessageHistoryNormalizer.normalizeEntities(rawMessages, parseToolCallsJson) ?? rawMessages;
    const snapshotMessageIds = normalized.map((m) => m.id!);
    const persistedMessages = normalized.map((message) => new PersistedChatMessage(
      message.id!,
      message.content ?? '',
      this.toChatMessage(message),
    ));
    return { snapshotMessageIds, normalizedEntities: normalized, persistedMessages };
  }

  async applyHistory(
    context: AgentExecutionContext, summary: string | null | undefined, history: HistorySnapshot,
  ): Promise<void> {
    const incremental = MessageHistoryNormalizer.normalizeChatMessages(
      history.persistedMessages.map((p) => p.chatMessage),
    ) ?? [];
    const archiveHint = this.compactionArchiveService.buildArchiveHint(
      context.executionMode, context.userId, context.sessionId);
    const latestUserMessage = await this.resolveLatestUserMessage(context, summary, incremental);
    // 跨压缩边界的日期参照（技术方案 2026-10-12 §5.2）：窗口内第一条用户消息的「上一条
    // 用户消息」日期，让跨天提示能判出「边界前的会话与边界后的首条消息日期不同」。
    // 窗口内无用户消息（首轮 / 边界已跨过全部用户消息）时为 null，由 sessionBaseYmd 兜底比较。
    context.previousUserYmdBefore = await this.resolvePreviousUserYmdBefore(context, history);
    context.messages.length = 0;
    context.messages.push(...this.contextManager.prependSessionSummary(
      summary, incremental, archiveHint, latestUserMessage));
    if (context.ephemeralSystemMessages.length > 0) {
      context.messages.push(...context.ephemeralSystemMessages);
    }
    context.sessionSummary = summary;
    context.toolAttachments.clear();
    for (const [k, v] of Object.entries(ToolAttachmentLoader.loadAllFromMessages(history.normalizedEntities))) {
      context.toolAttachments.set(k, v);
    }
  }

  private async resolveLatestUserMessage(
    context: AgentExecutionContext,
    summary: string | null | undefined,
    incremental: ChatMessage[],
  ): Promise<ChatMessage | null> {
    if (summary == null || summary.trim() === '') return null;
    if (incremental.some(isRealUserMessage)) return null;
    if (context.sessionId == null || this.sessionService.getLastUserMessage == null) return null;
    const last = await this.sessionService.getLastUserMessage(context.sessionId);
    if (last == null) return null;
    const message = this.toChatMessage(last);
    return isRealUserMessage(message) ? message : null;
  }

  /**
   * 窗口内第一条用户消息之前最近的一条现存用户消息日期（技术方案 2026-10-12 §5.2）。
   * 取 normalizedEntities 里第一条 USER 的 id：normalizeChatMessages 可能丢弃孤儿 TOOL，
   * 但 USER 的 id 顺序不变，用它做上界最稳妥。
   * 查询失败只降级为 null（回落 sessionBaseYmd 比较）：这是提示增强，不能因 DB 抖动
   * 打挂 buildContext 与压缩重载（与 harness-service.resolveSessionBaseYmd 同构容错）。
   */
  private async resolvePreviousUserYmdBefore(
    context: AgentExecutionContext,
    history: HistorySnapshot,
  ): Promise<string | null> {
    if (context.sessionId == null || this.sessionService.getPreviousUserStamp == null) return null;
    const firstUser = history.normalizedEntities.find((m) => m.role?.toUpperCase() === 'USER' && m.id != null);
    if (firstUser?.id == null) return null;
    let previous: Pick<Message, 'id' | 'createdAt'> | null = null;
    try {
      previous = await this.sessionService.getPreviousUserStamp(context.sessionId, firstUser.id);
    } catch (e) {
      harnessLog('warn',
        `Failed to resolve previous user stamp for session ${context.sessionId}: ${(e as Error).message}`);
      return null;
    }
    const ymd = previous?.createdAt ? String(previous.createdAt).slice(0, 10) : '';
    return ymd.length === 10 ? ymd : null;
  }

  toChatMessage(message: Message): ChatMessage {
    const msg: ChatMessage = {
      role: message.role?.toLowerCase(),
      content: parseContent(message.content),
    };
    if (message.toolCallId) msg.toolCallId = message.toolCallId;
    // 发送日期随历史消息下发（技术方案 2026-10-12 §5.2）：仅用于提示词渲染的
    // `<date-change>` 跨天提示比较，不写入任何协议请求体（ChatMessage.senderYmd 注释约定）。
    // created_at 是写入端墙钟字符串，直接截取前 10 位与写入端同口径，不引入二次时区偏移。
    if (message.createdAt) {
      const ymd = String(message.createdAt).slice(0, 10);
      if (ymd.length === 10) msg.senderYmd = ymd;
    }
    if (message.toolCalls) {
      try {
        msg.toolCalls = parseToolCallsJson(message.toolCalls);
      } catch (e) {
        harnessLog('warn', `Failed to parse tool_calls for message ${message.id}`, e);
      }
    }
    // DeepSeek thinking 模式要求带 tools 的多轮请求回传历史 assistant 的 reasoning_content，
    // 崩溃恢复 / compaction 重载历史时需从持久化的 thinking_content 还原，否则后续请求 400。
    if (message.thinkingContent) msg.reasoningContent = message.thinkingContent;
    return msg;
  }
}

function parseToolCallsJson(json: string): ToolCall[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed as ToolCall[] : [];
  } catch {
    return [];
  }
}

function parseContent(raw: string | null | undefined): unknown {
  if (raw == null) return '';
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      // 只有每个元素都是含 type 的多模态 content part 才按数组解析；
      // 用户发送的纯文本 JSON 数组（如 [1,2,3]、["a","b"]、[]）在 DB 中与多模态数组无法区分，
      // 若不校验结构会被误当作 content part 数组发给 LLM，产生 400 或内容损毁。
      if (isMultimodalContentParts(parsed)) return parsed;
      return raw;
    } catch {
      return raw;
    }
  }
  return raw;
}

/** 每个元素必须是含 type（text/image_url）的对象，且任一元素不满足则整体按原始字符串返回。 */
function isMultimodalContentParts(parsed: unknown): parsed is Array<Record<string, unknown>> {
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  return parsed.every((part) => {
    if (part == null || typeof part !== 'object' || Array.isArray(part)) return false;
    const map = part as Record<string, unknown>;
    return map.type === 'text' || map.type === 'image_url';
  });
}
