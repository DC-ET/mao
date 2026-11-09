import { existsSync, mkdirSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BaseTool } from '../tool.js';
import { asText, errorJson, parseObject, toJson } from '../json.js';
import { ImageFileSupport } from '../image-file-support.js';
import { loadSendFileBytes, type SendBytesSupport } from './send-file-bytes.js';
import type { PathSandbox } from '../../safety/path-sandbox.js';
import type { FeishuChannelTool } from '../feishu-channel-tool.js';
import type { FeishuSendTarget } from '../../../feishu/media-sender.js';
import { chatFilesDirOf } from '../../../feishu/chat-files.js';
import { harnessLog } from '../../log.js';

/** 会话 → 飞书 Bot 解析：返回该会话所属 bot 的 app_id；非飞书通道会话返回 null。 */
export interface FeishuChannelToolSupport {
  resolveBotAppId(sessionId: number | null): Promise<string | null>;
}

/** 会话 → 飞书发送目标解析与媒体发送（上传 + 发消息在实现侧一体完成）。 */
export interface FeishuMediaSendSupport {
  /** 返回当前会话对应的飞书用户/群聊发送目标；非飞书通道会话返回 null。 */
  resolveSendTarget(sessionId: number | null): Promise<FeishuSendTarget | null>;
  sendImage(target: FeishuSendTarget, image: Buffer, sessionId?: number | null): Promise<void>;
  sendFile(target: FeishuSendTarget, fileName: string, file: Buffer, sessionId?: number | null): Promise<void>;
}

const MAX_FEISHU_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FEISHU_FILE_BYTES = 30 * 1024 * 1024;
const ALLOWED_FEISHU_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export interface FeishuMediaDownloadResult {
  buffer: Buffer;
  contentType: string;
}

export interface FeishuMediaDownloader {
  download(appId: string, messageId: string, fileKey: string, type: 'image' | 'file', maxBytes: number): Promise<FeishuMediaDownloadResult>;
}

/** 群消息媒体元数据查询（按消息 ID 定位待下载的文件）。 */
export interface FeishuGroupMediaLookup {
  findMediaByMessageId(messageId: string): Promise<{ appId: string; fileKey: string | null; fileName: string | null; msgType: string | null } | null>;
}

/** 消息详情 API 兜底：群消息日志未命中时（如引用机器人发的文件、p2p 消息）获取文件元数据。 */
export interface FeishuMessageDetailFetcher {
  fetchMessageDetail(appId: string, messageId: string): Promise<{
    fileKey: string | null;
    fileName: string | null;
    msgType: string;
    /** post 多文件消息（一次发多个文件）的全部文件；单文件消息为 null。 */
    postFiles?: Array<{ fileKey: string; fileName: string | null }> | null;
  } | null>;
}

/**
 * 资源 key 的图片判定：msgType 已归一为 image（post 内嵌图片经详情接口时）、或 key 形如 img_v2_/img_v3_（兜底），
 * 或来自群日志的 post 行——recordGroupMessage 的 file_key 列只写 context.imageKey（从不写 postFiles/顶层 fileKey），
 * 该列有值即图片。sticker 的 v3_ 前缀键不是图片资源（平台不支持下载，另有前置报错）。
 */
function isImageResourceKey(fileKey: string, msgType: string | null): boolean {
  if (msgType === 'image' || msgType === 'post') return true;
  return fileKey.startsWith('img_');
}

/**
 * 机器人没有该消息的阅读权限时（不在会话，或资源挂在合并转发子消息上），飞书返回 230002 / 234003，
 * bot 身份无解；但当前用户自己的身份往往可见。失败信息里附上改用 lark-cli 的操作提示，
 * 免得 Agent 只看到一串错误码就放弃或盲目重试。
 */
function withLarkCliFallbackHint(message: string): string {
  if (!/230002|234003/.test(message)) return message;
  return `${message}\n提示：机器人没有该消息的阅读权限（不在该会话，或该资源属于合并转发的子消息，code=230002/234003），bot 身份无法下载。`
    + '可改用 lark-cli 以当前用户身份下载：lark-cli im +messages-mget --message-ids <消息ID> --download-resources'
    + '（保存到 lark-im-resources/ 目录；合并转发的子消息请改用外层合并转发消息 ID，拿不到外层 ID 时可请用户重新发送该文件；前提是当前用户对该消息可见）。';
}

