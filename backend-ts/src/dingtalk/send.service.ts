/** 企业机器人图片消息。photoURL 接受上传接口返回的 media_id。 */
export function imageMessageParam(mediaId: string): { msgKey: 'sampleImageMsg'; msgParam: string } {
  return { msgKey: 'sampleImageMsg', msgParam: JSON.stringify({ photoURL: mediaId }) };
}

export const DINGTALK_FILE_EXTENSIONS = ['xlsx', 'pdf', 'zip', 'rar', 'doc', 'docx'] as const;
export const DINGTALK_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const DINGTALK_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export function fileExtension(fileName: string): string {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function fileMessageParam(mediaId: string, fileName: string): { msgKey: 'sampleFile'; msgParam: string } | { error: string } {
  const fileType = fileExtension(fileName);
  if (!DINGTALK_FILE_EXTENSIONS.includes(fileType as typeof DINGTALK_FILE_EXTENSIONS[number])) {
    return { error: `钉钉文件仅支持 ${DINGTALK_FILE_EXTENSIONS.join('、')}` };
  }
  return { msgKey: 'sampleFile', msgParam: JSON.stringify({ mediaId, fileName, fileType }) };
}

export function limitReply(text: string, maxLength: number): { text: string; truncated: boolean } {
  const limit = Math.max(1, maxLength);
  if (text.length <= limit) return { text, truncated: false };
  const suffix = '…（回复过长已截断）';
  const room = Math.max(0, limit - suffix.length);
  return { text: `${text.slice(0, room)}${suffix}`, truncated: true };
}

export function markdownMessage(text: string, maxLength: number): { msgKey: 'sampleMarkdown'; msgParam: string } {
  const limited = limitReply(text, maxLength).text;
  const first = limited.split(/\r?\n/, 1)[0]?.trim() || 'Mao';
  const title = first.length > 40 ? `${first.slice(0, 40)}…` : first;
  return { msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title, text: limited }) };
}

export function isContentTooLong(status: number, body: string): boolean {
  if (status < 400) return false;
  return /过长|too long|exceed|length|msgParam/i.test(body);
}

export function bindingCardParam(url: string): { msgKey: 'sampleActionCard'; msgParam: string } {
  return {
    msgKey: 'sampleActionCard',
    msgParam: JSON.stringify({
      title: '绑定 Mao',
      text: '请先点击下方按钮完成账号绑定（3分钟内有效）。',
      singleTitle: '点我绑定',
      singleURL: url,
    }),
  };
}

export interface DingtalkSendTarget {
  chatType: 'p2p' | 'group';
  robotCode: string;
  userId?: string;
  conversationId?: string;
}

export interface DingtalkHttp {
  token(): Promise<string>;
  fetchImpl?: typeof fetch;
}

const OTO_URL = 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';
const GROUP_URL = 'https://api.dingtalk.com/v1.0/robot/groupMessages/send';

export async function sendDingtalkMessage(
  http: DingtalkHttp,
  target: DingtalkSendTarget,
  message: { msgKey: string; msgParam: string },
): Promise<{ ok: true } | { ok: false; reason: string; tooLong: boolean }> {
  const fetchImpl = http.fetchImpl ?? fetch;
  const token = await http.token();
  const body = target.chatType === 'group'
    ? {
      robotCode: target.robotCode,
      openConversationId: target.conversationId,
      msgKey: message.msgKey,
      msgParam: message.msgParam,
    }
    : {
      robotCode: target.robotCode,
      userIds: target.userId == null ? [] : [target.userId],
      msgKey: message.msgKey,
      msgParam: message.msgParam,
    };
  const response = await fetchImpl(target.chatType === 'group' ? GROUP_URL : OTO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed: { message?: string; code?: string; errcode?: number } = {};
  try { parsed = JSON.parse(raw) as typeof parsed; } catch { /* 非 JSON 按 HTTP 状态判断 */ }
  const failed = !response.ok
    || (parsed.code != null && parsed.code !== '' && parsed.code !== '0')
    || (parsed.errcode != null && parsed.errcode !== 0);
  if (!failed) return { ok: true };
  const reason = (parsed.message || raw || `HTTP ${response.status}`).slice(0, 300);
  return { ok: false, reason, tooLong: isContentTooLong(response.status, `${parsed.message ?? ''} ${raw}`) };
}

/** 默认按 maxLength 截断；接口报过长时降到 500 再试一次。 */
export async function sendDingtalkMarkdown(
  http: DingtalkHttp,
  target: DingtalkSendTarget,
  text: string,
  maxLength: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const first = await sendDingtalkMessage(http, target, markdownMessage(text, maxLength));
  if (first.ok) return { ok: true };
  if (!first.tooLong) return { ok: false, reason: first.reason };
  const second = await sendDingtalkMessage(http, target, markdownMessage(text, 500));
  return second.ok ? { ok: true } : { ok: false, reason: second.reason };
}
