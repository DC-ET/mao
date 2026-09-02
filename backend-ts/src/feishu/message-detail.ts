import type * as Lark from '@larksuiteoapi/node-sdk';

/** 通过 im/v1/messages/{message_id} 拉取的消息详情（已归一化）。 */
export interface FeishuMessageDetail {
  messageId: string;
  parentId?: string | null;
  chatId?: string | null;
  msgType: string;
  /** 提取后的纯文本（text/post），媒体消息为占位文本。 */
  text: string;
  fileKey?: string | null;
  fileName?: string | null;
  senderId?: string | null;
  createTime?: string | null;
}

interface RawFeishuMessage {
  message_id?: string;
  parent_id?: string;
  chat_id?: string;
  msg_type?: string;
  body?: { content?: string };
  sender?: { id?: string };
  create_time?: string;
}

/**
 * 拉取单条消息详情。用于引用/回复消息内容预取，以及下载工具在群消息日志未命中时的兜底。
 */
export async function fetchFeishuMessageDetail(client: Lark.Client, messageId: string): Promise<FeishuMessageDetail | null> {
  const response = await client.request<{ code?: number; msg?: string; data?: { items?: RawFeishuMessage[] } }>({
    url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
    method: 'GET',
    params: { card_msg_content_type: 'user_card_content' },
  });
  if (Number(response.code ?? 0) !== 0) {
    throw new Error(`获取飞书消息失败: ${messageId}, msg: ${response.msg ?? JSON.stringify(response)}`);
  }
  const raw = response.data?.items?.[0];
  if (raw?.message_id == null) return null;
  const msgType = raw.msg_type ?? 'text';
  let content: Record<string, unknown> = {};
  try { content = raw.body?.content ? JSON.parse(raw.body.content) as Record<string, unknown> : {}; } catch { content = {}; }
  // sticker（表情包）消息的媒体键也是 file_key（实测 v3_ 前缀），仅 image 用 image_key。
  const mediaKey = msgType === 'image' ? 'image_key' : 'file_key';
  return {
    messageId: raw.message_id,
    parentId: raw.parent_id ?? null,
    chatId: raw.chat_id ?? null,
    msgType,
    text: describeMessageText(msgType, content, raw.message_id),
    fileKey: typeof content[mediaKey] === 'string' ? content[mediaKey] as string : null,
    fileName: typeof content.file_name === 'string' ? content.file_name as string : null,
    senderId: raw.sender?.id ?? null,
    createTime: raw.create_time ?? null,
  };
}

/** 消息类型 → 可读文本/占位符的单一实现：入站占位与引用消息预取共用，防止两套映射漂移。 */
export function describeMessageText(msgType: string, content: Record<string, unknown>, messageId: string): string {
  if (msgType === 'text') return typeof content.text === 'string' ? content.text : '';
  if (msgType === 'image') return `[图片 msg=${messageId}]`;
  if (msgType === 'file') return `[文件:${typeof content.file_name === 'string' ? content.file_name : '未知文件'} msg=${messageId}]`;
  if (msgType === 'audio') return `[语音 msg=${messageId}]`;
  if (msgType === 'media') return `[视频 msg=${messageId}]`;
  if (msgType === 'sticker') return `[表情包 msg=${messageId}]`;
  if (msgType === 'post') return extractPostText(content);
  if (msgType === 'interactive') return extractInteractiveText(content);
  return `[${msgType} msg=${messageId}]`;
}

/** 富文本（post）：递归收集 text / a / at 元素的文本。 */
function extractPostText(content: Record<string, unknown>): string {
  const title = typeof content.title === 'string' && content.title.trim() !== '' ? `${content.title}\n` : '';
  return title + collectText(content.content).trim();
}

function collectText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (node != null && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    // 图片/视频/表情输出占位符（而非丢弃），让 Agent 知道消息中存在媒体；
    // 图片本体由 downloadMedia / prewarmGroupImage 按 imageKeys 下载注入。
    if (record.tag === 'img') return ' [图片] ';
    if (record.tag === 'media') return ' [视频] ';
    if (record.tag === 'emotion') return ' ';
    const own = typeof record.text === 'string' ? record.text : '';
    return own + collectText(record.content);
  }
  return '';
}

/** 卡片消息（多为机器人回复）：遍历卡片 JSON 收集文本元素，失败退化为占位。 */
function extractInteractiveText(content: Record<string, unknown>): string {
  const parts: string[] = [];
  walkCardContent(content, parts);
  const text = parts.join(' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_#`>~-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? '[卡片消息]' : text.slice(0, 2000);
}

/**
 * 递归遍历卡片 JSON 提取文本。兼容两种卡片结构：
 * - 经典卡片（schema 1.0）：elements[] 下 div.text（lark_md/plain_text）与 markdown 元素的 content；
 * - 新版卡片（schema 2.0）：header.title.content 与 body.elements[] 下 markdown 元素的 content。
 */
function walkCardContent(node: unknown, parts: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) walkCardContent(item, parts);
    return;
  }
  if (node == null || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  const tag = typeof record.tag === 'string' ? record.tag : '';
  if (tag === 'img' || tag === 'media' || tag === 'emotion') return;
  if ((tag === 'markdown' || tag === 'lark_md' || tag === 'plain_text') && typeof record.content === 'string') {
    if (record.content.trim() !== '') parts.push(record.content);
    return;
  }
  if (typeof record.content === 'string' && record.content.trim() !== '') {
    parts.push(record.content);
    return;
  }
  if (typeof record.text === 'string' && record.text.trim() !== '') {
    parts.push(record.text);
    return;
  }
  for (const value of Object.values(record)) walkCardContent(value, parts);
}
