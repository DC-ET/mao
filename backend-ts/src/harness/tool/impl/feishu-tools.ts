import { existsSync, mkdirSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { resolve } from 'node:path';
import { BaseTool } from '../tool.js';
import { asText, errorJson, parseObject, toJson } from '../json.js';
import { ImageFileSupport } from '../image-file-support.js';
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
  sendImage(target: FeishuSendTarget, image: Buffer): Promise<void>;
  sendFile(target: FeishuSendTarget, fileName: string, file: Buffer): Promise<void>;
}

const MAX_FEISHU_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FEISHU_FILE_BYTES = 30 * 1024 * 1024;
const ALLOWED_FEISHU_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export interface FeishuDocReader {
  readMarkdown(appId: string, link: string): Promise<string>;
}

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

/** 消息详情 API 兜底：群消息日志未命中时（如引用机器人发的文件）获取文件元数据。 */
export interface FeishuMessageDetailFetcher {
  fetchMessageDetail(appId: string, messageId: string): Promise<{ fileKey: string | null; fileName: string | null; msgType: string } | null>;
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

export class ReadFeishuDocTool extends BaseTool implements FeishuChannelTool {
  readonly feishuChannelTool = true as const;

  constructor(private readonly support: FeishuChannelToolSupport, private readonly docReader: FeishuDocReader) { super(); }

  getName(): string { return 'feishu_read_doc'; }
  getDescription(): string {
    return '读取飞书云文档正文（仅飞书通道会话可用）。传入飞书文档链接（支持 wiki / docx / base 类型，如 https://access.feishu.cn/wiki/xxx），返回 Markdown 格式正文。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        link: { type: 'string', description: '飞书云文档完整链接，如 https://access.feishu.cn/wiki/xxx' },
      },
      required: ['link'],
    };
  }
  getOutputSchema(): Record<string, unknown> {
    return { type: 'object', properties: { content: { type: 'string', description: '文档 Markdown 正文' } } };
  }

  protected override async executeWithUser(argumentsJson: string, sessionId: number | null, _userId: number | null, _workspace: string | null): Promise<string> {
    try {
      const args = parseObject(argumentsJson) ?? {};
      const link = asText(args.link);
      if (!link) return errorJson('缺少必填参数: link');
      const appId = await this.support.resolveBotAppId(sessionId);
      if (!appId) return errorJson('当前会话不是飞书通道会话，无法读取飞书文档');
      const content = await this.docReader.readMarkdown(appId, link);
      return toJson({ content });
    } catch (e) {
      harnessLog('warn', 'feishu_read_doc failed', e);
      return errorJson((e as Error).message);
    }
  }
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
    return '下载飞书群聊消息中的文件或图片到当前会话工作区（仅飞书通道会话可用，按需懒加载）。群聊上下文中形如 [文件:xxx msg=om_xxx] 或 [图片 msg=om_xxx] 的占位消息，将其中的消息 ID 传入 message_id 即可下载；返回本地路径后可用 read_file 读取内容（图片可直接查看）。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: '群聊消息 ID，取自上下文占位符中 msg= 之后的值（如 om_xxx）' },
      },
      required: ['message_id'],
    };
  }
  getOutputSchema(): Record<string, unknown> {
    return { type: 'object', properties: { success: { type: 'boolean' }, path: { type: 'string', description: '下载后的本地文件路径' } } };
  }

  protected override async executeWithUser(argumentsJson: string, sessionId: number | null, _userId: number | null, workspace: string | null): Promise<string> {
    try {
      const args = parseObject(argumentsJson) ?? {};
      const messageId = asText(args.message_id);
      if (!messageId) return errorJson('缺少必填参数: message_id');
      if (!workspace) return errorJson('当前会话没有可用的工作区，无法下载文件');
      const appId = await this.support.resolveBotAppId(sessionId);
      if (!appId) return errorJson('当前会话不是飞书通道会话，无法下载飞书文件');
      let media = await this.mediaLookup.findMediaByMessageId(messageId);
      if (media == null || media.fileKey == null) {
        // 日志未命中（如引用的是机器人发的文件）：通过消息详情 API 兜底获取 file_key。
        const detail = await this.detailFetcher?.fetchMessageDetail(appId, messageId) ?? null;
        if (detail?.fileKey == null) return errorJson(`未找到包含文件/图片的群聊消息: ${messageId}`);
        media = { appId, fileKey: detail.fileKey, fileName: detail.fileName ?? null, msgType: detail.msgType };
      }
      const isImage = media.msgType === 'image';
      const fileKey = media.fileKey;
      if (fileKey == null) return errorJson(`未找到包含文件/图片的群聊消息: ${messageId}`);
      const { buffer, contentType } = await this.downloader.download(
        media.appId, messageId, fileKey, isImage ? 'image' : 'file', this.maxBytes,
      );
      if (buffer.length === 0) return errorJson('文件下载失败：内容为空（可能已过期或无权限）');
      const dir = chatFilesDirOf(workspace);
      mkdirSync(dir, { recursive: true });
      const suffix = messageId.slice(-8);
      const fallback = `feishu-${isImage ? 'img' : 'file'}-${suffix}`;
      const baseName = sanitizeFileName(isImage ? null : media.fileName, fallback);
      const ext = isImage ? imageExtensionOf(contentType) : extnameOf(baseName);
      const stem = isImage ? baseName : baseName.slice(0, baseName.length - ext.length);
      let target = resolve(dir, `${stem}${ext}`);
      if (existsSync(target)) target = resolve(dir, `${stem}-${suffix}${ext}`);
      await writeFile(target, buffer);
      return toJson({ success: true, path: target });
    } catch (e) {
      harnessLog('warn', 'feishu_download_file failed', e);
      return errorJson((e as Error).message);
    }
  }
}

