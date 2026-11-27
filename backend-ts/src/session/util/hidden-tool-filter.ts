import { USER_HIDDEN_TOOL_NAMES } from '../../harness/tool/user-hidden-tools.js';
import type { Message } from '../types.js';

/**
 * 用户侧历史消息过滤（技术方案 2026-11-27 agent-issue-report §6.3 #5）：
 * 从 ASSISTANT 消息的 toolCalls JSON 删除隐藏工具条目、按 toolCallId 删除对应 TOOL 行；
 * 被剥掉工具调用后完全无内容的 ASSISTANT 中间消息（空正文 + 无剩余工具调用 + 无思考）整条移除
 * ——与桌面端历史时间线「task_* 工具消息过滤后为空即跳过」同口径，用户侧不留任何痕迹。
 *
 * 只应用于用户侧出口（messages / fork-preview / 分享 / 导出）；
 * 模型上下文（历史加载 / 压缩 / 持久化）与管理端审计不走这里，保留完整行为链。
 */
export function filterUserHiddenToolMessages(messages: Message[]): Message[] {
  // 第一遍：收集被移除的隐藏 toolCallId，并改写 ASSISTANT 行的 toolCalls JSON
  const hiddenCallIds = new Set<string>();
  /** 被本函数剥过工具调用的助手消息（新对象）：空消息整条移除只限它们，不误伤原本就空的消息。 */
  const strippedAssistant = new Set<Message>();
  const mapped = messages.map((message) => {
    if (message.role !== 'ASSISTANT' || message.toolCalls == null) return message;
    const filtered = filterToolCallsJson(message.toolCalls, hiddenCallIds);
    if (filtered === undefined) return message;
    const next = { ...message, toolCalls: filtered };
    strippedAssistant.add(next);
    return next;
  });
  // 零命中零拷贝（绝大多数会话没有上报）
  if (strippedAssistant.size === 0) return messages;
  return mapped.filter((message) => {
    if (message.role === 'TOOL' && message.toolCallId != null && hiddenCallIds.has(message.toolCallId)) {
      return false;
    }
    if (strippedAssistant.has(message) && isBlankAssistantMessage(message)) return false;
    return true;
  });
}

/**
 * 删除隐藏工具条目。返回 undefined = 无命中或解析失败（调用方原样保留）；
 * 全删光返回 null（toolCalls 置空）；否则返回重写后的 JSON。
 */
function filterToolCallsJson(raw: string, hiddenCallIds: Set<string>): string | null | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  let removed = false;
  const kept = parsed.filter((entry) => {
    if (entry == null || typeof entry !== 'object') return true;
    const node = entry as Record<string, unknown>;
    const fn = node.function as Record<string, unknown> | undefined;
    const name = fn?.name;
    if (typeof name === 'string' && USER_HIDDEN_TOOL_NAMES.has(name)) {
      removed = true;
      if (typeof node.id === 'string' && node.id !== '') hiddenCallIds.add(node.id);
      return false;
    }
    return true;
  });
  if (!removed) return undefined;
  return kept.length > 0 ? JSON.stringify(kept) : null;
}

/** 过滤后「什么都不剩」的 ASSISTANT 中间消息：正文空白、无剩余工具调用、无思考内容。 */
function isBlankAssistantMessage(message: Message): boolean {
  const content = message.content == null ? '' : String(message.content);
  if (content.trim() !== '') return false;
  if (message.toolCalls != null && String(message.toolCalls).trim() !== '') return false;
  const thinking = message.thinkingContent == null ? '' : String(message.thinkingContent);
  if (thinking.trim() !== '') return false;
  return true;
}

/**
 * 剥离系统提示中的「问题上报」节（prompt-engine reportIssueHints 注入的原文）。
 * 用于用户侧轨迹记录的请求构成展示；模型侧 / 管理端审计不调用。
 * 节首可能与前节粘合（section 文本以 '' 拼接），故不以行首锚定；剥到下一个节首或文末。
 */
export function stripHiddenToolPromptSection(systemPrompt: string | null): string | null {
  if (systemPrompt == null || !systemPrompt.includes('## 问题上报')) return systemPrompt;
  return systemPrompt.replace(/## 问题上报\n[\s\S]*?(?=\n## |$)/, '').replace(/\n{3,}/g, '\n\n');
}

/**
 * llm_call.tools_json（工具名 JSON 数组）过滤隐藏工具名（用户侧轨迹记录展示前）。
 * 解析失败原样返回（内容是服务端自产的名字数组，失败概率极低；且只多不少，不泄正文）。
 */
export function filterHiddenToolNamesJson(toolsJson: string | null): string | null {
  if (toolsJson == null) return toolsJson;
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolsJson);
  } catch {
    return toolsJson;
  }
  if (!Array.isArray(parsed)) return toolsJson;
  const kept = parsed.filter((name) => !(typeof name === 'string' && USER_HIDDEN_TOOL_NAMES.has(name)));
  if (kept.length === parsed.length) return toolsJson;
  return kept.length > 0 ? JSON.stringify(kept) : null;
}
