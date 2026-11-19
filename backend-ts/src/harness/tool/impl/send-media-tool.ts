import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BaseTool } from '../tool.js';
import { asText, errorJson, parseObject, toJson } from '../json.js';
import { ImageFileSupport } from '../image-file-support.js';
import {
  loadSendFileBytesDetailed,
  SendBytesNotFoundError,
  type SendBytesSupport,
} from './send-file-bytes.js';
import { toStaticUploadBase } from './generate-image-tool.js';
import { SecurityException, type PathSandbox } from '../../safety/path-sandbox.js';
import { BusinessException } from '../../../common/business-exception.js';
import { ErrorCode } from '../../../common/error-code.js';
import { WEIXIN_PROJECT_KEY } from '../../../domain/types.js';
import { isFeishuChannelSession } from '../feishu-channel-tool.js';
import { isDingtalkChannelSession } from '../dingtalk-channel-tool.js';
import type { WeixinMediaToolSupport, WeixinMediaUploadService, WeixinSendService } from './wechat-tools.js';
import type { FeishuMediaSendSupport } from './feishu-tools.js';
import type { FeishuSendTarget } from '../../../feishu/media-sender.js';
import type { DingtalkMediaSendSupport, DingtalkSendTarget } from './dingtalk-tools.js';
import type { LocalDeliveryFetchService } from '../../local/delivery-fetch.service.js';
import { DINGTALK_FILE_EXTENSIONS } from '../../../dingtalk/send.service.js';
import { harnessLog } from '../../log.js';

/**
 * 统一发送图片 / 文件（技术方案 2026-11-18-unified-send-media）：
 * `send_image` / `send_file` 收编六个通道发送工具。每次发送都写会话副本
 * （`uploads/{userId}/send-*`，网页 / 桌面 / 安卓打开同一会话可见），
 * 会话绑定了微信 / 飞书 / 钉钉再用同一份字节额外推送，两侧独立成败（D8）。
 * 六个旧类的发送逻辑移进下面的策略，类本身已删除。
 */

export const SEND_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const SEND_FILE_MAX_BYTES = 30 * 1024 * 1024;

/** 副本图片格式 = 三通道并集（微信 / 飞书 png/jpeg/gif/webp + 钉钉 bmp）。 */
const COPY_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);

export type SendChannel = 'chat' | 'wechat' | 'dingtalk' | 'feishu';

export interface SendMediaSession {
  executionMode?: string | null;
  workspace?: string | null;
  projectKey?: string | null;
  parentSessionId?: number | null;
}

export interface SendMediaSessionLookup {
  /** SessionService.getSession 不存在时抛 SESSION_NOT_FOUND；测试替身可返回 null。 */
  getSession(id: number): Promise<SendMediaSession | null>;
}

export interface SendCopyDeps {
  uploadDir: string;
  getUploadBaseUrl: () => Promise<string>;
  uploadContextPath?: string;
}

export interface ChannelPushInput {
  sessionId: number | null;
  /** 边路任务回落用：本会话绑定解析不到时用父会话再解析一次（评审补充）。 */
  parentSessionId: number | null;
  userId: number | null;
  bytes: Buffer;
  filename: string;
}

export interface ChannelPushResult {
  ok: boolean;
  error: string | null;
}

export interface SendChannelStrategy {
  readonly channel: 'wechat' | 'dingtalk' | 'feishu';
  pushImage(input: ChannelPushInput): Promise<ChannelPushResult>;
  pushFile(input: ChannelPushInput): Promise<ChannelPushResult>;
}

// ─────────────────────────── 副本落盘（§5.1） ───────────────────────────

/** 可执行内容扩展名：副本保持同源可点开，绝不落成这些后缀（回落 `.bin`）。 */
const ACTIVE_CONTENT_EXTENSIONS = new Set([
  'html', 'htm', 'xhtml', 'xht', 'shtml', 'mhtml', 'mht', 'htc',
  'svg', 'svgz', 'xml', 'xsl', 'xslt', 'js', 'mjs', 'cjs', 'swf', 'wasm',
]);

