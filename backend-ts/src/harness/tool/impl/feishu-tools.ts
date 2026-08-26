import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BaseTool } from '../tool.js';
import { asText, errorJson, parseObject, toJson } from '../json.js';
import type { FeishuChannelTool } from '../feishu-channel-tool.js';
import { harnessLog } from '../../log.js';

/** 会话 → 飞书 Bot 解析：返回该会话所属 bot 的 app_id；非飞书通道会话返回 null。 */
export interface FeishuChannelToolSupport {
  resolveBotAppId(sessionId: number | null): Promise<string | null>;
}

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
      const media = await this.mediaLookup.findMediaByMessageId(messageId);
      if (media == null || media.fileKey == null) return errorJson(`未找到包含文件/图片的群聊消息: ${messageId}`);
      const isImage = media.msgType === 'image';
      const { buffer, contentType } = await this.downloader.download(
        media.appId, messageId, media.fileKey, isImage ? 'image' : 'file', this.maxBytes,
      );
      if (buffer.length === 0) return errorJson('文件下载失败：内容为空（可能已过期或无权限）');
      mkdirSync(workspace, { recursive: true });
      const suffix = messageId.slice(-8);
      const fallback = `feishu-${isImage ? 'img' : 'file'}-${suffix}`;
      const baseName = sanitizeFileName(isImage ? null : media.fileName, fallback);
      const ext = isImage ? imageExtensionOf(contentType) : extnameOf(baseName);
      const stem = isImage ? baseName : baseName.slice(0, baseName.length - ext.length);
      let target = resolve(workspace, `${stem}${ext}`);
      if (existsSync(target)) target = resolve(workspace, `${stem}-${suffix}${ext}`);
      await writeFile(target, buffer);
      return toJson({ success: true, path: target });
    } catch (e) {
      harnessLog('warn', 'feishu_download_file failed', e);
      return errorJson((e as Error).message);
    }
  }
}
