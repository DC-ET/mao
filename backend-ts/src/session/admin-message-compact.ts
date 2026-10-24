import type { Message } from './types.js';

/** 与管理端工具卡片展示上限一致：页面本身只画出前 4000 字。 */
const TOOL_RESULT_LIMIT = 4000;
/** 单个参数字段超过该长度才截断，避免小文件写入被裁掉。 */
const ARG_FIELD_LIMIT = 8000;
const ARG_KEEP = 1500;
/** 失败态嗅探窗口：头部覆盖 exit_code 在前的真实 shell 载荷，尾部兼容旧形状。 */
const TOOL_ERROR_HEAD_CHARS = 512;
const TOOL_ERROR_TAIL_CHARS = 500;

export function compactAdminTranscript(messages: Message[]): Message[] {
  return messages.map((message) => {
    const role = (message.role || '').toUpperCase();
    const patch: Partial<Message> = {};
    if (role === 'TOOL') {
      const content = compactToolResult(message.content);
      if (content !== message.content) patch.content = content;
    } else if (role === 'ASSISTANT' && typeof message.toolCalls === 'string') {
      const toolCalls = compactToolCalls(message.toolCalls);
      if (toolCalls !== message.toolCalls) patch.toolCalls = toolCalls;
    }
    const metadata = compactMetadata(message.metadata);
    if (metadata !== message.metadata) patch.metadata = metadata;
    return Object.keys(patch).length === 0 ? message : { ...message, ...patch };
  });
}

/**
 * 管理端紧凑载荷：工具附件里的图片 base64（data_uri）不随消息列表返回。
 *
 * 一条 1800×1200 的截图 base64 约 350–500KB，5 轮对话里几十张就能把响应撑到 13MB，
 * 而界面只在展开工具卡片时才看图。这里只保留 mime/path/附件下标，字节由
 * `GET /v1/admin/sessions/:id/messages/:messageId/attachments/:index` 按需取。
 */
export function compactMetadata(metadata: string | null | undefined): string | null | undefined {
  if (metadata == null || metadata.length === 0 || !metadata.includes('data_uri')) {
    return metadata;
  }
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return metadata;
    const root = parsed as Record<string, unknown>;
    if (!Array.isArray(root.attachments)) return metadata;
    let changed = false;
    root.attachments = root.attachments.map((att) => {
      if (att == null || typeof att !== 'object' || Array.isArray(att)) return att;
      const item = att as Record<string, unknown>;
      if (typeof item.data_uri !== 'string' || item.data_uri.length === 0) return att;
      changed = true;
      const { data_uri: _omitted, ...rest } = item;
      return rest;
    });
    return changed ? JSON.stringify(root) : metadata;
  } catch {
    return metadata;
  }
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
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    // 参数不是 JSON：才按纯文本截断（截断后不再合法，但原文本就不是 JSON）。
    return raw.slice(0, ARG_KEEP) + noteFor(raw.length);
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const record = obj as Record<string, unknown>;
    let changed = false;
    for (const [key, value] of Object.entries(record)) {
      if (typeof value !== 'string' || value.length <= ARG_FIELD_LIMIT) continue;
      record[key] = value.slice(0, ARG_KEEP) + noteFor(value.length);
      changed = true;
    }
    // 有顶层字段超限才压缩并重新序列化；无字段超限时原样返回——否则会把合法 JSON 截成非法片段，
    // 管理后台 parseToolArguments 解析失败会导致工具卡片「输入」面板整段消失。
    return changed ? JSON.stringify(record) : raw;
  }
  // JSON 合法但不是可压缩的普通对象（数组 / 标量）：原样返回，保持 JSON 合法。
  return raw;
}

/**
 * 只看结果的头尾，避免把文件正文里的 "error" 误判成失败。
 * 截断后客户端仍用这段前缀识别失败，不会把失败调用画成成功。
 *
 * 头尾都要看：shell 工具的真实载荷把 exit_code 放在第一个键（shell-session-tool.ts
 * formatResult），只扫尾部会让「失败 + 输出超长」的调用在 compact 后丢掉失败态。
 * exit_code 允许负数（超时/被 kill 为 -1），只排除 0。
 */
function isToolError(text: string): boolean {
  if (text.startsWith('Tool execution failed')) return true;
  const head = text.slice(0, TOOL_ERROR_HEAD_CHARS);
  if (/^\s*\{\s*"error"\s*:/.test(head)) return true;
  if (/^\s*\{\s*"success"\s*:\s*false\b/.test(head)) return true;
  const exitCode = /"exit_code"\s*:\s*(-?\d+)/;
  for (const segment of [head, text.slice(-TOOL_ERROR_TAIL_CHARS)]) {
    const matched = exitCode.exec(segment);
    if (matched != null && Number(matched[1]) !== 0) return true;
  }
  return false;
}
