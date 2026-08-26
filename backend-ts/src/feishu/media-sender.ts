import type * as Lark from '@larksuiteoapi/node-sdk';

/** 飞书媒体消息发送目标：私聊为用户身份（union_id/open_id），群聊为 chat_id。 */
export interface FeishuSendTarget {
  appId: string;
  receiveId: string;
  receiveIdType: 'union_id' | 'open_id' | 'chat_id';
}

/**
 * 由会话存储的 chat_id 解析发送目标：私聊会话存的是 `p2p:{用户身份}`，
 * 身份优先取事件 union_id（缺失时回退 open_id），群聊直接是 chat_id。
 */
export function feishuSendTargetOf(appId: string, chatId: string): FeishuSendTarget {
  const trimmed = chatId.trim();
  if (trimmed.startsWith('p2p:')) return { appId, receiveId: trimmed.slice(4), receiveIdType: 'union_id' };
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

/**
 * 私聊身份优先 union_id，但历史会话可能回退存过 open_id，两者同为 ou_ 前缀无法从形态区分；
 * 按 union_id 发送失败时按 open_id 重试一次，仍失败才报错。
 */
async function sendFeishuMediaMessage(
  client: Lark.Client,
  target: FeishuSendTarget,
  msgType: 'image' | 'file',
  content: string,
  label: string,
): Promise<void> {
  let failure = await sendMessageOnce(client, target, msgType, content);
  if (failure != null && target.receiveIdType === 'union_id') {
    failure = await sendMessageOnce(client, { ...target, receiveIdType: 'open_id' }, msgType, content);
  }
  if (failure != null) {
    throw new Error(`飞书${label}消息发送失败: code=${failure.code ?? 'unknown'}, msg=${failure.msg ?? 'no message'}`);
  }
}
