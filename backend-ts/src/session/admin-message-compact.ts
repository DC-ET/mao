import type { Message } from './types.js';

/** 与管理端工具卡片展示上限一致：页面本身只画出前 4000 字。 */
const TOOL_RESULT_LIMIT = 4000;
/** 单个参数字段超过该长度才截断，避免小文件写入被裁掉。 */
const ARG_FIELD_LIMIT = 8000;
const ARG_KEEP = 1500;

export function compactAdminTranscript(messages: Message[]): Message[] {
  return messages.map((message) => {
    const role = (message.role || '').toUpperCase();
    if (role === 'TOOL') {
      const content = compactToolResult(message.content);
      return content === message.content ? message : { ...message, content };
    }
    if (role === 'ASSISTANT' && typeof message.toolCalls === 'string') {
      const toolCalls = compactToolCalls(message.toolCalls);
      return toolCalls === message.toolCalls ? message : { ...message, toolCalls };
    }
    return message;
  });
}

export function compactToolResult(content: string | null | undefined): string | null | undefined {
  if (content == null || content.length <= TOOL_RESULT_LIMIT) return content;
  const note = `\n…（输出已截断，原文 ${content.length} 字符，完整内容请导出记录）`;
  const prefix = isToolError(content) && !content.startsWith('Tool execution failed')
    ? 'Tool execution failed\n'
    : '';
  const budget = Math.max(0, TOOL_RESULT_LIMIT - note.length - prefix.length);
  return prefix + content.slice(0, budget) + note;
}

export function compactToolCalls(raw: string | null | undefined): string | null | undefined {
  if (raw == null || raw.length <= ARG_FIELD_LIMIT) return raw;
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return raw;
    let changed = false;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const fn = (item as { function?: { arguments?: unknown } }).function;
      if (!fn || typeof fn.arguments !== 'string' || fn.arguments.length <= ARG_FIELD_LIMIT) continue;
      fn.arguments = shrinkArgumentJson(fn.arguments);
      changed = true;
    }
    return changed ? JSON.stringify(list) : raw;
  } catch {
    return raw;
  }
}

function shrinkArgumentJson(raw: string): string {
  const noteFor = (length: number) => `\n…（参数过长已省略，原文 ${length} 字符，完整内容请导出记录）`;
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      let changed = false;
      const record = obj as Record<string, unknown>;
      for (const [key, value] of Object.entries(record)) {
        if (typeof value !== 'string' || value.length <= ARG_FIELD_LIMIT) continue;
        record[key] = value.slice(0, ARG_KEEP) + noteFor(value.length);
        changed = true;
      }
      if (changed) return JSON.stringify(record);
    }
  } catch {
    // 参数不是 JSON 时下面按纯文本截断
  }
  return raw.slice(0, ARG_KEEP) + noteFor(raw.length);
}

/**
 * 只看结果的头尾，避免把文件正文里的 "error" 误判成失败。
 * 截断后客户端仍用这段前缀识别失败，不会把失败调用画成成功。
 */
function isToolError(text: string): boolean {
  if (text.startsWith('Tool execution failed')) return true;
  if (/^\s*\{\s*"error"\s*:/.test(text)) return true;
  if (/^\s*\{\s*"success"\s*:\s*false\b/.test(text)) return true;
  return /"exit_code"\s*:\s*(?!0(?:\D|$))\d+/.test(text.slice(-500));
}
