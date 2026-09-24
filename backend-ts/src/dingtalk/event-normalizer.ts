import type { DingtalkChatType, DingtalkNormalizedMessage } from './types.js';

/** `---`：trim 后为 3 个及以上半角连字符或全角破折号。 */
export function isNewSessionCommand(text: string | null | undefined): boolean {
  return /^[-—]{3,}$/u.test((text ?? '').trim());
}

export function isInboundFileMessage(event: Pick<DingtalkNormalizedMessage, 'msgtype' | 'chatType'>): boolean {
  return event.chatType === 'p2p' && event.msgtype === 'file';
}

export function isUnsupportedMedia(event: Pick<DingtalkNormalizedMessage, 'msgtype' | 'chatType'>): 'p2p' | 'group' | null {
  if (event.msgtype !== 'audio' && event.msgtype !== 'video' && event.msgtype !== 'file') return null;
  if (event.chatType === 'group') return 'group';
  if (event.msgtype === 'audio' || event.msgtype === 'video') return 'p2p';
  return null;
}

export function normalizeDingtalkEvent(input: unknown): DingtalkNormalizedMessage | null {
  const root = asRecord(input);
  const messageId = firstString(root.msgId, root.msg_id);
  const conversationId = firstString(root.conversationId, root.conversation_id);
  const chatType = normalizeChatType(firstString(root.conversationType, root.conversation_type));
  if (messageId == null || conversationId == null || chatType == null) return null;

  const msgtype = firstString(root.msgtype, root.msgType) ?? 'text';
  const textNode = asRecord(root.text);
  const contentNode = asRecord(root.content);
  const rich = extractRich(root, contentNode);
  const rawText = firstString(textNode.content, contentNode.content, root.content, rich.text) ?? '';
  const downloadCodes = unique([
    ...rich.downloadCodes,
    ...codesFrom(contentNode),
    ...codesFrom(textNode),
  ]);
  const quoted = extractQuoted(textNode, root);
  return {
    chatType,
    conversationId,
    messageId,
    senderUserid: firstString(root.senderStaffId, root.sender_staff_id) ?? null,
    senderUnionId: firstString(root.senderUnionId, root.sender_union_id) ?? null,
    senderName: firstString(root.senderNick, root.sender_nick) ?? '未知用户',
    msgtype,
    text: cleanText(rawText),
    downloadCodes: msgtype === 'text' && rich.downloadCodes.length === 0 && codesFrom(contentNode).length === 0
      ? downloadCodes.filter((code) => code !== '')
      : downloadCodes,
    fileName: firstString(contentNode.fileName, contentNode.file_name, root.fileName) ?? null,
    quotedText: quoted,
    isInAtList: root.isInAtList === true || root.isInAtList === 'true' || chatType === 'p2p',
  };
}

function cleanText(raw: string): string {
  return raw.trim().replace(/^(?:@\S+\s+)+/, '').trim();
}

function extractRich(root: Record<string, unknown>, contentNode: Record<string, unknown>): { text: string; downloadCodes: string[] } {
  const list = firstArray(root.richText, contentNode.richText, asRecord(root.content).richText);
  if (list == null) return { text: '', downloadCodes: [] };
  const texts: string[] = [];
  const downloadCodes: string[] = [];
  for (const item of list) {
    const node = asRecord(item);
    const kind = firstString(node.type, node.msgType, node.msgtype) ?? (typeof node.text === 'string' ? 'text' : '');
    if (kind === 'picture' || kind === 'image' || node.downloadCode != null || node.pictureDownloadCode != null) {
      downloadCodes.push(...codesFrom(node));
    }
    const text = firstString(node.text, kind === 'text' ? node.content : undefined);
    if (text != null) texts.push(text);
  }
  return { text: texts.join(''), downloadCodes };
}

function extractQuoted(textNode: Record<string, unknown>, root: Record<string, unknown>): string | null {
  const reply = asRecord(textNode.repliedMsg ?? root.repliedMsg ?? root.quoteMessage ?? textNode.quoteMessage);
  if (Object.keys(reply).length === 0 && textNode.isReplyMsg !== true && root.isReplyMsg !== true) {
    const direct = firstString(root.quoteMessage, textNode.quoteMessage);
    return direct ?? null;
  }
  const nested = asRecord(reply.content);
  const text = firstString(
    nested.text,
    typeof reply.content === 'string' ? reply.content : undefined,
    reply.text,
    asRecord(reply.text).content,
  );
  return text != null && text.trim() !== '' ? text.trim() : null;
}

function codesFrom(node: Record<string, unknown>): string[] {
  return [firstString(node.downloadCode, node.download_code, node.pictureDownloadCode)].filter((v): v is string => v != null);
}

function normalizeChatType(value: string | undefined): DingtalkChatType | null {
  if (value === '1' || value === 'p2p') return 'p2p';
  if (value === '2' || value === 'group') return 'group';
  return null;
}

function firstArray(...values: unknown[]): unknown[] | null {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return null;
}

function asRecord(value: unknown): Record<string, any> {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value !== ''))];
}
