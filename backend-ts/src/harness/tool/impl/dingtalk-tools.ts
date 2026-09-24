import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { BaseTool } from '../tool.js';
import { asText, errorJson, parseObject, toJson } from '../json.js';
import { ImageFileSupport } from '../image-file-support.js';
import type { PathSandbox } from '../../safety/path-sandbox.js';
import type { DingtalkChannelTool } from '../dingtalk-channel-tool.js';
import { DINGTALK_FILE_EXTENSIONS, DINGTALK_FILE_MAX_BYTES, DINGTALK_IMAGE_MAX_BYTES, fileExtension, fileMessageParam } from '../../../dingtalk/send.service.js';
import { harnessLog } from '../../log.js';

export interface DingtalkSendTarget {
  chatType: 'p2p' | 'group';
  robotCode: string;
  userId?: string;
  conversationId?: string;
  clientId: string;
  clientSecret: string;
}

export interface DingtalkMediaSendSupport {
  resolveSendTarget(sessionId: number | null): Promise<DingtalkSendTarget | null>;
  sendImage(target: DingtalkSendTarget, bytes: Buffer, fileName: string): Promise<string>;
  sendFile(target: DingtalkSendTarget, fileName: string, bytes: Buffer): Promise<string>;
}

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp']);

export class SendDingtalkImageTool extends BaseTool implements DingtalkChannelTool {
  readonly dingtalkChannelTool = true as const;

  constructor(private readonly pathSandbox: PathSandbox, private readonly support: DingtalkMediaSendSupport) { super(); }

  getName(): string { return 'dingtalk_send_image'; }
  getDescription(): string {
    return '向当前钉钉会话发送一张图片（仅钉钉通道可用，私聊发给该用户、群聊发到该群）。支持本地路径或 http(s) 图片 URL。成功返回文件名。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: { image: { type: 'string', description: '图片本地路径（绝对或工作区相对）或 http(s) URL' } },
      required: ['image'],
    };
  }
  getOutputSchema(): Record<string, unknown> {
    return { type: 'object', properties: { success: { type: 'boolean' }, filename: { type: 'string' } } };
  }

  protected override async executeWithUser(argumentsJson: string, sessionId: number | null, _userId: number | null, workspace: string | null): Promise<string> {
    try {
      const image = asText((parseObject(argumentsJson) ?? {}).image);
      if (!image) return errorJson('缺少必填参数: image');
      const target = await this.support.resolveSendTarget(sessionId);
      if (!target) return errorJson('当前会话不是钉钉通道会话，无法发送钉钉图片');
      const bytes = await loadBytes(image, this.pathSandbox, workspace);
      if (bytes.length === 0) return errorJson('图片内容为空');
      if (bytes.length > DINGTALK_IMAGE_MAX_BYTES) return errorJson('图片超过 20MB 上限');
      const mime = ImageFileSupport.detectMimeFromBytes(bytes);
      if (!mime || !IMAGE_MIMES.has(mime)) return errorJson('不支持的图片格式，仅支持 PNG/JPG/JPEG/GIF/BMP');
      const filename = image.replace(/\\/g, '/').split('/').pop() || 'image.png';
      const sentName = await this.support.sendImage(target, bytes, filename);
      return toJson({ success: true, filename: sentName });
    } catch (error) {
      harnessLog('warn', 'dingtalk_send_image failed', error);
      return errorJson((error as Error).message);
    }
  }
}

export class SendDingtalkFileTool extends BaseTool implements DingtalkChannelTool {
  readonly dingtalkChannelTool = true as const;

  constructor(private readonly pathSandbox: PathSandbox, private readonly support: DingtalkMediaSendSupport) { super(); }

  getName(): string { return 'dingtalk_send_file'; }
  getDescription(): string {
    return `向当前钉钉会话发送一份文件（仅钉钉通道可用）。扩展名仅支持 ${DINGTALK_FILE_EXTENSIONS.join('、')}，最大 20MB。不合法时返回失败原因。成功返回文件名。`;
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        file: { type: 'string', description: '文件本地路径（绝对或工作区相对）或 http(s) URL' },
        filename: { type: 'string', description: '可选，发送时展示的文件名' },
      },
      required: ['file'],
    };
  }
  getOutputSchema(): Record<string, unknown> {
    return { type: 'object', properties: { success: { type: 'boolean' }, filename: { type: 'string' } } };
  }

  protected override async executeWithUser(argumentsJson: string, sessionId: number | null, _userId: number | null, workspace: string | null): Promise<string> {
    try {
      const args = parseObject(argumentsJson) ?? {};
      const file = asText(args.file);
      if (!file) return errorJson('缺少必填参数: file');
      const filename = asText(args.filename) || file.replace(/\\/g, '/').split('/').pop() || 'file';
      const checked = fileMessageParam('media', filename);
      if ('error' in checked) return errorJson(checked.error);
      const target = await this.support.resolveSendTarget(sessionId);
      if (!target) return errorJson('当前会话不是钉钉通道会话，无法发送钉钉文件');
      const bytes = await loadBytes(file, this.pathSandbox, workspace);
      if (bytes.length === 0) return errorJson('文件内容为空');
      if (bytes.length > DINGTALK_FILE_MAX_BYTES) return errorJson('文件超过 20MB 上限');
      if (fileExtension(filename) === '') return errorJson(`钉钉文件仅支持 ${DINGTALK_FILE_EXTENSIONS.join('、')}`);
      const sentName = await this.support.sendFile(target, filename, bytes);
      return toJson({ success: true, filename: sentName });
    } catch (error) {
      harnessLog('warn', 'dingtalk_send_file failed', error);
      return errorJson((error as Error).message);
    }
  }
}

async function loadBytes(src: string, sandbox: PathSandbox, workspace: string | null): Promise<Buffer> {
  if (src.startsWith('http://') || src.startsWith('https://')) return fetchBytes(src);
  const resolved = sandbox.resolveLenient(src, workspace);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) throw new Error('文件不存在：' + src);
  return readFile(resolved);
}

function fetchBytes(url: string): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const client = url.startsWith('https://') ? https : http;
    client.get(url, (res) => {
      if ((res.statusCode ?? 500) >= 400) {
        reject(new Error(`下载失败: HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => resolvePromise(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}
