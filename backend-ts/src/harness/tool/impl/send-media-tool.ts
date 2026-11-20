import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { lookup as mimeLookup } from 'mime-types';
import type { DeliveryWorkspaceRef } from '@mao/contracts';
import { BaseTool } from '../tool.js';
import { asText, errorJson, parseObject, toJson } from '../json.js';
import { ImageFileSupport } from '../image-file-support.js';
import {
  loadSendFileBytesDetailed,
  SendBytesNotFoundError,
  type SendBytesSupport,
} from './send-file-bytes.js';
import { toStaticUploadBase } from './generate-image-tool.js';
import { isUnder, SecurityException, type PathSandbox } from '../../safety/path-sandbox.js';
import { StrictPathResolver } from '../../safety/strict-path.js';
import { experienceDirForSession, isExperienceMountRelative } from '../../experience/experience-mount-path.js';
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
  /** 团队经验挂载解析用（活引用资格判定把经验目录来源排除在 ref 外）。 */
  agentId?: number | null;
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

/** 活引用 delivery 载荷（与 @mao/contracts 的 SendDelivery 对齐；副本链路的 delivery 同构）。 */
export interface SendRefDelivery {
  kind: 'image' | 'file';
  filename: string;
  mime: string;
  bytes?: number;
  url?: string;
  ref?: DeliveryWorkspaceRef;
}

/**
 * 活引用结果合并（§4.2）：ref / 原地引用侧恒 ok——chat-only 恒 success=true；
 * 绑通道 push 失败（含 loadBytes 读字节失败）只算通道侧失败，沿用今天
 * 「副本成功 + 推送失败」的形状（success=true + 通道侧 error），仅文案去掉
 * 「已放入当前对话」前缀。副本回落路径仍走 combineSendResult，一字不改。
 */
export function combineSendRefResult(
  filename: string,
  channel: SendChannel,
  delivery: SendRefDelivery,
  push: ChannelPushResult,
): string {
  const channelStatus: 'skipped' | 'sent' | 'failed' = channel === 'chat' ? 'skipped' : (push.ok ? 'sent' : 'failed');
  const error = channel !== 'chat' && !push.ok
    ? `${CHANNEL_LABELS[channel]}发送失败：${push.error}`
    : null;
  const result: Record<string, unknown> = { success: true, channel, channelStatus, filename, delivery };
  if (error != null) result.error = error;
  return toJson(result);
}

// ─────────────────────────── 活引用资格判定（2026-11-20-send-media-live-reference §5.1） ───────────────────────────

/**
 * 工作区活引用 oracle（D5）：与 `GET /v1/files/workspace-download` 同一个
 * `WorkspaceBrowseService.downloadFile`——同一 resolvePath、同一套存在性 / 普通文件 /
 * 符号链接检查，不读字节。缺省（未装配）时活引用整体关闭，全部走会话副本。
 */
export interface SendWorkspaceRefOracle {
  downloadFile(
    sessionWorkspace: string,
    relativePath: string | null | undefined,
    experienceDir?: string | null,
  ): { path: string; size: number; fileName: string };
}

/** 命中活引用时的装配结果：工作区 ref（形态 A）或 uploads 原地引用（形态 B）。 */
export type SendLiveRef =
  | { form: 'workspace'; ref: DeliveryWorkspaceRef; absPath: string; mime: string; bytes: number }
  | { form: 'uploads'; url: string; mime: string; bytes: number | null };

/** 判定结果：命中 ref、硬性失败（现状文案直接报错）或回落副本链路。 */
export type SendRefDecision =
  | { action: 'ref'; live: SendLiveRef }
  | { action: 'error'; error: string }
  | { action: 'copy' };