/** content-type → 扩展名（URL 路径没有扩展名时用，按响应头优先）。 */
const CONTENT_TYPE_EXTENSION: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/x-rar-compressed': '.rar',
  'application/vnd.rar': '.rar',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'text/plain': '.txt',
};

/**
 * 扩展名白名单：`^[A-Za-z0-9]{1,9}$`（不含点）；不在白名单或属于可执行内容一律 `.bin`。
 * http(s) 来源先取 URL 路径 extname，取不到再按响应 content-type 映射（§5.1）。
 */
export function deriveSendCopyExtension(source: string, contentType?: string | null): string {
  const usable = (candidate: string): string | null => {
    const bare = candidate.replace(/^\./, '').toLowerCase();
    if (!/^[A-Za-z0-9]{1,9}$/.test(bare)) return null;
    if (ACTIVE_CONTENT_EXTENSIONS.has(bare)) return null;
    return `.${bare}`;
  };
  if (/^https?:\/\//i.test(source)) {
    try {
      const fromPath = usable(path.extname(new URL(source).pathname));
      if (fromPath != null) return fromPath;
    } catch { /* fall through */ }
    const mime = contentType?.split(';')[0].trim().toLowerCase() ?? '';
    return (mime !== '' ? CONTENT_TYPE_EXTENSION[mime] : undefined) ?? '.bin';
  }
  return usable(path.extname(source.replace(/[\\/]+$/, ''))) ?? '.bin';
}

/** 扩展名 → mime 兜底表（图片格式经字节嗅探优先，见 mimeForSendCopy）。 */
const EXTENSION_MIME_FALLBACK: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain',
};

/** 图片字节嗅探（BMP 无通用嗅探器，按 `BM` 魔数补）；非图片返回 null。 */
function sniffImageMime(bytes: Buffer): string | null {
  const sniffed = ImageFileSupport.detectMimeFromBytes(bytes);
  if (sniffed != null) return sniffed;
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return null;
}

/**
 * 副本 mime：图片一律以字节嗅探为准（扩展名 / content-type 都不能把非图片伪装成图片）；
 * 其它优先响应 content-type，再按扩展名，未知 octet-stream。
 */
export function mimeForSendCopy(ext: string, bytes: Buffer, declared?: string | null): string {
  const imageMime = sniffImageMime(bytes);
  if (imageMime != null) return imageMime;
  const declaredMime = declared?.split(';')[0].trim().toLowerCase() ?? '';
  if (/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(declaredMime)) return declaredMime;
  return EXTENSION_MIME_FALLBACK[ext] ?? 'application/octet-stream';
}

export type SendCopyOutcome =
  | { ok: true; url: string; mime: string; bytes: number }
  | { ok: false; error: string };

