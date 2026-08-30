import type { ChatMessage, ChatRequest, ToolCall } from '../llm/chat-request.js';
import type { Message, SessionService } from '../deps.js';
import type { AgentExecutionContext } from './agent-execution-context.js';
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
  ) {}

  async loadHistoryAfterBoundary(sessionId: number, boundary: number): Promise<HistorySnapshot> {
    const rawMessages = await this.sessionService.getMessagesAfterId(sessionId, boundary);
    const snapshotMessageIds = rawMessages.map((m) => m.id!);
    const normalized = MessageHistoryNormalizer.normalizeEntities(rawMessages, parseToolCallsJson) ?? rawMessages;
    const persistedMessages = normalized.map((message) => new PersistedChatMessage(
      message.id!,
      message.content ?? '',
      this.toChatMessage(message),
    ));
    return { snapshotMessageIds, normalizedEntities: normalized, persistedMessages };
  }

  applyHistory(context: AgentExecutionContext, summary: string | null | undefined, history: HistorySnapshot): void {
    const incremental = history.persistedMessages.map((p) => p.chatMessage);
    context.messages.length = 0;
    context.messages.push(...this.contextManager.prependSessionSummary(summary, incremental));
    if (context.ephemeralSystemMessages.length > 0) {
      context.messages.push(...context.ephemeralSystemMessages);
    }
    context.sessionSummary = summary;
    context.toolAttachments.clear();
    for (const [k, v] of Object.entries(ToolAttachmentLoader.loadAllFromMessages(history.normalizedEntities))) {
      context.toolAttachments.set(k, v);
    }
  }

  toChatMessage(message: Message): ChatMessage {
    const msg: ChatMessage = {
      role: message.role?.toLowerCase(),
      content: parseContent(message.content),
    };
    if (message.toolCallId) msg.toolCallId = message.toolCallId;
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
