import type { ChatMessage, ToolCall } from '../llm/chat-request.js';
import type { Message } from '../deps.js';
import { harnessLog } from '../log.js';

export const MessageHistoryNormalizer = {
  normalizeEntities(messages: Message[] | null | undefined, parseToolCalls: (json: string) => ToolCall[]): Message[] | null | undefined {
    if (messages == null || messages.length < 2) return messages;

    const deferredTools = collectDeferredToolMessages(messages);
    if (deferredTools.size === 0) return messages;

    const normalized: Message[] = [];
    for (const msg of messages) {
      if (msg.role === 'TOOL') continue;
      normalized.push(msg);
      if (msg.role === 'ASSISTANT' && msg.toolCalls) {
        appendMatchingToolMessages(normalized, deferredTools, extractToolCallIds(msg.toolCalls, parseToolCalls));
      }
    }
    if (deferredTools.size > 0) {
      harnessLog('warn', `Dropping ${deferredTools.size} orphaned tool messages without a preceding assistant tool_calls`);
    }
    return normalized;
  },

  ensureContentPresent(messages: ChatMessage[] | null | undefined): void {
    if (messages == null) return;
    for (const msg of messages) {
      if (msg != null && msg.content == null) {
        msg.content = '';
      }
    }
  },

  normalizeChatMessages(messages: ChatMessage[] | null | undefined): ChatMessage[] | null | undefined {
    if (messages == null || messages.length < 2) return messages;

    const deferredTools = new Map<string, ChatMessage>();
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.toolCallId != null) {
        deferredTools.set(msg.toolCallId, msg);
      }
    }
    if (deferredTools.size === 0) return messages;

    const normalized: ChatMessage[] = [];
    for (const msg of messages) {
      if (msg.role === 'tool') continue;
      normalized.push(msg);
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        for (const toolCall of msg.toolCalls) {
          if (toolCall.id == null) continue;
          const toolMsg = deferredTools.get(toolCall.id);
          if (toolMsg) {
            deferredTools.delete(toolCall.id);
            normalized.push(toolMsg);
          }
        }
      }
    }
    if (deferredTools.size > 0) {
      harnessLog('warn', `Dropping ${deferredTools.size} orphaned tool messages without a preceding assistant tool_calls`);
    }
    return normalized;
  },
};

export function ensureContentPresent(messages: ChatMessage[] | null | undefined): void {
  MessageHistoryNormalizer.ensureContentPresent(messages);
}

function collectDeferredToolMessages(messages: Message[]): Map<string, Message> {
  const deferred = new Map<string, Message>();
  for (const msg of messages) {
    if (msg.role === 'TOOL' && msg.toolCallId != null) {
      deferred.set(msg.toolCallId, msg);
    }
  }
  return deferred;
}

function appendMatchingToolMessages(normalized: Message[], deferred: Map<string, Message>, ids: string[]): void {
  for (const id of ids) {
    const toolMsg = deferred.get(id);
    if (toolMsg) {
      deferred.delete(id);
      normalized.push(toolMsg);
    }
  }
}

function extractToolCallIds(toolCallsJson: string, parseToolCalls: (json: string) => ToolCall[]): string[] {
  const ids: string[] = [];
  try {
    const toolCalls = parseToolCalls(toolCallsJson);
    for (const tc of toolCalls) {
      if (tc.id != null) ids.push(tc.id);
    }
  } catch (e) {
    harnessLog('warn', `Failed to parse tool_calls while normalizing message history: ${(e as Error).message}`);
  }
  return ids;
}