export class SendFeishuImageTool extends BaseTool implements FeishuChannelTool {
  readonly feishuChannelTool = true as const;

  constructor(
    private readonly pathSandbox: PathSandbox,
    private readonly support: FeishuMediaSendSupport,
  ) { super(); }

  getName(): string { return 'feishu_send_image'; }
  getDescription(): string {
    return '向当前会话对应的飞书用户或群聊发送一张图片（仅飞书通道会话可用，私聊发给该用户、群聊发到该群）。支持本地文件路径（绝对路径或会话工作区相对路径）或 http(s) 图片 URL；仅支持 PNG/JPG/JPEG/GIF/WebP，大小不超过 10MB。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        image: { type: 'string', description: '要发送的图片：本地文件路径（绝对路径或工作区相对路径），或 http(s) 图片 URL' },
      },
      required: ['image'],
    };
  }
  getOutputSchema(): Record<string, unknown> {
    return { type: 'object', properties: { success: { type: 'boolean' } } };
  }

  protected override async executeWithUser(argumentsJson: string, sessionId: number | null, _userId: number | null, workspace: string | null): Promise<string> {
    try {
      const args = parseObject(argumentsJson) ?? {};
      const image = asText(args.image);
      if (!image) return errorJson('缺少必填参数: image');
      const target = await this.support.resolveSendTarget(sessionId);
      if (!target) return errorJson('当前会话不是飞书通道会话，无法发送飞书图片');
      const bytes = await loadBytes(image, this.pathSandbox, workspace);
      if (bytes.length === 0) return errorJson('图片内容为空');
      if (bytes.length > MAX_FEISHU_IMAGE_BYTES) return errorJson('图片超过 10MB 上限');
      const mime = ImageFileSupport.detectMimeFromBytes(bytes);
      if (!mime || !ALLOWED_FEISHU_IMAGE_MIMES.has(mime)) return errorJson('不支持的图片格式，仅支持 PNG/JPG/JPEG/GIF/WebP');
      await this.support.sendImage(target, bytes);
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
  ) { super(); }

  getName(): string { return 'feishu_send_file'; }
  getDescription(): string {
    return '向当前会话对应的飞书用户或群聊发送一份文件（仅飞书通道会话可用，私聊发给该用户、群聊发到该群）。支持本地文件路径（绝对路径或会话工作区相对路径）或 http(s) URL，大小不超过 30MB。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        file: { type: 'string', description: '要发送的文件：本地文件路径（绝对路径或工作区相对路径），或 http(s) URL' },
        filename: { type: 'string', description: '可选，发送到飞书时展示的文件名，默认取路径 basename' },
      },
      required: ['file'],
    };
  }
  getOutputSchema(): Record<string, unknown> {
    return { type: 'object', properties: { success: { type: 'boolean' } } };
  }

  protected override async executeWithUser(argumentsJson: string, sessionId: number | null, _userId: number | null, workspace: string | null): Promise<string> {
    try {
      const args = parseObject(argumentsJson) ?? {};
      const file = asText(args.file);
      if (!file) return errorJson('缺少必填参数: file');
      const target = await this.support.resolveSendTarget(sessionId);
      if (!target) return errorJson('当前会话不是飞书通道会话，无法发送飞书文件');
      const bytes = await loadBytes(file, this.pathSandbox, workspace);
      if (bytes.length === 0) return errorJson('文件内容为空');
      if (bytes.length > MAX_FEISHU_FILE_BYTES) return errorJson('文件超过 30MB 上限');
      const fileName = asText(args.filename) || file.replace(/\\/g, '/').split('/').pop() || 'file';
      await this.support.sendFile(target, fileName, bytes);
      return toJson({ success: true });
    } catch (e) {
      harnessLog('warn', 'feishu_send_file failed', e);
      return errorJson((e as Error).message);
    }
  }
}

async function loadBytes(src: string, sandbox: PathSandbox, workspace: string | null): Promise<Buffer> {
  if (src.startsWith('http://') || src.startsWith('https://')) {
    return fetchBytes(src);
  }
  const resolved = sandbox.resolveLenient(src, workspace);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error('文件不存在：' + src);
  }
  return readFile(resolved);
}

function fetchBytes(url: string): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    lib.get(u, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => resolvePromise(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}