function sanitizeFileName(name: string | null | undefined, fallback: string): string {
  const raw = (name ?? '').trim();
  if (raw === '') return fallback;
  const basename = raw.replace(/\\/g, '/').split('/').pop() ?? fallback;
  const cleaned = basename.replace(/[^\w.\u4e00-\u9fa5-]/g, '_').replace(/^_+|_+$/g, '');
  return cleaned === '' ? fallback : cleaned.length > 128 ? cleaned.slice(0, 128) : cleaned;
}

function imageExtensionOf(contentType: string): string {
  const mime = contentType.toLowerCase();
  if (mime.includes('png')) return '.png';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('bmp')) return '.bmp';
  return '.jpg';
}

function extnameOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot) : '';
}

export class FeishuDownloadFileTool extends BaseTool implements FeishuChannelTool {
  readonly feishuChannelTool = true as const;

  constructor(
    private readonly support: FeishuChannelToolSupport,
    private readonly mediaLookup: FeishuGroupMediaLookup,
    private readonly downloader: FeishuMediaDownloader,
    private readonly maxBytes: number,
    private readonly detailFetcher?: FeishuMessageDetailFetcher,
  ) { super(); }

  getName(): string { return 'feishu_download_file'; }
  getDescription(): string {
    return '下载飞书群聊消息中的文件或图片到当前会话工作区（仅飞书通道会话可用，按需懒加载）。群聊上下文中形如 [文件:xxx msg=om_xxx] 或 [图片 msg=om_xxx] 的占位消息，将其中的消息 ID 传入 message_id 即可下载；一次发送多个文件的占位形如 [文件:xxx msg=om_xxx file_key=file_v3_xxx]，把 file_key 一并传入可精确下载其中一个，不传则下载该消息的全部文件。返回本地路径后可用 read_file 读取内容（图片可直接查看）。注意：飞书平台暂不支持下载表情包（sticker）资源，此类消息无法获取图片本体。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: '群聊消息 ID，取自上下文占位符中 msg= 之后的值（如 om_xxx）' },
        file_key: { type: 'string', description: '可选：多文件消息中的文件 key，取自占位符 file_key= 之后的值；指定后只下载该文件，不传则下载消息中的全部文件' },
      },
      required: ['message_id'],
    };
  }
  getOutputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        path: { type: 'string', description: '下载后的本地文件路径（多文件时为第一个）' },
        paths: { type: 'array', items: { type: 'string' }, description: '下载后的全部本地文件路径（多文件消息）' },
        failures: { type: 'array', items: { type: 'string' }, description: '多文件消息中失败文件的原因列表（部分成功时出现）' },
      },
    };
  }

  protected override async executeWithUser(argumentsJson: string, sessionId: number | null, userId: number | null, workspace: string | null): Promise<string> {
    try {
      const args = parseObject(argumentsJson) ?? {};
      const messageId = asText(args.message_id);
      const requestedFileKey = asText(args.file_key);
      if (!messageId) return errorJson('缺少必填参数: message_id');
      if (!workspace) return errorJson('当前会话没有可用的工作区，无法下载文件');
      const appId = await this.support.resolveBotAppId(sessionId);
      if (!appId) return errorJson('当前会话不是飞书通道会话，无法下载飞书文件');
      let items: Array<{ fileKey: string; fileName: string | null }> = [];
      let msgType: string | null = null;
      // 资源类型判定：post.files 恒为文件；其余按来源（msgType 已归一 / key 前缀）推断，避免对 file_key 用 type=image。
      let imageKeyCandidate = false;
      if (requestedFileKey != null && requestedFileKey !== '') {
        // 多文件消息（占位符带 file_key=）按指定 key 精确下载；回查详情的同 fileKey 项补文件名（落盘扩展名用），失败不影响下载。
        items = [{ fileKey: requestedFileKey, fileName: null }];
        imageKeyCandidate = isImageResourceKey(requestedFileKey, null);
        try {
          const detail = await this.detailFetcher?.fetchMessageDetail(appId, messageId) ?? null;
          const matched = detail?.postFiles?.find((file) => file.fileKey === requestedFileKey);
          const named = matched?.fileName ?? (detail?.fileKey === requestedFileKey ? detail.fileName : null);
          if (named != null && named !== '') items[0].fileName = named;
        } catch (error) {
          harnessLog('warn', 'feishu_download_file 文件名回查失败', error);
        }
      } else {
        const media = await this.mediaLookup.findMediaByMessageId(messageId);
        msgType = media?.msgType ?? null;
        if (media?.fileKey != null) {
          items = [{ fileKey: media.fileKey, fileName: media.fileName }];
          imageKeyCandidate = isImageResourceKey(media.fileKey, media.msgType);
        } else {
          // 日志未命中（如引用机器人发的文件、p2p 消息、一次发多个文件的 post）：详情 API 兜底获取。
          const detail = await this.detailFetcher?.fetchMessageDetail(appId, messageId) ?? null;
          if (detail != null) {
            msgType = detail.msgType;
            if (detail.postFiles != null && detail.postFiles.length > 0) {
              items = detail.postFiles;
            } else if (detail.fileKey != null) {
              items = [{ fileKey: detail.fileKey, fileName: detail.fileName ?? null }];
              imageKeyCandidate = isImageResourceKey(detail.fileKey, detail.msgType);
            }
          }
          if (items.length === 0) return errorJson(`未找到包含文件/图片的群聊消息: ${messageId}`);
        }
      }
      // 飞书开放平台暂不支持表情包资源下载（resources 接口返回空占位/500），直接明确报错。
      if (msgType === 'sticker') return errorJson(`飞书平台暂不支持下载表情包资源，无法获取该表情包图片: ${messageId}`);
      const isImage = imageKeyCandidate && items.length === 1;
      const dir = chatFilesDirOf(workspace);
      mkdirSync(dir, { recursive: true });
      const suffix = messageId.slice(-8);
      const downloaded: string[] = [];
      const failures: string[] = [];
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        try {
          const { buffer, contentType } = await this.downloader.download(
            appId, messageId, item.fileKey, isImage ? 'image' : 'file', this.maxBytes,
          );
          if (buffer.length === 0) {
            // 单文件保持原有错误语义（调用方/用例依赖该文案），多文件聚合到 failures。
            if (items.length === 1) return errorJson('文件下载失败：内容为空（可能已过期或无权限）');
            failures.push(`${item.fileName ?? item.fileKey}: 内容为空（可能已过期或无权限）`);
            continue;
          }
          const fallback = `feishu-${isImage ? 'img' : 'file'}-${suffix}`;
          const baseName = sanitizeFileName(isImage ? null : item.fileName, fallback);
          const ext = isImage ? imageExtensionOf(contentType) : extnameOf(baseName);
          const stem = isImage ? baseName : baseName.slice(0, baseName.length - ext.length);
          // 多文件消息的同一批次内文件重名（或与历史文件重名）时递增避让，不覆盖既有文件。
          const indexSuffix = items.length > 1 ? `-${index + 1}` : '';
          let target = resolve(dir, `${stem}${ext}`);
          if (existsSync(target)) target = resolve(dir, `${stem}-${suffix}${indexSuffix}${ext}`);
          for (let n = 2; existsSync(target); n++) {
            target = resolve(dir, `${stem}-${suffix}${indexSuffix}-${n}${ext}`);
          }
          await writeFile(target, buffer);
          downloaded.push(target);
        } catch (e) {
          // 单文件直接把原始错误交给外层（含 lark-cli 兜底提示）；多文件逐项聚合，不因一个失败丢其余结果。
          if (items.length === 1) throw e;
          failures.push(`${item.fileName ?? item.fileKey}: ${(e as Error).message}`);
        }
      }
      if (downloaded.length === 0) {
        const detailText = failures.length > 0 ? failures.join('；') : '内容为空（可能已过期或无权限）';
        return errorJson(withLarkCliFallbackHint(`文件下载失败：${detailText}`));
      }
      return toJson({
        success: true,
        path: downloaded[0],
        paths: downloaded,
        ...(failures.length > 0 ? { failures } : {}),
      });
    } catch (e) {
      harnessLog('warn', 'feishu_download_file failed', e);
      return errorJson(withLarkCliFallbackHint((e as Error).message));
    }
  }
}