/** 会话副本：写 `uploads/{userId}/send-{uuid}{ext}`，URL 口径与文生图相同（D7）。 */
export async function saveSendCopy(
  deps: SendCopyDeps,
  kind: 'image' | 'file',
  bytes: Buffer,
  source: string,
  userId: number | null,
  contentType?: string | null,
): Promise<SendCopyOutcome> {
  const ext = deriveSendCopyExtension(source, contentType);
  if (kind === 'image') {
    const imageMime = sniffImageMime(bytes);
    if (imageMime == null || !COPY_IMAGE_MIMES.has(imageMime)) {
      return { ok: false, error: '不支持的图片格式（副本支持 PNG/JPG/JPEG/GIF/WebP/BMP）' };
    }
  }
  const uidSegment = userId != null ? `${String(userId)}/` : '';
  const dir = userId != null ? path.join(deps.uploadDir, String(userId)) : deps.uploadDir;
  let origin: string;
  try {
    const baseUrl = await deps.getUploadBaseUrl();
    origin = toStaticUploadBase(baseUrl, deps.uploadContextPath ?? '/api');
  } catch (e) {
    harnessLog('warn', 'send copy baseUrl resolve failed', e);
    origin = '';
  }
  if (origin === '') {
    // §5.1-3：origin 为空视为副本失败；通道推送仍照常尝试
    return { ok: false, error: '对话页没有可打开的附件地址，保存失败' };
  }
  // 文件类副本回落 .bin（未知 / 可执行扩展名）时 mime 收敛为 octet-stream：
  // delivery.mime 不暴露 text/html / image/svg+xml，避免客户端按 mime 内联预览时绕开扩展名限制
  const mime = kind === 'file' && ext === '.bin'
    ? 'application/octet-stream'
    : mimeForSendCopy(ext, bytes, contentType);
  try {
    mkdirSync(dir, { recursive: true });
    const fileName = `send-${randomUUID()}${ext}`;
    writeFileSync(path.join(dir, fileName), bytes);
    return {
      ok: true,
      url: `${origin}/uploads/${uidSegment}${fileName}`,
      mime,
      bytes: bytes.length,
    };
  } catch (e) {
    harnessLog('warn', 'send copy write failed', e);
    return { ok: false, error: `附件写入失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

// ─────────────────────────── 通道检测（D2） ───────────────────────────

/** 与 filterToolsForSession 同序：微信 → 钉钉 → 飞书；没有则为 chat（§4.3）。 */
export function detectSendChannel(session: SendMediaSession | null | undefined): SendChannel {
  const projectKey = session?.projectKey ?? null;
  const workspace = session?.workspace ?? null;
  if (projectKey === WEIXIN_PROJECT_KEY) return 'wechat';
  if (isDingtalkChannelSession(projectKey, workspace)) return 'dingtalk';
  if (isFeishuChannelSession(projectKey, workspace)) return 'feishu';
  return 'chat';
}

const DINGTALK_FILE_EXTENSION_SET = new Set<string>(DINGTALK_FILE_EXTENSIONS);
const DINGTALK_FILE_EXTENSIONS_TEXT = DINGTALK_FILE_EXTENSIONS.join('、');

const CHANNEL_LABELS: Record<Exclude<SendChannel, 'chat'>, string> = {
  wechat: '微信',
  dingtalk: '钉钉',
  feishu: '飞书',
};

// ─────────────────────────── 三个通道策略（旧类逻辑收编） ───────────────────────────

const WECHAT_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const FEISHU_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const DINGTALK_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp']);
const WECHAT_MAX_BYTES = 20 * 1024 * 1024;
const DINGTALK_MAX_BYTES = 20 * 1024 * 1024;
const FEISHU_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const FEISHU_FILE_MAX_BYTES = 30 * 1024 * 1024;

export class WechatSendStrategy implements SendChannelStrategy {
  readonly channel = 'wechat' as const;

  constructor(
    private readonly toolSupport: WeixinMediaToolSupport,
    private readonly uploadService: WeixinMediaUploadService,
    private readonly sendService: WeixinSendService,
  ) {}

  private async resolveAccount(sessionId: number | null, parentSessionId: number | null, userId: number | null) {
    const direct = await this.toolSupport.resolveAccount(sessionId, userId);
    if (direct != null) return direct;
    // 边路会话在对端绑定表里没有行：回落父会话再解析一次（评审补充）
    if (parentSessionId != null) return this.toolSupport.resolveAccount(parentSessionId, userId);
    return null;
  }

  async pushImage({ sessionId, parentSessionId, userId, bytes }: ChannelPushInput): Promise<ChannelPushResult> {
    const account = await this.resolveAccount(sessionId, parentSessionId, userId);
    if (!account) return { ok: false, error: '微信账号未绑定或尚未建立会话' };
    if (bytes.length > WECHAT_MAX_BYTES) return { ok: false, error: '图片超过 20MB 上限' };
    const mime = ImageFileSupport.detectMimeFromBytes(bytes);
    if (!mime || !WECHAT_IMAGE_MIMES.has(mime)) return { ok: false, error: '不支持的图片格式' };
    const uploaded = await this.uploadService.uploadImage(account.accountId, account.wxUserId, bytes, mime);
    const sent = await this.sendService.sendImage(account.accountId, account.wxUserId, uploaded.mediaId);
    if (!sent) return { ok: false, error: '微信消息发送失败' };
    return { ok: true, error: null };
  }

  async pushFile({ sessionId, parentSessionId, userId, bytes, filename }: ChannelPushInput): Promise<ChannelPushResult> {
    const account = await this.resolveAccount(sessionId, parentSessionId, userId);
    if (!account) return { ok: false, error: '微信账号未绑定或尚未建立会话' };
    if (bytes.length > WECHAT_MAX_BYTES) return { ok: false, error: '文件超过 20MB 上限' };
    const uploaded = await this.uploadService.uploadFile(account.accountId, account.wxUserId, bytes, filename, 'application/octet-stream');
    const sent = await this.sendService.sendFile(account.accountId, account.wxUserId, uploaded.mediaId, filename);
    if (!sent) return { ok: false, error: '微信消息发送失败' };
    return { ok: true, error: null };
  }
}

export class FeishuSendStrategy implements SendChannelStrategy {
  readonly channel = 'feishu' as const;

  constructor(private readonly support: FeishuMediaSendSupport) {}

  private async resolveTarget(sessionId: number | null, parentSessionId: number | null): Promise<FeishuSendTarget | null> {
    const direct = await this.support.resolveSendTarget(sessionId);
    if (direct != null) return direct;
    if (parentSessionId != null) return this.support.resolveSendTarget(parentSessionId);
    return null;
  }

  async pushImage({ sessionId, parentSessionId, bytes }: ChannelPushInput): Promise<ChannelPushResult> {
    const target = await this.resolveTarget(sessionId, parentSessionId);
    if (!target) return { ok: false, error: '飞书会话未绑定，无法推送到飞书' };
    if (bytes.length === 0) return { ok: false, error: '图片内容为空' };
    if (bytes.length > FEISHU_IMAGE_MAX_BYTES) return { ok: false, error: '图片超过 10MB 上限' };
    const mime = ImageFileSupport.detectMimeFromBytes(bytes);
    if (!mime || !FEISHU_IMAGE_MIMES.has(mime)) return { ok: false, error: '不支持的图片格式，仅支持 PNG/JPG/JPEG/GIF/WebP' };
    await this.support.sendImage(target, bytes, target.sessionId ?? sessionId);
    return { ok: true, error: null };
  }

  async pushFile({ sessionId, parentSessionId, bytes, filename }: ChannelPushInput): Promise<ChannelPushResult> {
    const target = await this.resolveTarget(sessionId, parentSessionId);
    if (!target) return { ok: false, error: '飞书会话未绑定，无法推送到飞书' };
    if (bytes.length === 0) return { ok: false, error: '文件内容为空' };
    if (bytes.length > FEISHU_FILE_MAX_BYTES) return { ok: false, error: '文件超过 30MB 上限' };
    await this.support.sendFile(target, filename, bytes, target.sessionId ?? sessionId);
    return { ok: true, error: null };
  }
}

export class DingtalkSendStrategy implements SendChannelStrategy {
  readonly channel = 'dingtalk' as const;

  constructor(private readonly support: DingtalkMediaSendSupport) {}

  private async resolveTarget(sessionId: number | null, parentSessionId: number | null): Promise<DingtalkSendTarget | null> {
    const direct = await this.support.resolveSendTarget(sessionId);
    if (direct != null) return direct;
    if (parentSessionId != null) return this.support.resolveSendTarget(parentSessionId);
    return null;
  }

  async pushImage({ sessionId, parentSessionId, bytes, filename }: ChannelPushInput): Promise<ChannelPushResult> {
    const target = await this.resolveTarget(sessionId, parentSessionId);
    if (!target) return { ok: false, error: '钉钉会话未绑定，无法推送到钉钉' };
    if (bytes.length === 0) return { ok: false, error: '图片内容为空' };
    if (bytes.length > DINGTALK_MAX_BYTES) return { ok: false, error: '图片超过 20MB 上限' };
    const mime = sniffImageMime(bytes);
    if (!mime || !DINGTALK_IMAGE_MIMES.has(mime)) return { ok: false, error: '不支持的图片格式，仅支持 PNG/JPG/JPEG/GIF/BMP' };
    await this.support.sendImage(target, bytes, filename);
    return { ok: true, error: null };
  }

  async pushFile({ sessionId, parentSessionId, bytes, filename }: ChannelPushInput): Promise<ChannelPushResult> {
    const target = await this.resolveTarget(sessionId, parentSessionId);
    if (!target) return { ok: false, error: '钉钉会话未绑定，无法推送到钉钉' };
    if (bytes.length === 0) return { ok: false, error: '文件内容为空' };
    if (bytes.length > DINGTALK_MAX_BYTES) return { ok: false, error: '文件超过 20MB 上限' };
    const checked = fileMessageParamChecked(filename);
    if (checked != null) return { ok: false, error: checked };
    await this.support.sendFile(target, filename, bytes);
    return { ok: true, error: null };
  }
}

/** 钉钉扩展名校验（沿用 send.service 的白名单口径）；合法返回 null。 */
function fileMessageParamChecked(filename: string): string | null {
  const ext = filename.replace(/\\/g, '/').split('/').pop()?.split('.').pop()?.toLowerCase() ?? '';
  if (ext === '' || !DINGTALK_FILE_EXTENSION_SET.has(ext)) {
    return `钉钉文件仅支持 ${DINGTALK_FILE_EXTENSIONS_TEXT}`;
  }
  return null;
}

// ─────────────────────────── 结果合并（D8） ───────────────────────────

export function combineSendResult(
  kind: 'image' | 'file',
  filename: string,
  channel: SendChannel,
  copy: SendCopyOutcome,
  push: ChannelPushResult,
): string {
  const channelLabel = channel === 'chat' ? null : CHANNEL_LABELS[channel];
  const channelStatus: 'skipped' | 'sent' | 'failed' = channel === 'chat' ? 'skipped' : (push.ok ? 'sent' : 'failed');
  const delivery = copy.ok ? { kind, url: copy.url, mime: copy.mime, bytes: copy.bytes } : null;
  let success: boolean;
  let error: string | null;
  if (channel === 'chat') {
    // 无外部通道：唯一一侧是会话副本，push 不参与（D8 单侧）
    success = copy.ok;
    error = copy.ok ? null : `对话页保存失败：${copy.error}`;
  } else if (copy.ok && push.ok) {
    success = true;
    error = null;
  } else if (copy.ok) {
    success = true;
    error = `已放入当前对话，${channelLabel}发送失败：${push.error}`;
  } else if (push.ok) {
    success = true;
    error = `已发到${channelLabel}，对话页保存失败：${copy.error}`;
  } else {
    success = false;
    error = channelLabel
      ? `${channelLabel}发送失败：${push.error}；对话页保存失败：${copy.error}`
      : `对话页保存失败：${copy.error}`;
  }
  const result: Record<string, unknown> = { success, channel, channelStatus, filename };
  if (delivery != null) result.delivery = delivery;
  if (error != null) result.error = error;
  return toJson(result);
}

/** 来源 basename：路径 / URL 尾段；空回落来源本身（§4.1 filename 回落链）。 */
export function basenameOfSource(source: string): string {
  if (/^https?:\/\//i.test(source)) {
    try {
      const tail = new URL(source).pathname.replace(/\/+$/, '').split('/').pop() ?? '';
      if (tail !== '') return decodeURIComponent(tail);
    } catch { /* fall through */ }
  }
  return source.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || source;
}

// ─────────────────────────── 两个新工具 ───────────────────────────

const SEND_TOOL_BASE_PROMPT = '网页、桌面、安卓打开这条会话时，附件出现在该轮回复下方。这条会话若绑定了微信、飞书或钉钉，同一份内容再发给对应的用户或群。支持本地文件路径（工作区相对路径，或允许集内的绝对路径：会话工作区、本人 uploads/{userId} 产物目录、runtime、HOME、/tmp）或 http(s) URL。结果含 error 时，向用户说明原因。结果里已有 delivery，或 channelStatus 为 sent 的那一侧已经完成，不要把同一份内容再发一次。';

/** LOCAL 读本机文件的执行端拉取（D10）：缺省 null（未装配时 LOCAL 本机路径直接失败）。 */
export interface SendDeliveryFetcher {
  fetch(
    sessionId: number,
    userId: number | null,
    filePath: string,
    workspace: string | null | undefined,
    maxBytes: number,
  ): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }>;
}

abstract class SendMediaToolBase extends BaseTool {
  constructor(
    protected readonly pathSandbox: PathSandbox,
    protected readonly sessionLookup: SendMediaSessionLookup,
    protected readonly copyDeps: SendCopyDeps,
    protected readonly wechat: WechatSendStrategy | null,
    protected readonly feishu: FeishuSendStrategy | null,
    protected readonly dingtalk: DingtalkSendStrategy | null,
    protected readonly sendBytesSupport?: SendBytesSupport | null,
    protected readonly deliveryFetch?: SendDeliveryFetcher | null,
  ) { super(); }

  protected abstract kind(): 'image' | 'file';
  protected abstract maxBytes(): number;
  protected abstract sourceArgName(): string;
  protected abstract emptyBytesError(): string;

  protected strategyFor(channel: SendChannel): SendChannelStrategy | null {
    if (channel === 'wechat') return this.wechat;
    if (channel === 'feishu') return this.feishu;
    if (channel === 'dingtalk') return this.dingtalk;
    return null;
  }

  /**
   * 读一次字节（读取上限 = 副本上限，§5.1-1）；LOCAL 会话非 http(s) 且**宿主机没有这份文件**
   * 时回退执行端拉取（D10，§6.1）。跨成员预检、容器读失败、超限、符号链接越界不回退，
   * 避免把安全 / 大小问题掩盖成执行端超时。
   */
  protected async loadBytes(
    source: string,
    ctx: { userId: number | null; sessionId: number | null; workspace: string | null },
    maxBytes: number,
    executionMode: string | null | undefined,
  ): Promise<{ bytes: Buffer; contentType: string | null }> {
    try {
      return await loadSendFileBytesDetailed(source, this.pathSandbox, this.sendBytesSupport ?? null, ctx, maxBytes);
    } catch (e) {
      const isHttp = /^https?:\/\//i.test(source);
      // 宿主机文件不存在 / 路径在服务端沙箱根外（LOCAL 本机路径在服务器上必然如此）才回退
      const hostMissing = e instanceof SendBytesNotFoundError || e instanceof SecurityException;
      if (executionMode === 'LOCAL' && !isHttp && hostMissing && ctx.sessionId != null && this.deliveryFetch != null) {
        const sid = ctx.sessionId as number;
        const fetched = await this.deliveryFetch.fetch(sid, ctx.userId, source, ctx.workspace, maxBytes);
        if (fetched.ok) return { bytes: fetched.bytes, contentType: null };
        throw new Error(fetched.error);
      }
      throw e;
    }
  }

  protected override async executeWithUser(argumentsJson: string, sessionId: number | null, userId: number | null, workspace: string | null): Promise<string> {
    const kind = this.kind();
    const argName = this.sourceArgName();
    try {
      const args = parseObject(argumentsJson) ?? {};
      const source = asText(args[argName]);
      if (!source) return errorJson(`缺少必填参数: ${argName}`);
      let session: SendMediaSession | null = null;
      if (sessionId != null) {
        try {
          session = await this.sessionLookup.getSession(sessionId);
        } catch (e) {
          if (e instanceof BusinessException && e.code === ErrorCode.SESSION_NOT_FOUND.code) {
            return errorJson('当前会话不存在，无法发送');
          }
          harnessLog('warn', `send media session lookup failed sessionId=${sessionId}`, e);
          return errorJson(e instanceof Error ? e.message : String(e));
        }
        if (session == null) return errorJson('当前会话不存在，无法发送');
      }
      const channel = detectSendChannel(session);
      let loaded: { bytes: Buffer; contentType: string | null };
      try {
        loaded = await this.loadBytes(source, { userId, sessionId, workspace }, this.maxBytes(), session?.executionMode ?? null);
      } catch (e) {
        // 读字节失败：还没有两侧，只有 error（§4.3）
        return errorJson(e instanceof Error ? e.message : String(e));
      }
      const bytes = loaded.bytes;
      if (bytes.length === 0) return errorJson(this.emptyBytesError());
      const filename = asText(args.filename) || basenameOfSource(source);
      const copy = await saveSendCopy(this.copyDeps, kind, bytes, source, userId, loaded.contentType);
      const strategy = this.strategyFor(channel);
      let push: ChannelPushResult = { ok: true, error: null };
      if (strategy != null) {
        const pushInput = { sessionId, parentSessionId: session?.parentSessionId ?? null, userId, bytes, filename };
        try {
          push = kind === 'image' ? await strategy.pushImage(pushInput) : await strategy.pushFile(pushInput);
        } catch (e) {
          harnessLog('warn', `send ${kind} channel push failed channel=${channel}`, e);
          push = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      return combineSendResult(kind, filename, channel, copy, push);
    } catch (e) {
      harnessLog('warn', `send_${kind} failed`, e);
      return errorJson(e instanceof Error ? e.message : String(e));
    }
  }
}

export class SendImageTool extends SendMediaToolBase {
  constructor(
    pathSandbox: PathSandbox,
    sessionLookup: SendMediaSessionLookup,
    copyDeps: SendCopyDeps,
    wechat: WechatSendStrategy | null,
    feishu: FeishuSendStrategy | null,
    dingtalk: DingtalkSendStrategy | null,
    sendBytesSupport?: SendBytesSupport | null,
    deliveryFetch?: SendDeliveryFetcher | null,
  ) { super(pathSandbox, sessionLookup, copyDeps, wechat, feishu, dingtalk, sendBytesSupport, deliveryFetch); }

  getName(): string { return 'send_image'; }
  getDescription(): string {
    return `把一张图片发到当前会话。${SEND_TOOL_BASE_PROMPT}`;
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
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        channel: { type: 'string' },
        channelStatus: { type: 'string' },
        filename: { type: 'string' },
        delivery: { type: 'object' },
        error: { type: 'string' },
      },
    };
  }
  getToolPrompt(): string | null {
    return `send_image：把一张图片发到当前会话。${SEND_TOOL_BASE_PROMPT}图片格式支持 PNG/JPG/JPEG/GIF/WebP/BMP，大小不超过 20MB。`;
  }
  protected kind(): 'image' | 'file' { return 'image'; }
  protected maxBytes(): number { return SEND_IMAGE_MAX_BYTES; }
  protected sourceArgName(): string { return 'image'; }
  protected emptyBytesError(): string { return '图片内容为空'; }
}

export class SendFileTool extends SendMediaToolBase {
  constructor(
    pathSandbox: PathSandbox,
    sessionLookup: SendMediaSessionLookup,
    copyDeps: SendCopyDeps,
    wechat: WechatSendStrategy | null,
    feishu: FeishuSendStrategy | null,
    dingtalk: DingtalkSendStrategy | null,
    sendBytesSupport?: SendBytesSupport | null,
    deliveryFetch?: SendDeliveryFetcher | null,
  ) { super(pathSandbox, sessionLookup, copyDeps, wechat, feishu, dingtalk, sendBytesSupport, deliveryFetch); }

  getName(): string { return 'send_file'; }
  getDescription(): string {
    return `把一份文件发到当前会话。${SEND_TOOL_BASE_PROMPT}`;
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        file: { type: 'string', description: '要发送的文件：本地文件路径（工作区相对路径，或允许集内的绝对路径：会话工作区、本人 uploads/{userId} 产物目录、runtime、HOME、/tmp），或 http(s) URL' },
        filename: { type: 'string', description: '可选，发送给对方或展示时使用的文件名，默认取路径 basename' },
      },
      required: ['file'],
    };
  }
  getOutputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        channel: { type: 'string' },
        channelStatus: { type: 'string' },
        filename: { type: 'string' },
        delivery: { type: 'object' },
        error: { type: 'string' },
      },
    };
  }
  getToolPrompt(): string | null {
    return `send_file：把一份文件发到当前会话。${SEND_TOOL_BASE_PROMPT}文件大小不超过 30MB，扩展名不限；绑定的通道可能更严（如钉钉的扩展名白名单），不符合时对话里仍能看到、通道不会收到。`;
  }
  protected kind(): 'image' | 'file' { return 'file'; }
  protected maxBytes(): number { return SEND_FILE_MAX_BYTES; }
  protected sourceArgName(): string { return 'file'; }
  protected emptyBytesError(): string { return '文件内容为空'; }
}
