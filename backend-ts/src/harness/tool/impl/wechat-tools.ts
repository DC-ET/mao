import { existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { BaseTool } from '../tool.js';
import { asText, errorJson, parseObject, toJson } from '../json.js';
import { ImageFileSupport } from '../image-file-support.js';
import type { WeixinChannelTool } from '../weixin-channel-tool.js';
import type { PathSandbox } from '../../safety/path-sandbox.js';
import { harnessLog } from '../../log.js';

export interface WeixinMediaToolSupport {
  resolveAccount(sessionId: number | null, userId: number | null): Promise<{ accountId: string; wxUserId: string } | null>;
}

export interface WeixinMediaUploadService {
  uploadImage(accountId: string, wxUserId: string, bytes: Buffer, mime: string): Promise<{ mediaId: string }>;
  uploadFile(accountId: string, wxUserId: string, bytes: Buffer, fileName: string, mime: string): Promise<{ mediaId: string }>;
}

export interface WeixinSendService {
  sendImage(accountId: string, wxUserId: string, mediaId: string): Promise<boolean>;
  sendFile(accountId: string, wxUserId: string, mediaId: string, fileName: string): Promise<boolean>;
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export class SendWechatImageTool extends BaseTool implements WeixinChannelTool {
  readonly weixinChannelTool = true as const;

  constructor(
    private readonly pathSandbox: PathSandbox,
    private readonly toolSupport: WeixinMediaToolSupport,
    private readonly uploadService: WeixinMediaUploadService,
    private readonly sendService: WeixinSendService,
  ) { super(); }

  getName(): string { return 'send_wechat_image'; }
  getDescription(): string {
    return '向微信用户发送一张图片（仅微信通道会话可用）。支持本地文件路径（绝对路径或会话工作区相对路径）或 http(s) 图片 URL；仅支持 PNG/JPG/JPEG/GIF/WebP，大小不超过 20MB。发送成功后微信用户会收到该图片。';
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

  protected async executeWithUser(argumentsJson: string, sessionId: number | null, userId: number | null, workspace: string | null): Promise<string> {
    try {
      const args = parseObject(argumentsJson) ?? {};
      const image = asText(args.image);
      if (!image) return errorJson('缺少必填参数: image');
      const account = await this.toolSupport.resolveAccount(sessionId, userId);
      if (!account) return errorJson('微信账号未绑定或尚未建立会话');
      const bytes = await loadBytes(image, this.pathSandbox, workspace);
      if (bytes.length > MAX_IMAGE_BYTES) return errorJson('图片超过 20MB 上限');
      const mime = ImageFileSupport.detectMimeFromBytes(bytes);
      if (!mime || !ALLOWED_IMAGE_MIMES.has(mime)) return errorJson('不支持的图片格式');
      const uploaded = await this.uploadService.uploadImage(account.accountId, account.wxUserId, bytes, mime);
      const ok = await this.sendService.sendImage(account.accountId, account.wxUserId, uploaded.mediaId);
      return toJson({ success: ok });
    } catch (e) {
      harnessLog('error', 'SendWechatImageTool failed', e);
      return errorJson((e as Error).message);
    }
  }
}

export class SendWechatFileTool extends BaseTool implements WeixinChannelTool {
  readonly weixinChannelTool = true as const;

  constructor(
    private readonly pathSandbox: PathSandbox,
    private readonly toolSupport: WeixinMediaToolSupport,
    private readonly uploadService: WeixinMediaUploadService,
    private readonly sendService: WeixinSendService,
  ) { super(); }

  getName(): string { return 'send_wechat_file'; }
  getDescription(): string {
    return '向微信用户发送一份文件（仅微信通道会话可用）。支持本地文件路径或 http(s) URL。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        file: { type: 'string', description: '要发送的文件路径或 URL' },
        filename: { type: 'string', description: '可选文件名' },
      },
      required: ['file'],
    };
  }
  getOutputSchema(): Record<string, unknown> {
    return { type: 'object', properties: { success: { type: 'boolean' } } };
  }

  protected async executeWithUser(argumentsJson: string, sessionId: number | null, userId: number | null, workspace: string | null): Promise<string> {
    try {
      const args = parseObject(argumentsJson) ?? {};
      const file = asText(args.file);
      if (!file) return errorJson('缺少必填参数: file');
      const account = await this.toolSupport.resolveAccount(sessionId, userId);
      if (!account) return errorJson('微信账号未绑定或尚未建立会话');
      const bytes = await loadBytes(file, this.pathSandbox, workspace);
      const fileName = asText(args.filename) ?? file.split(/[\\/]/).pop() ?? 'file';
      const uploaded = await this.uploadService.uploadFile(account.accountId, account.wxUserId, bytes, fileName, 'application/octet-stream');
      const ok = await this.sendService.sendFile(account.accountId, account.wxUserId, uploaded.mediaId, fileName);
      return toJson({ success: ok });
    } catch (e) {
      harnessLog('error', 'SendWechatFileTool failed', e);
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
  return readFileSync(resolved);
}

function fetchBytes(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    lib.get(u, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}