export class SendFeishuImageTool extends BaseTool implements FeishuChannelTool {
  readonly feishuChannelTool = true as const;

  constructor(
    private readonly pathSandbox: PathSandbox,
    private readonly support: FeishuMediaSendSupport,
    private readonly sendBytesSupport?: SendBytesSupport | null,
  ) { super(); }

  getName(): string { return 'feishu_send_image'; }
  getDescription(): string {
    return '向当前会话对应的飞书用户或群聊发送一张图片（仅飞书通道会话可用，私聊发给该用户、群聊发到该群）。支持本地文件路径（工作区相对路径，或允许集内的绝对路径：会话工作区、本人 uploads/{userId} 产物目录、runtime、HOME、/tmp）或 http(s) 图片 URL；仅支持 PNG/JPG/JPEG/GIF/WebP，大小不超过 10MB。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        image: { type: 'string', description: '要发送的图片：本地文件路径（工作区相对路径，或允许集内的绝对路径：会话工作区、本人 uploads/{userId} 产物目录、runtime、HOME、/tmp），或 http(s) 图片 URL' },
      },
      required: ['image'],
    };
  }
  getOutputSchema(): Record<string, unknown> {
    return { type: 'object', properties: { success: { type: 'boolean' } } };
  }

  protected override async executeWithUser(argumentsJson: string, sessionId: number | null, userId: number | null, workspace: string | null): Promise<string> {
    try {
      const args = parseObject(argumentsJson) ?? {};
      const image = asText(args.image);
      if (!image) return errorJson('缺少必填参数: image');
      const target = await this.support.resolveSendTarget(sessionId);
      if (!target) return errorJson('当前会话不是飞书通道会话，无法发送飞书图片');
      const bytes = await loadSendFileBytes(image, this.pathSandbox, this.sendBytesSupport ?? null, { userId, sessionId, workspace }, MAX_FEISHU_IMAGE_BYTES);
      if (bytes.length === 0) return errorJson('图片内容为空');
      if (bytes.length > MAX_FEISHU_IMAGE_BYTES) return errorJson('图片超过 10MB 上限');
      const mime = ImageFileSupport.detectMimeFromBytes(bytes);
      if (!mime || !ALLOWED_FEISHU_IMAGE_MIMES.has(mime)) return errorJson('不支持的图片格式，仅支持 PNG/JPG/JPEG/GIF/WebP');
      await this.support.sendImage(target, bytes, sessionId);
      return toJson({ success: true });
    } catch (e) {
      harnessLog('warn', 'feishu_send_image failed', e);
      return errorJson((e as Error).message);
    }
  }
}

