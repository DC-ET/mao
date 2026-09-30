import type { ChatMessage } from '../llm/chat-request.js';
import { isRealUserMessage } from '../core/compaction-service.js';

const MAX_USER_MESSAGES = 5;
const MAX_TOOL_CALLS = 10;
const USER_MESSAGE_CHAR_LIMIT = 600;
const TOOL_CALL_ARG_CHAR_LIMIT = 200;
const TOTAL_CHAR_LIMIT = 4000;

/**
 * 构建「替我审批」的上下文快照。刻意最小化：
 * - 只含真实用户消息与工具调用轨迹（工具名+参数）；
 * - 不含 assistant 自然语言输出、工具执行结果、会话摘要——这些都是模型生成物或外部数据，
 *   是诱导审批 LLM 的主要攻击面，也是上下文体积大头。
 */
export function buildApprovalContextSnapshot(messages: ChatMessage[]): string {
  const userMessages: string[] = [];
  for (const message of messages) {
    if (!isRealUserMessage(message)) continue;
    const text = textOf(message.content).trim();
    if (text === '') continue;
    userMessages.push(truncate(text, USER_MESSAGE_CHAR_LIMIT));
  }

  const toolCalls: string[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.toolCalls)) continue;
    for (const call of message.toolCalls) {
      const name = call.function?.name ?? 'unknown';
      const args = truncate(String(call.function?.arguments ?? ''), TOOL_CALL_ARG_CHAR_LIMIT);
      toolCalls.push(`- ${name}(${args})`);
    }
  }

  // 最近的条目价值最高：超限时从最旧的开始丢
  const users = userMessages.slice(-MAX_USER_MESSAGES);
  const calls = toolCalls.slice(-MAX_TOOL_CALLS);
  while (users.length + calls.length > 0 && render(users, calls).length > TOTAL_CHAR_LIMIT) {
    if (calls.length > 0 && (users.length <= 1 || calls.length >= users.length)) {
      calls.shift();
    } else {
      users.shift();
    }
  }
  return render(users, calls);
}

function render(userMessages: string[], toolCalls: string[]): string {
  const parts: string[] = [];
  parts.push('## 用户指令');
  if (userMessages.length === 0) {
    parts.push('（无）');
  } else {
    for (let i = 0; i < userMessages.length; i++) {
      parts.push(`${i + 1}. ${userMessages[i]}`);
    }
  }
  parts.push('');
  parts.push('## 最近工具调用');
  if (toolCalls.length === 0) {
    parts.push('（无）');
  } else {
    parts.push(...toolCalls);
  }
  return parts.join('\n');
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part != null && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .filter((t) => t !== '')
      .join(' ');
  }
  return '';
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) + '…[截断]' : text;
}
