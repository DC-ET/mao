import type { FeishuChatType, FeishuEventHeader, FeishuNormalizedMessage } from './types.js';

export function normalizeFeishuEvent(input: unknown, botOpenId?: string): FeishuNormalizedMessage | null {
  const root = asRecord(input);
  // Lark SDK 的 EventDispatcher 会把 v2 事件的 header/event 展开到顶层（无 header 对象），
  // 因此同时兼容标准信封格式（root.header）与 SDK 展开格式（root.app_id / root.event_id ...）。
  const header = normalizeHeader(root.header) ?? normalizeHeader(root);
  const event = asRecord(root.event ?? root);
  const message = asRecord(event.message);
  if (Object.keys(message).length === 0 && typeof event.message !== 'object') return null;

  const sender = asRecord(event.sender);
  const senderId = firstString(asRecord(sender.sender_id).open_id, asRecord(sender.sender_id).user_id, sender.open_id, event.open_id);
  const senderUnionId = firstString(asRecord(sender.sender_id).union_id, sender.union_id, event.union_id);
  const chatType = normalizeChatType(firstString(message.chat_type, event.chat_type));
  const content = parseContent(message.content ?? event.content);
  const mentionItems = extractMentionItems(message.mentions ?? event.mentions);
  const mentions = mentionItems.map((item) => item.id ?? item.key).filter((id): id is string => id != null);
  const appId = header?.appId ?? null;
  // 飞书 im.message.receive_v1 事件体不含 is_at_me 字段，群聊 @机器人必须通过
  // mentions 中携带的身份确认。识别顺序（宁可误触发不可漏触发）：
  // 1. mention key 直接等于应用 id（cli_xxx，旧格式）；
  // 2. botOpenId（/bot/v3/info 获取）与 mention 的 open_id/union_id/key 精确匹配；
  // 3. mentioned_type 标记为 bot/app 的提及：仅当 key 是其他应用的 cli_ id 时才排除，
  //    否则视为命中——线上曾出现 botOpenId 与 mention id 形态不一致导致 @机器人全部漏判；
  // 4. 仅当 app_id 缺失（极端格式）时，以 key 的 cli_ 前缀作为兜底。
  const isBotMentioned = mentionItems.some((item) => {
    if (appId != null && item.key === appId) return true;
    if (botOpenId != null && (item.id === botOpenId || item.unionId === botOpenId || item.key === botOpenId)) return true;
    if (item.mentionedType === 'bot' || item.mentionedType === 'app') {
      if (appId != null && item.key != null && item.key.startsWith('cli_')) return item.key === appId;
      return true;
    }
    if (appId == null) return item.key != null && item.key.startsWith('cli_');
    return false;
  }) || (isStrictTrue(message.is_at_me ?? event.is_at_me) && mentions.length > 0);
  const messageType = firstString(message.message_type, event.message_type) ?? 'text';
  const media = extractMedia(messageType, content);
  return {
    eventId: firstString(header?.eventId, root.event_id, event.event_id) ?? null,
    messageId: firstString(message.message_id, event.message_id) ?? null,
    parentId: firstString(message.parent_id, event.parent_id) ?? null,
    rootId: firstString(message.root_id, event.root_id) ?? null,
    chatId: firstString(message.chat_id, event.chat_id) ?? null,
    chatType,
    senderId: senderId ?? null,
    senderUnionId: senderUnionId ?? null,
    senderType: firstString(sender.sender_type, event.sender_type) ?? null,
    messageType,
    imageKey: media.imageKey ?? null,
    fileKey: media.fileKey ?? null,
    fileName: media.fileName ?? null,
    // 文本中的 @提及 是 @_user_N 占位符，需用 mentions 的姓名还原，否则 Agent 不知道 @ 的是谁。
    text: replaceMentionKeys(extractText(content, message.text ?? event.text), mentionItems),
    mentions,
    isBotMentioned,
    content,
    rawEvent: input,
    header,
  };
}

function normalizeHeader(value: unknown): FeishuEventHeader | undefined {
  const h = asRecord(value);
  if (Object.keys(h).length === 0) return undefined;
  return {
    eventId: firstString(h.event_id), eventType: firstString(h.event_type), createTime: firstString(h.create_time),
    tenantKey: firstString(h.tenant_key), appId: firstString(h.app_id), token: firstString(h.token),
  };
}

function normalizeChatType(value: string | undefined): FeishuChatType {
  if (value === 'p2p' || value === 'private') return 'p2p';
  if (value === 'group') return 'group';
  return 'unknown';
}

function parseContent(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try { return JSON.parse(value); } catch { return value; }
}

function extractText(content: unknown, fallback: unknown): string {
  if (typeof content === 'string') return content;
  const record = asRecord(content);
  return firstString(record.text, fallback) ?? '';
}

interface MentionItem { key?: string | null; id?: string | null; unionId?: string | null; name?: string | null; mentionedType?: string | null; }

function extractMentionItems(value: unknown): MentionItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    const id = asRecord(record.id);
    return {
      key: firstString(record.key),
      id: firstString(id.open_id, id.user_id, record.id),
      unionId: firstString(id.union_id),
      name: firstString(record.name),
      mentionedType: firstString(record.mentioned_type),
    };
  });
}

/** 将文本中的 @_user_N 占位符替换为 @姓名（含 @机器人），还原真实提及对象。 */
function replaceMentionKeys(text: string, mentionItems: MentionItem[]): string {
  if (text === '' || mentionItems.length === 0) return text;
  let replaced = text;
  for (const item of mentionItems) {
    if (item.key == null || item.key === '' || item.name == null || item.name === '') continue;
    replaced = replaced.split(item.key).join(`@${item.name}`);
  }
  return replaced;
}

function extractMedia(messageType: string, content: unknown): { imageKey?: string; fileKey?: string; fileName?: string } {
  const record = asRecord(content);
  if (messageType === 'image') return { imageKey: firstString(record.image_key) };
  if (messageType === 'file') return { fileKey: firstString(record.file_key), fileName: firstString(record.file_name) };
  return {};
}

function asRecord(value: unknown): Record<string, any> {
  return value != null && typeof value === 'object' ? value as Record<string, any> : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function isStrictTrue(value: unknown): boolean {
  return value === true;
}