export class SendFeishuFileTool extends BaseTool implements FeishuChannelTool {
  readonly feishuChannelTool = true as const;

  constructor(
    private readonly pathSandbox: PathSandbox,
    private readonly support: FeishuMediaSendSupport,
    private readonly sendBytesSupport?: SendBytesSupport | null,
  ) { super(); }

  getName(): string { return 'feishu_send_file'; }
  getDescription(): string {
    return '向当前会话对应的飞书用户或群聊发送一份文件（仅飞书通道会话可用，私聊发给该用户、群聊发到该群）。支持本地文件路径（工作区相对路径，或允许集内的绝对路径：会话工作区、本人 uploads/{userId} 产物目录、runtime、HOME、/tmp）或 http(s) URL，大小不超过 30MB。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        file: { type: 'string', description: '要发送的文件：本地文件路径（工作区相对路径，或允许集内的绝对路径：会话工作区、本人 uploads/{userId} 产物目录、runtime、HOME、/tmp），或 http(s) URL' },
        filename: { type: 'string', description: '可选，发送到飞书时展示的文件名，默认取路径 basename' },
      },
      required: ['file'],
    };
  }
  getOutputSchema(): Record<string, unknown> {
    return { type: 'object', properties: { success: { type: 'boolean' } } };
  }

  protected override async executeWithUser(argumentsJson: string, sessionId: number | null, userId: number | null, workspace: string | null): Promise<string> {
    try {
      const args = parseObject(argumentsJson) ?? {};
      const file = asText(args.file);
      if (!file) return errorJson('缺少必填参数: file');
      const target = await this.support.resolveSendTarget(sessionId);
      if (!target) return errorJson('当前会话不是飞书通道会话，无法发送飞书文件');
      const bytes = await loadSendFileBytes(file, this.pathSandbox, this.sendBytesSupport ?? null, { userId, sessionId, workspace }, MAX_FEISHU_FILE_BYTES);
      if (bytes.length === 0) return errorJson('文件内容为空');
      if (bytes.length > MAX_FEISHU_FILE_BYTES) return errorJson('文件超过 30MB 上限');
      const fileName = asText(args.filename) || file.replace(/\\/g, '/').split('/').pop() || 'file';
      await this.support.sendFile(target, fileName, bytes, sessionId);
      return toJson({ success: true });
    } catch (e) {
      harnessLog('warn', 'feishu_send_file failed', e);
      return errorJson((e as Error).message);
    }
  }
}