/** send_image 原地引用允许的扩展名（今天 http 来源要过 COPY_IMAGE_MIMES 字节嗅探；引用化不读字节，以扩展名近似把关）。 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

/** 读文件头 count 字节（图片嗅探用；不读全量）。 */
function readHeadBytes(filePath: string, count: number): Buffer {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(count);
    const read = readSync(fd, buf, 0, count, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * uploads 静态 URL 是否指向发送者本人的目录（形态 B URL 形态）：URL 路径中
 * `uploads` 段的下一跳必须严格等于发送者 userId（段精确匹配，`uploads/77` 不算 7）。
 */
export function isOwnUploadsUrl(source: string, userId: number | null): boolean {
  if (userId == null || !/^https?:\/\//i.test(source)) return false;
  try {
    const segments = new URL(source).pathname.split('/').filter((s) => s !== '');
    const idx = segments.indexOf('uploads');
    return idx >= 0 && segments[idx + 1] === String(userId) && segments.length > idx + 2;
  } catch {
    return false;
  }
}

/**
 * URL 的 host 是否与本站上传静态 origin 一致（形态 B URL 形态的 host 把关，评审补充）：
 * 路径段命中只说明「长得像本站上传地址」，不看 host 的话 `https://evil.com/uploads/7/x.png`
 * 也会被原地引用，等于指使浏览器打向任意外域 / localhost（且该形态不做大小校验）。
 * origin 解析失败（空串）一律不命中，回落副本链路。
 */
function isSameUploadOrigin(source: string, origin: string): boolean {
  if (origin === '') return false;
  try {
    return new URL(source).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/** 扩展名 → mime（与 workspace-download 响应头同口径：mimeLookup + octet-stream 兜底）。 */
function mimeForExtension(ext: string): string {
  return mimeLookup(ext) || 'application/octet-stream';
}

/** 工作区相对路径归一化（POSIX 分隔；供 ref.path 落盘）。 */
function toWorkspaceRelative(workspace: string, absPath: string): string | null {
  const rel = path.relative(path.resolve(workspace), path.resolve(absPath));
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') return null;
  return rel.split(path.sep).join('/');
}

// ─────────────────────────── 两个新工具 ───────────────────────────

const SEND_TOOL_BASE_PROMPT = '网页、桌面、安卓打开这条会话时，附件出现在该轮回复下方。这条会话若绑定了微信、飞书或钉钉，同一份内容再发给对应的用户或群。支持本地文件路径（工作区相对路径，或允许集内的绝对路径：会话工作区、本人 uploads/{userId} 产物目录、runtime、HOME、/tmp）或 http(s) URL。发送会话工作区内的文件时不做副本，附件直接引用工作区里的这份文件：之后修改或删除源文件，会话里看到的附件会跟着变化或失效；要交付「定稿快照」就先复制一份再发。发送你自己 uploads 目录里已有的文件（如生成图）同样直接引用。结果含 error 时，向用户说明原因。结果里已有 delivery，或 channelStatus 为 sent 的那一侧已经完成，不要把同一份内容再发一次。';

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
    protected readonly workspaceRefOracle?: SendWorkspaceRefOracle | null,
    protected readonly experienceDirForAgent?: ((agentId: number) => string) | null,
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

  /**
   * 活引用资格判定（2026-11-20-send-media-live-reference §5.1 三步，顺序执行，命中即走引用分支）：
   * 1. 工作区活引用（形态 A，仅 CLOUD、非 http(s)）：downloadFile 同一解析器预检（D5），
   *    且归一化相对路径不以经验挂载开头（经验目录来源不做引用）→ ref；send_image 追加
   *    读 16 字节嗅探（不读全量），不合格按现状文案报错。
   * 2. uploads 原地引用（形态 B）：本人 uploads 的 http(s) URL（段精确匹配）或经 extraRoots
   *    解析后落在本人 uploads 目录内的路径；扩展名可用才命中（可执行内容照旧回落净化），
   *    send_image 追加图片扩展名检查（引用化不读字节，无法字节嗅探）。
   * 3. 都不命中 → 回落会话副本链路。
   * 上限语义（评审补充）：形态 A 用 stat size、形态 B 路径形态用 stat 套用既有上限，
   * 超限回落副本链路（loadBytes 报与今天一致的「文件过大」）；形态 A 空文件按现状文案报错；
   * 形态 B URL 形态不 stat、bytes 省略。downloadFile 抛错一律回落——错误文案由 loadBytes
   * 与今天完全同路径地给出，不在资格判定里另造一套。
   */
  protected async decideLiveRef(
    source: string,
    session: SendMediaSession | null,
    ctx: { userId: number | null; sessionId: number | null; workspace: string | null },
  ): Promise<SendRefDecision> {
    const kind = this.kind();
    const isHttp = /^https?:\/\//i.test(source);

    // ── 1. 工作区活引用（形态 A）──
    if (!isHttp
      && session != null
      && session.executionMode !== 'LOCAL'
      && session.workspace != null && session.workspace.trim() !== ''
      && ctx.sessionId != null
      && this.workspaceRefOracle != null) {
      const experienceDir = experienceDirForSession(session, this.experienceDirForAgent ?? undefined);
      try {
        const resolved = this.workspaceRefOracle.downloadFile(session.workspace, source, experienceDir);
        const rel = toWorkspaceRelative(session.workspace, resolved.path);
        // 经验挂载命中（含绝对路径经挂载解析）→ 不进 ref，回落副本链路（§2.2）
        if (rel != null && !isExperienceMountRelative(rel)) {
          if (resolved.size === 0) return { action: 'error', error: this.emptyBytesError() };
          if (resolved.size > this.maxBytes()) return { action: 'copy' };
          if (kind === 'image') {
            const sniffed = sniffImageMime(readHeadBytes(resolved.path, 16));
            if (sniffed == null || !COPY_IMAGE_MIMES.has(sniffed)) {
              return { action: 'error', error: '不支持的图片格式（副本支持 PNG/JPG/JPEG/GIF/WebP/BMP）' };
            }
          }
          return {
            action: 'ref',
            live: {
              form: 'workspace',
              ref: { type: 'workspace', sessionId: ctx.sessionId, path: rel },
              absPath: resolved.path,
              mime: mimeForExtension(path.extname(resolved.path)),
              bytes: resolved.size,
            },
          };
        }
      } catch {
        // 文件不存在 / 不是普通文件 / 路径拒绝：继续形态 B / 回落副本链路，
        // 错误文案由 loadBytes 与今天同路径给出，资格判定不另造一套
      }
    }

    // ── 2. uploads 原地引用（形态 B）──
    if (ctx.userId != null) {
      let absPath: string | null = null;
      let size: number | null = null;
      let extSource: string | null = null;
      if (isOwnUploadsUrl(source, ctx.userId)) {
        // URL 形态：不 stat、bytes 省略（§4.1 评审补充）；扩展名取 URL 路径。
        // host 还必须与本站上传 origin 一致（评审补充）：路径段像不等于就是本站文件，
        // 外域一律回落副本链路，不把外域地址原样塞进 delivery.url。
        const origin = await this.resolveUploadOrigin();
        if (isSameUploadOrigin(source, origin)) extSource = source;
      } else if (!isHttp) {
        try {
          const primaryRoot = ctx.workspace != null && ctx.workspace !== ''
            ? ctx.workspace
            : this.pathSandbox.getEffectiveWorkspaceRoot(null);
          const resolved = new StrictPathResolver(primaryRoot, this.sendBytesSupport?.extraRoots(ctx.userId) ?? []).resolve(source);
          const uploadsDir = path.join(this.copyDeps.uploadDir, String(ctx.userId));
          if (isUnder(resolved, uploadsDir) && statSync(resolved).isFile()) {
            absPath = resolved;
            size = statSync(resolved).size;
            extSource = source;
          }
        } catch {
          // 越界 / 不存在：回落副本链路（他人 uploads 等错误文案仍由 loadBytes 给出）
        }
      }
      if (extSource != null) {
        const ext = deriveSendCopyExtension(extSource);
        if (ext !== '.bin') {
          if (kind === 'image' && !IMAGE_EXTENSIONS.has(ext.slice(1).toLowerCase())) {
            return { action: 'copy' };
          }
          if (size != null && size > this.maxBytes()) return { action: 'copy' };
          if (absPath == null) {
            // URL 形态：delivery.url 原样指向既有文件（评审补充：不下载不重写）
            return { action: 'ref', live: { form: 'uploads', url: source, mime: mimeForExtension(ext), bytes: null } };
          }
          // 路径形态：URL 由 toStaticUploadBase 口径拼出；origin 解析失败回落副本链路
          const origin = await this.resolveUploadOrigin();
          // 相对 uploads 根（而非 basename）拼 URL：{uploadDir}/{userId} 按用户挂进容器，
          // Agent 能在里面建子目录，取 basename 会拼出错误 URL 甚至让不同文件撞同一个地址
          const relPath = toWorkspaceRelative(path.join(this.copyDeps.uploadDir, String(ctx.userId)), absPath);
          if (origin !== '' && relPath != null) {
            return {
              action: 'ref',
              live: {
                form: 'uploads',
                url: `${origin}/uploads/${String(ctx.userId)}/${relPath.split('/').map(encodeURIComponent).join('/')}`,
                mime: mimeForExtension(ext),
                bytes: size,
              },
            };
          }
        }
      }
    }

    return { action: 'copy' };
  }

  private async resolveUploadOrigin(): Promise<string> {
    try {
      const baseUrl = await this.copyDeps.getUploadBaseUrl();
      return toStaticUploadBase(baseUrl, this.copyDeps.uploadContextPath ?? '/api');
    } catch (e) {
      harnessLog('warn', 'send live-ref uploads origin resolve failed', e);
      return '';
    }
  }

  /** ref 形态 delivery 组装：形态 A 带 ref、形态 B 带 url，均带 filename（与形态 A 对齐，Agent 自定义文件名时不丢）。 */
  private buildRefDelivery(live: SendLiveRef, filename: string): SendRefDelivery {
    if (live.form === 'workspace') {
      return { kind: this.kind(), filename, mime: live.mime, bytes: live.bytes, ref: live.ref };
    }
    const delivery: SendRefDelivery = { kind: this.kind(), url: live.url, mime: live.mime, filename };
    if (live.bytes != null) delivery.bytes = live.bytes;
    return delivery;
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
      const decision = await this.decideLiveRef(source, session, { userId, sessionId, workspace });
      if (decision.action === 'error') return errorJson(decision.error);
      const filename = asText(args.filename) || basenameOfSource(source);
      if (decision.action === 'ref') {
        // 活引用分支：chat-only 不读全量字节；绑通道仍读全量推送（推送需要），
        // loadBytes 失败只算通道侧失败（§4.2 评审补充），两侧不写副本
        const delivery = this.buildRefDelivery(decision.live, filename);
        let push: ChannelPushResult = { ok: true, error: null };
        const strategy = this.strategyFor(channel);
        if (strategy != null) {
          try {
            const loaded = await this.loadBytes(source, { userId, sessionId, workspace }, this.maxBytes(), session?.executionMode ?? null);
            const pushInput = { sessionId, parentSessionId: session?.parentSessionId ?? null, userId, bytes: loaded.bytes, filename };
            push = kind === 'image' ? await strategy.pushImage(pushInput) : await strategy.pushFile(pushInput);
          } catch (e) {
            harnessLog('warn', `send ${kind} channel push bytes failed channel=${channel}`, e);
            push = { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }
        return combineSendRefResult(filename, channel, delivery, push);
      }
      let loaded: { bytes: Buffer; contentType: string | null };
      try {
        loaded = await this.loadBytes(source, { userId, sessionId, workspace }, this.maxBytes(), session?.executionMode ?? null);
      } catch (e) {
        // 读字节失败：还没有两侧，只有 error（§4.3）
        return errorJson(e instanceof Error ? e.message : String(e));
      }
      const bytes = loaded.bytes;
      if (bytes.length === 0) return errorJson(this.emptyBytesError());
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
    workspaceRefOracle?: SendWorkspaceRefOracle | null,
    experienceDirForAgent?: ((agentId: number) => string) | null,
  ) {
    super(pathSandbox, sessionLookup, copyDeps, wechat, feishu, dingtalk, sendBytesSupport, deliveryFetch, workspaceRefOracle, experienceDirForAgent);
  }

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
    workspaceRefOracle?: SendWorkspaceRefOracle | null,
    experienceDirForAgent?: ((agentId: number) => string) | null,
  ) {
    super(pathSandbox, sessionLookup, copyDeps, wechat, feishu, dingtalk, sendBytesSupport, deliveryFetch, workspaceRefOracle, experienceDirForAgent);
  }

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
