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
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}
