import type * as Lark from '@larksuiteoapi/node-sdk';

/** 飞书媒体消息发送目标：私聊为用户身份（union_id/open_id），群聊为 chat_id。 */
export interface FeishuSendTarget {
  appId: string;
  receiveId: string;
  receiveIdType: 'union_id' | 'open_id' | 'chat_id';
}

/**
 * 由会话存储的 chat_id 解析发送目标。
 * 私聊会话的身份形态在建会话时就已确定，直接编码进 chat_id 前缀：
 * - `p2p:union:{union_id}`：事件携带 union_id（常态）；
 * - `p2p:open:{open_id}`：事件缺失 union_id 时的回退；
 * 群聊 chat_id 直接是 oc_ 开头的群 ID。发送侧不做任何"猜身份重试"。
 * `p2p:{裸身份}` 为升级前的历史键（无法区分 union/open），显式报错而非误当群聊发送。
 */
export function feishuSendTargetOf(appId: string, chatId: string): FeishuSendTarget {
  const trimmed = chatId.trim();
  if (trimmed.startsWith('p2p:union:')) return { appId, receiveId: trimmed.slice('p2p:union:'.length), receiveIdType: 'union_id' };
  if (trimmed.startsWith('p2p:open:')) return { appId, receiveId: trimmed.slice('p2p:open:'.length), receiveIdType: 'open_id' };
  if (trimmed.startsWith('p2p:')) throw new Error(`飞书私聊发送目标缺少身份类型前缀（需重建私聊会话）: ${chatId}`);
  return { appId, receiveId: trimmed, receiveIdType: 'chat_id' };
}

/** 上传图片并作为图片消息发送到目标会话（图片 ≤10MB，支持 PNG/JPEG/GIF/WebP/BMP）。 */
export async function sendFeishuImage(client: Lark.Client, target: FeishuSendTarget, image: Buffer): Promise<void> {
  const response = await client.im.v1.image.create({ data: { image_type: 'message', image } });
  const imageKey = response?.image_key;
  if (imageKey == null || imageKey === '') throw new Error('飞书图片上传失败，请检查机器人权限与图片格式');
  await sendFeishuMediaMessage(client, target, 'image', JSON.stringify({ image_key: imageKey }), '图片');
}

/** 上传文件并作为文件消息发送到目标会话（文件 ≤30MB）。 */
export async function sendFeishuFile(client: Lark.Client, target: FeishuSendTarget, fileName: string, file: Buffer): Promise<void> {
  const baseName = fileName.replace(/\\/g, '/').split('/').pop()?.trim() || 'file';
  const response = await client.im.v1.file.create({
    data: { file_type: feishuFileTypeOf(baseName), file_name: baseName, file },
  });
  const fileKey = response?.file_key;
  if (fileKey == null || fileKey === '') throw new Error('飞书文件上传失败，请检查机器人权限与文件大小');
  await sendFeishuMediaMessage(client, target, 'file', JSON.stringify({ file_key: fileKey }), '文件');
}

/** 飞书文件上传的 file_type 枚举映射，未知扩展名归入 stream。 */
export function feishuFileTypeOf(fileName: string): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'opus') return 'opus';
  if (ext === 'mp4') return 'mp4';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'doc' || ext === 'docx') return 'doc';
  if (ext === 'xls' || ext === 'xlsx') return 'xls';
  if (ext === 'ppt' || ext === 'pptx') return 'ppt';
  return 'stream';
}

type MessageCreateFailure = { code?: number; msg?: string };

async function sendMessageOnce(
  client: Lark.Client,
  target: FeishuSendTarget,
  msgType: 'image' | 'file',
  content: string,
): Promise<MessageCreateFailure | null> {
  const response = await client.im.v1.message.create({
    params: { receive_id_type: target.receiveIdType },
    data: { receive_id: target.receiveId, msg_type: msgType, content },
  });
  return Number(response.code ?? 0) === 0 ? null : { code: response.code, msg: response.msg };
}

/** 发送媒体消息；receiveIdType 在建会话时已随 chat_id 前缀确定，失败即抛出真实错误码。 */
async function sendFeishuMediaMessage(
  client: Lark.Client,
  target: FeishuSendTarget,
  msgType: 'image' | 'file',
  content: string,
  label: string,
): Promise<void> {
  const failure = await sendMessageOnce(client, target, msgType, content);
  if (failure != null) {
    throw new Error(`飞书${label}消息发送失败: code=${failure.code ?? 'unknown'}, msg=${failure.msg ?? 'no message'}`);
  }
}
