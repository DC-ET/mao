import type { ChatMessage, ToolCall } from '../llm/chat-request.js';
import type { Message } from '../deps.js';
import { harnessLog } from '../log.js';

/** 发给模型的占位 tool 结果：补齐缺失的 tool_call 配对，避免网关 400 把会话卡死。 */
export const MISSING_TOOL_RESULT_PLACEHOLDER =
  '[系统] 该工具调用没有对应输出（执行中断或结果未保存）。请勿假定已成功；如仍需要请重试。';

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
    if (messages == null || messages.length === 0) return messages;
    if (!hasToolCallsOrToolMessages(messages)) return messages;

    const deferredTools = new Map<string, ChatMessage>();
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.toolCallId != null && msg.toolCallId !== '') {
        deferredTools.set(msg.toolCallId, msg);
      }
    }

    const normalized: ChatMessage[] = [];
    let filled = 0;
    for (const msg of messages) {
      if (msg.role === 'tool') continue;
      normalized.push(msg);
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        for (const toolCall of msg.toolCalls) {
          if (toolCall.id == null || toolCall.id === '') continue;
          const toolMsg = deferredTools.get(toolCall.id);
          if (toolMsg) {
            deferredTools.delete(toolCall.id);
            normalized.push(toolMsg);
          } else {
            normalized.push({
              role: 'tool',
              toolCallId: toolCall.id,
              content: MISSING_TOOL_RESULT_PLACEHOLDER,
            });
            filled++;
          }
        }
      }
    }
    if (deferredTools.size > 0) {
      harnessLog('warn', `Dropping ${deferredTools.size} orphaned tool messages without a preceding assistant tool_calls`);
    }
    if (filled > 0) {
      harnessLog('warn', `Filled ${filled} missing tool output(s) before sending history to the LLM`);
    }
    return normalized;
  },
};

export function ensureContentPresent(messages: ChatMessage[] | null | undefined): void {
  MessageHistoryNormalizer.ensureContentPresent(messages);
}

function hasToolCallsOrToolMessages(messages: ChatMessage[]): boolean {
  for (const msg of messages) {
    if (msg.role === 'tool') return true;
    if (msg.role === 'assistant' && msg.toolCalls != null && msg.toolCalls.length > 0) return true;
  }
  return false;
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
