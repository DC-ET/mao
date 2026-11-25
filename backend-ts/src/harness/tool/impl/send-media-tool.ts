import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { lookup as mimeLookup } from 'mime-types';
import type { DeliveryRef } from '@mao/contracts';
import { BaseTool } from '../tool.js';
import { asText, errorJson, parseObject, toJson } from '../json.js';
import { ImageFileSupport } from '../image-file-support.js';
import {
  openSendBytesStream,
  SendBytesNotFoundError,
  type SendBytesStream,
  type SendBytesSupport,
} from './send-file-bytes.js';
import { toStaticUploadBase } from './generate-image-tool.js';
import { isUnder, SecurityException, type PathSandbox } from '../../safety/path-sandbox.js';
import { StrictPathResolver } from '../../safety/strict-path.js';
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
import { ToolCancelContext } from '../tool-cancel-context.js';

/**
 * 统一发送图片 / 文件（技术方案 2026-11-18-unified-send-media + 2026-11-24-send-file-snapshot）：
 * `send_image` / `send_file` 收编六个通道发送工具。除本人 uploads 的既有文件走原地引用
 * （形态 B）外，其余来源一律在发送时落一份**快照**（本地 `FILE_SEND_DIR/{userId}/` 或云私有
 * 前缀 `send-files/`），消息只记快照 id，对话页经带属主鉴权的下载接口取字节——
 * 之后工作区怎么删、怎么改都不影响已经发出的附件。
 * 会话绑定了微信 / 飞书 / 钉钉再用内存里同一份字节额外推送，两侧独立成败（D8）。
 * 六个旧类的发送逻辑移进下面的策略，类本身已删除。
 */

export const SEND_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/**
 * 对话页快照上限（技术方案 2026-11-25-send-file-1gb）：1GB 只抬「发给用户的那一份」，
 * 图片仍 20MB，微信 / 钉钉 20MB、飞书 30MB 的通道上限不动。三端同名常量必须同值
 * （backend-ts / 桌面 delivery-fetch / agent-cli file-fetch）。
 */
export const SEND_FILE_MAX_BYTES = 1024 * 1024 * 1024;

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

/**
 * 快照存储（技术方案 2026-11-24-send-file-snapshot D3）：由 file 域的 SendFileService 实现，
 * 工具只依赖接口——本地 / 多云分流、插表与补偿删除都在实现里，工具不碰存储凭据。
 */
export interface SendFileStore {
  save(input: {
    userId: number;
    sessionId: number | null;
    filename: string;
    mime: string;
    ext: string;
    /** 源端声明大小；未知长度（http 无 Content-Length）为 null，边写边计。 */
    declaredSize: number | null;
    /** 来源流：失败时服务侧会销毁它（调用方也可自行销毁，destroy 幂等）。 */
    body: Readable;
    /** 声明大小与实际读出字节必须一致（宿主机 / Docker / LOCAL 来源）。 */
    verifySize?: boolean;
    /** 需要回传给通道推送的字节上限（chat 会话 / 超过通道上限时为 0）。 */
    captureBytes?: number;
    /** 大文件并发闸（R5）：通道会话超过通道上限、对话页超过 20MB 时置 true。 */
    gateLargeFile?: boolean;
    /** 本轮取消信号（R4）。 */
    cancel?: { get(): boolean } | null;
    /**
     * 完整性校验（R8）：设置后边写边算 sha256，提交前调用；抛错即按校验失败收口
     * （删除临时文件、不插表）。http / 宿主机来源不传。
     */
    verifyDigest?: (sha256: string) => Promise<void>;
  }): Promise<{
    ok: true;
    id: string;
    mime: string;
    bytes: number;
    captured?: Buffer;
  } | { ok: false; error: string }>;
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

/** 通道侧超限文案：与各策略内部同口径（图片 / 文件 + MB 数）。 */
function overloadError(kind: 'image' | 'file', channelMax: number): string {
  const label = kind === 'image' ? '图片' : '文件';
  return `${label}超过 ${Math.floor(channelMax / (1024 * 1024))}MB 上限`;
}

/**
 * 取流的前 headBytes 字节用于魔数嗅探，再返回一个「头 + 剩余」的续接流（D2）。
 * 不缓冲剩余部分：`Readable.from` 按需从同一迭代器拉取，下游 pipe 的背压原样生效。
 * 首块可能大于 headBytes（http / 文件流常见 64KB），整块保留在 head 里，不重复消费。
 */
async function splitStreamHead(
  stream: Readable,
  headBytes: number,
): Promise<{ head: Buffer; rest: Readable }> {
  const iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < headBytes) {
    const { value, done } = await iterator.next();
    if (done) break;
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    chunks.push(buf);
    total += buf.length;
  }
  const head = Buffer.concat(chunks);
  const rest = Readable.from((async function* replay() {
    try {
      if (head.length > 0) yield head;
      while (true) {
        const { value, done } = await iterator.next();
        if (done) return;
        yield value;
      }
    } finally {
      await iterator.return?.(undefined);
    }
  })(), { highWaterMark: 64 * 1024 });
  return { head, rest };
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
export const WECHAT_MAX_BYTES = 20 * 1024 * 1024;
export const DINGTALK_MAX_BYTES = 20 * 1024 * 1024;
export const FEISHU_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const FEISHU_FILE_MAX_BYTES = 30 * 1024 * 1024;

/**
 * 通道侧单文件上限（技术方案 2026-11-25 D1）：大于它的文件不读一份字节去推通道，
 * 直接 `channelStatus = failed`；对话页快照照常成功。chat 会话返回 0（不需要推送）。
 */
export function channelMaxBytes(kind: 'image' | 'file', channel: SendChannel): number {
  if (channel === 'chat') return 0;
  if (channel === 'wechat') return WECHAT_MAX_BYTES;
  if (channel === 'dingtalk') return DINGTALK_MAX_BYTES;
  return kind === 'image' ? FEISHU_IMAGE_MAX_BYTES : FEISHU_FILE_MAX_BYTES;
}

/**
 * 大文件并发闸阈值（R5）：通道会话按自身通道上限判定，对话页没有通道上限，
 * 按三家通道里最严的 20MB 判定——1GB 发送的主战场正是对话页，整类跳过等于 R5 对大文件失效。
 */
export const LARGE_SEND_GATE_BYTES = WECHAT_MAX_BYTES;

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

/**
 * 快照结果合并（D8 + 2026-11-24 D3）：快照成功即 `success`，通道推送失败只算通道侧失败
 * （沿用今天「副本成功 + 推送失败」的形状，`success=true` + 通道侧 error）。
 * 快照失败但推送成功仍是 `success=true` + 「对话页保存失败」——与今天副本链路口径一致，
 * 不因为「快照是主路径」就改成功位，否则已绑通道的会话结果语义会漂移。
 */
export function combineSendResult(
  kind: 'image' | 'file',
  filename: string,
  channel: SendChannel,
  snapshot: SendSnapshotOutcome,
  push: ChannelPushResult,
  downloadLink: SendDownloadLink | null = null,
): string {
  const channelLabel = channel === 'chat' ? null : CHANNEL_LABELS[channel];
  const channelStatus: 'skipped' | 'sent' | 'failed' = channel === 'chat' ? 'skipped' : (push.ok ? 'sent' : 'failed');
  // 消息只记快照 id：不写磁盘路径、不写云厂商 URL、不写 token
  const delivery = snapshot.ok
    ? { kind, filename, mime: snapshot.mime, bytes: snapshot.bytes, ref: { type: 'send-file' as const, id: snapshot.id } }
    : null;
  let success: boolean;
  let error: string | null;
  if (channel === 'chat') {
    // 无外部通道：唯一一侧是快照，push 不参与（D8 单侧）
    success = snapshot.ok;
    error = snapshot.ok ? null : `对话页保存失败：${snapshot.error}`;
  } else if (snapshot.ok && push.ok) {
    success = true;
    error = null;
  } else if (snapshot.ok) {
    success = true;
    error = `已放入当前对话，${channelLabel}发送失败：${push.error}`;
  } else if (push.ok) {
    success = true;
    error = `已发到${channelLabel}，对话页保存失败：${snapshot.error}`;
  } else {
    success = false;
    error = channelLabel
      ? `${channelLabel}发送失败：${push.error}；对话页保存失败：${snapshot.error}`
      : `对话页保存失败：${snapshot.error}`;
  }
  const result: Record<string, unknown> = { success, channel, channelStatus, filename };
  if (delivery != null) result.delivery = delivery;
  // 通道失败时的兜底下载链接：结构化字段 + 写进 error，保证模型不改写也能把链接给到用户
  if (downloadLink != null) {
    result.downloadUrl = downloadLink.url;
    result.downloadUrlExpiresAt = new Date(downloadLink.expiresAt).toISOString();
    const note = `下载链接（${downloadLink.ttlHours} 小时内有效，请勿转发）：${downloadLink.url}`;
    error = error == null ? note : `${error}；${note}`;
  }
  if (error != null) result.error = error;
  return toJson(result);
}

/** 快照落盘结果：成功带 id（消息只记它），失败带原因（通道推送仍照常尝试）。 */
export type SendSnapshotOutcome =
  | { ok: true; id: string; mime: string; bytes: number }
  | { ok: false; error: string };

/**
 * 通道发送失败时给用户的兜底下载链接（2026-11-25 追加）。
 *
 * 外部通道有硬上限（微信 / 钉钉 20MB、飞书 30MB），超过时对话页能收到、通道收不到；
 * 只回「请去网页/客户端下载」用户还得自己找，所以这里直接给一条带短时票据的下载地址。
 * 票据是 bearer 凭证（见 `SendDownloadTicketService`）：拿到链接即可下载、到期自动失效，
 * 因此只在通道失败时签发，并在文案里明确有效期与「请勿转发」。
 */
export interface SendDownloadLink {
  url: string;
  /** epoch 毫秒，与票据过期时间同源。 */
  expiresAt: number;
  /** 有效期小时数（文案用，来自票据 TTL 常量）。 */
  ttlHours: number;
}

/** 签发兜底下载链接：未装配 / 拿不到 baseUrl / 签发失败一律返回 null（不影响发送结果）。 */
export type SendDownloadLinkIssuer = (
  fileId: string,
  userId: number,
) => Promise<SendDownloadLink | null>;

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

/**
 * 投递载荷：形态 B 带 url（原地引用），快照带 ref（send-file）。
 * `ref` 类型取自 `@mao/contracts` 的 `DeliveryRef`——`'workspace'` 只服务存量消息，
 * 新发送不再写出。均带 filename（Agent 自定义文件名时不丢）。
 */
export interface SendRefDelivery {
  kind: 'image' | 'file';
  filename: string;
  mime: string;
  bytes?: number;
  url?: string;
  ref?: DeliveryRef;
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

// ─────────────────────────── 原地引用资格判定（2026-11-20-send-media-live-reference §5.1；2026-11-24 收缩为形态 B） ───────────────────────────

/** 命中原地引用时的装配结果：uploads 既有文件（形态 B），消息带 url 不落快照。 */
export type SendLiveRef = { form: 'uploads'; url: string; mime: string; bytes: number | null };

/** 判定结果：命中原地引用，或回落快照链路。 */
export type SendRefDecision =
  | { action: 'ref'; live: SendLiveRef }
  | { action: 'copy' };

/** send_image 原地引用允许的扩展名（引用化不读字节，以扩展名近似把关）。 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

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

const SEND_TOOL_BASE_PROMPT = '网页、桌面、安卓打开这条会话时，附件出现在该轮回复下方。这条会话若绑定了微信、飞书或钉钉，同一份内容再发给对应的用户或群。支持本地文件路径（工作区相对路径，或允许集内的绝对路径：会话工作区、本人 uploads/{userId} 产物目录、runtime、HOME、/tmp）或 http(s) URL。发给用户的工作区文件会在发送时另存一份快照，之后修改或删除源文件不影响已经发出的附件。发送你自己 uploads 目录里已有的文件（如生成图）仍直接引用，删除原文件后附件会失效。结果含 error 时，向用户说明原因。结果里已有 delivery，或 channelStatus 为 sent 的那一侧已经完成，不要把同一份内容再发一次。通道发送失败但对话页已保存时，结果会额外带 downloadUrl 与 downloadUrlExpiresAt（原地引用的 uploads 直链则在 delivery.url，长期有效）：请把这条链接原样告诉用户（带有效期时说明「有效期内可用、请勿转发」），不要只说去网页或客户端查看；通道发送成功时不要粘贴或编造链接。';

/** LOCAL 读本机文件的执行端拉取（D10）：缺省 null（未装配时 LOCAL 本机路径直接失败）。 */
export interface SendDeliveryFetcher {
  /**
   * 打开发送字节流（2026-11-25 R2）：执行端按服务端区间请求逐片回传，
   * `size` 为执行端 open 时 stat 的大小，用于写入前的磁盘 / 上限判断。
   */
  openStream(
    sessionId: number,
    userId: number | null,
    filePath: string,
    workspace: string | null | undefined,
    maxBytes: number,
  ): Promise<{
    ok: true;
    stream: Readable;
    size: number;
    /** 执行端整份 sha256（R8）：写入完成后比对。 */
    digest: () => Promise<string>;
    /** 释放执行端句柄（摘要比对后显式调用）。 */
    close: () => void;
  } | { ok: false; error: string }>;
}

abstract class SendMediaToolBase extends BaseTool {
  constructor(
    protected readonly pathSandbox: PathSandbox,
    protected readonly sessionLookup: SendMediaSessionLookup,
    protected readonly copyDeps: SendCopyDeps,
    protected readonly wechat: WechatSendStrategy | null,
    protected readonly feishu: FeishuSendStrategy | null,
    protected readonly dingtalk: DingtalkSendStrategy | null,
    protected readonly sendFileStore: SendFileStore,
    protected readonly sendBytesSupport?: SendBytesSupport | null,
    protected readonly deliveryFetch?: SendDeliveryFetcher | null,
    /** 通道失败时的兜底下载链接签发（未装配 = 不给链接）。 */
    protected readonly downloadLinkIssuer?: SendDownloadLinkIssuer | null,
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
   * 打开发送来源的流（2026-11-25 D2）：本地路径优先容器，宿主机读不到且是 LOCAL 会话时
   * 回退执行端按区间拉取（R2）。跨成员预检、容器读失败、超限、符号链接越界不回退，
   * 避免把安全 / 大小问题掩盖成执行端超时。
   *
   * `verifySize` 表示「源端声明的大小与读出字节必须一致」：宿主机 / Docker / LOCAL 置 true，
   * http 来源不校验（对端可能压缩或谎报长度）。
   */
  protected async openSource(
    source: string,
    ctx: { userId: number | null; sessionId: number | null; workspace: string | null },
    maxBytes: number,
    executionMode: string | null | undefined,
  ): Promise<{
    stream: Readable;
    size: number | null;
    contentType: string | null;
    verifySize: boolean;
    digest?: () => Promise<string>;
    close?: () => void | Promise<void>;
  }> {
    const isHttp = /^https?:\/\//i.test(source);
    try {
      const opened: SendBytesStream = await openSendBytesStream(
        source, this.pathSandbox, this.sendBytesSupport ?? null, ctx, maxBytes,
      );
      return { ...opened, verifySize: !isHttp };
    } catch (e) {
      // 宿主机文件不存在 / 路径在服务端沙箱根外（LOCAL 本机路径在服务器上必然如此）才回退
      const hostMissing = e instanceof SendBytesNotFoundError || e instanceof SecurityException;
      if (executionMode === 'LOCAL' && !isHttp && hostMissing && ctx.sessionId != null && this.deliveryFetch != null) {
        const sid = ctx.sessionId as number;
        const opened = await this.deliveryFetch.openStream(sid, ctx.userId, source, ctx.workspace, maxBytes);
        if (opened.ok) {
          return {
            stream: opened.stream,
            size: opened.size,
            contentType: null,
            verifySize: true,
            digest: opened.digest,
            close: opened.close,
          };
        }
        throw new Error(opened.error);
      }
      throw e;
    }
  }

  /** 读一次完整字节（上限 = 调用方给的 maxBytes）；只服务通道推送等小文件场景。 */
  protected async loadBytes(
    source: string,
    ctx: { userId: number | null; sessionId: number | null; workspace: string | null },
    maxBytes: number,
    executionMode: string | null | undefined,
  ): Promise<{ bytes: Buffer; contentType: string | null }> {
    const opened = await this.openSource(source, ctx, maxBytes, executionMode);
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of opened.stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += buf.length;
        if (total > maxBytes) {
          opened.stream.destroy();
          throw new Error(`文件过大，上限 ${Math.floor(maxBytes / (1024 * 1024))}MB`);
        }
        chunks.push(buf);
      }
      return { bytes: Buffer.concat(chunks), contentType: opened.contentType };
    } finally {
      await opened.close?.();
    }
  }

  /**
   * 原地引用资格判定（2026-11-20-send-media-live-reference §5.1；2026-11-24 起只剩形态 B）：
   *
   * 形态 A（工作区活引用）已废止——「发送」表示把这一份交给用户，把附件生命周期绑在
   * 源文件上和这个语义相反，Agent 的收尾清理会让卡片失效。工作区来源现在一律进快照。
   * 存量消息里的 `ref.type === 'workspace'` 仍由前端照常渲染，本工具不再写出。
   *
   * 形态 B（本人 uploads 既有文件）：URL 形态要求绝对 http(s) 且 `uploads` 段下一跳严格
   * 等于发送者 userId，且 host 与本站上传 origin 一致；路径形态经 StrictPathResolver 解析后
   * 落在 `{uploadDir}/{userId}` 内且是普通文件。两者都要求扩展名可用（可执行内容照旧回落
   * 净化），send_image 追加图片扩展名检查（引用化不读字节，无法字节嗅探）。
   * 都不命中 → 回落快照链路。
   *
   * 上限语义：路径形态用 stat 套用既有上限，超限回落快照（loadBytes 报与今天一致的「文件过大」）；
   * URL 形态不 stat、bytes 省略。downloadFile 抛错一律回落——错误文案由 loadBytes 给出，
   * 资格判定不另造一套。
   */
  protected async decideLiveRef(
    source: string,
    ctx: { userId: number | null; sessionId: number | null; workspace: string | null },
  ): Promise<SendRefDecision> {
    const kind = this.kind();
    const isHttp = /^https?:\/\//i.test(source);
    if (ctx.userId == null) return { action: 'copy' };

    let absPath: string | null = null;
    let size: number | null = null;
    let extSource: string | null = null;
    if (isOwnUploadsUrl(source, ctx.userId)) {
      // URL 形态：不 stat、bytes 省略（§4.1 评审补充）；扩展名取 URL 路径。
      // host 还必须与本站上传 origin 一致（评审补充）：路径段像不等于就是本站文件，
      // 外域一律回落快照，不把外域地址原样塞进 delivery.url。
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
        // 越界 / 不存在：回落快照链路（他人 uploads 等错误文案仍由 loadBytes 给出）
      }
    }
    if (extSource == null) return { action: 'copy' };
    const ext = deriveSendCopyExtension(extSource);
    if (ext === '.bin') return { action: 'copy' };
    if (kind === 'image' && !IMAGE_EXTENSIONS.has(ext.slice(1).toLowerCase())) {
      return { action: 'copy' };
    }
    if (size != null && size > this.maxBytes()) return { action: 'copy' };
    if (absPath == null) {
      // URL 形态：delivery.url 原样指向既有文件（评审补充：不下载不重写）
      return { action: 'ref', live: { form: 'uploads', url: source, mime: mimeForExtension(ext), bytes: null } };
    }
    // 路径形态：URL 由 toStaticUploadBase 口径拼出；origin 解析失败回落快照链路
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

  /**
   * 通道失败时的兜底下载链接（2026-11-25）：签发失败 / 未装配 / 拿不到 baseUrl 一律返回 null，
   * 绝不让链接问题影响发送结果本身。
   */
  private async issueDownloadLink(fileId: string, userId: number): Promise<SendDownloadLink | null> {
    if (this.downloadLinkIssuer == null) return null;
    try {
      return await this.downloadLinkIssuer(fileId, userId);
    } catch (e) {
      harnessLog('warn', 'send download link issue failed', e);
      return null;
    }
  }

  /** 原地引用 delivery 组装：形态 B 带 url，均带 filename（Agent 自定义文件名时不丢）。 */
  private buildRefDelivery(live: SendLiveRef, filename: string): SendRefDelivery {
    const delivery: SendRefDelivery = { kind: this.kind(), url: live.url, mime: live.mime, filename };
    if (live.bytes != null) delivery.bytes = live.bytes;
    return delivery;
  }

  protected override async executeWithUser(argumentsJson: string, sessionId: number | null, userId: number | null, workspace: string | null): Promise<string> {
    const kind = this.kind();
    const argName = this.sourceArgName();
    try {
      if (ToolCancelContext.current()?.get()) return errorJson('发送已取消');
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
      const filename = asText(args.filename) || basenameOfSource(source);
      const channelMax = channelMaxBytes(kind, channel);
      const decision = await this.decideLiveRef(source, { userId, sessionId, workspace });
      if (decision.action === 'ref') {
        // 原地引用分支（形态 B）：chat-only 不读全量字节；绑通道仍读一份推送（≤ 通道上限），
        // loadBytes 失败只算通道侧失败（§4.2 评审补充），两侧都不落快照
        const delivery = this.buildRefDelivery(decision.live, filename);
        let push: ChannelPushResult = { ok: true, error: null };
        const strategy = this.strategyFor(channel);
        if (strategy != null) {
          try {
            if (decision.live.bytes != null && decision.live.bytes > channelMax) {
              push = { ok: false, error: overloadError(kind, channelMax) };
            } else {
              // 已知大小已过闸；URL 形态大小未知，按通道上限读，超限文案落到通道侧
              const loaded = await this.loadBytes(source, { userId, sessionId, workspace }, channelMax, session?.executionMode ?? null);
              const pushInput = { sessionId, parentSessionId: session?.parentSessionId ?? null, userId, bytes: loaded.bytes, filename };
              push = kind === 'image' ? await strategy.pushImage(pushInput) : await strategy.pushFile(pushInput);
            }
          } catch (e) {
            harnessLog('warn', `send ${kind} channel push bytes failed channel=${channel}`, e);
            push = { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }
        return combineSendRefResult(filename, channel, delivery, push);
      }
      // 快照分支（2026-11-24 D1）：没有属主就没有人能下载，按失败处理，不落盘
      if (userId == null) {
        return errorJson('对话页没有可打开的附件地址，保存失败');
      }
      let opened: Awaited<ReturnType<SendMediaToolBase['openSource']>>;
      try {
        opened = await this.openSource(source, { userId, sessionId, workspace }, this.maxBytes(), session?.executionMode ?? null);
      } catch (e) {
        // 打开来源失败：还没有两侧，只有 error（§4.3）
        return errorJson(e instanceof Error ? e.message : String(e));
      }
      try {
        // 头部 64 字节用于图片魔数嗅探与空文件判定；剩余部分原样接回写入流（D2）
        const { head, rest } = await splitStreamHead(opened.stream, 64);
        if (head.length === 0) {
          opened.stream.destroy();
          return errorJson(this.emptyBytesError());
        }
        const ext = deriveSendCopyExtension(source, opened.contentType);
        // 图片一律以字节嗅探为准（扩展名 / content-type 都不能把非图片伪装成图片）；
        // 文件类回落 .bin 时 mime 收敛为 octet-stream，避免客户端按 mime 内联预览绕开扩展名限制
        let mime: string;
        if (kind === 'image') {
          const imageMime = sniffImageMime(head);
          if (imageMime == null || !COPY_IMAGE_MIMES.has(imageMime)) {
            rest.destroy();
            return errorJson('不支持的图片格式（快照支持 PNG/JPG/JPEG/GIF/WebP/BMP）');
          }
          mime = imageMime;
        } else {
          mime = ext === '.bin' ? 'application/octet-stream' : mimeForSendCopy(ext, head, opened.contentType);
        }
        // 超过通道上限：不读那一份推送字节（R1 第 4 步），直接按通道失败收口
        const capturedLimit = channel === 'chat' ? 0 : channelMax;
        const willCapture = channel !== 'chat' && (opened.size == null || opened.size <= channelMax);
        // 大文件并发闸（R5）：chat 没有通道上限，按最严通道上限判定，避免对话页 1GB 并发绕过
        const gateThreshold = channel === 'chat' ? LARGE_SEND_GATE_BYTES : channelMax;
        let snapshot: Awaited<ReturnType<SendFileStore['save']>>;
        try {
          snapshot = await this.sendFileStore.save({
            userId,
            sessionId,
            filename,
            mime,
            ext,
            declaredSize: opened.size,
            body: rest,
            verifySize: opened.verifySize,
            captureBytes: willCapture ? capturedLimit : 0,
            gateLargeFile: opened.size == null || opened.size > gateThreshold,
            cancel: ToolCancelContext.current(),
            // R8：容器 / 执行端来源比对整份 sha256；宿主机与 http 来源不提供 digest
            verifyDigest: opened.digest != null
              ? async (sha256: string) => {
                const remote = await opened.digest!();
                if (remote !== sha256) throw new Error('文件校验失败，请重试');
              }
              : undefined,
          });
        } catch (e) {
          rest.destroy();
          harnessLog('warn', `send ${kind} snapshot failed`, e);
          return errorJson(e instanceof Error ? e.message : String(e));
        }
        if (!snapshot.ok) {
          // save 提前返回（并发闸拒绝 / 磁盘不足 / 声明超限）时来源流可能一次都没被读过，
          // 宿主机 createReadStream 的 fd 在嗅探头部时已分配，必须显式销毁
          rest.destroy();
          if (snapshot.error === '发送已取消') return errorJson('发送已取消');
          // 完整性校验失败是硬失败：不再回源重读去推通道（对话页这份都不可信）
          if (snapshot.error === '文件校验失败，请重试') return errorJson(snapshot.error);
        }
        const strategy = this.strategyFor(channel);
        let push: ChannelPushResult = { ok: true, error: null };
        if (strategy != null) {
          if (ToolCancelContext.current()?.get()) {
            return errorJson('发送已取消');
          }
          if (snapshot.ok && snapshot.captured != null) {
            const pushInput = {
              sessionId, parentSessionId: session?.parentSessionId ?? null, userId,
              bytes: snapshot.captured, filename,
            };
            try {
              push = kind === 'image' ? await strategy.pushImage(pushInput) : await strategy.pushFile(pushInput);
            } catch (e) {
              harnessLog('warn', `send ${kind} channel push failed channel=${channel}`, e);
              push = { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
          } else if (snapshot.ok) {
            // 快照成功但没有回传字节：只可能是超过了通道上限（或空 capture 上限）
            push = { ok: false, error: overloadError(kind, channelMax) };
          } else if (opened.size != null && opened.size > channelMax) {
            push = { ok: false, error: overloadError(kind, channelMax) };
          } else {
            // 快照失败时通道侧仍可能读到同一份来源：小文件才回源重试（≤ 通道上限）
            try {
              const loaded = await this.loadBytes(source, { userId, sessionId, workspace }, channelMax, session?.executionMode ?? null);
              const pushInput = { sessionId, parentSessionId: session?.parentSessionId ?? null, userId, bytes: loaded.bytes, filename };
              push = kind === 'image' ? await strategy.pushImage(pushInput) : await strategy.pushFile(pushInput);
            } catch (e) {
              harnessLog('warn', `send ${kind} channel push bytes failed channel=${channel}`, e);
              push = { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
          }
        }
        // 通道失败但对话页快照成功：给一条带短时票据的下载地址，用户不必自己去网页/客户端找
        const downloadLink = strategy != null && !push.ok && snapshot.ok
          ? await this.issueDownloadLink(snapshot.id, userId)
          : null;
        return combineSendResult(kind, filename, channel, snapshot, push, downloadLink);
      } finally {
        // 释放容器 / 执行端句柄（摘要比对已由 save 的 verifyDigest 在提交前完成）
        await opened.close?.();
      }
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
    sendFileStore: SendFileStore,
    sendBytesSupport?: SendBytesSupport | null,
    deliveryFetch?: SendDeliveryFetcher | null,
    downloadLinkIssuer?: SendDownloadLinkIssuer | null,
  ) {
    super(pathSandbox, sessionLookup, copyDeps, wechat, feishu, dingtalk, sendFileStore, sendBytesSupport, deliveryFetch, downloadLinkIssuer);
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
        downloadUrl: { type: 'string', description: '仅通道发送失败时返回：带短时票据的下载地址' },
        downloadUrlExpiresAt: { type: 'string', description: 'downloadUrl 的过期时间（ISO 8601）' },
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
    sendFileStore: SendFileStore,
    sendBytesSupport?: SendBytesSupport | null,
    deliveryFetch?: SendDeliveryFetcher | null,
    downloadLinkIssuer?: SendDownloadLinkIssuer | null,
  ) {
    super(pathSandbox, sessionLookup, copyDeps, wechat, feishu, dingtalk, sendFileStore, sendBytesSupport, deliveryFetch, downloadLinkIssuer);
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
        downloadUrl: { type: 'string', description: '仅通道发送失败时返回：带短时票据的下载地址' },
        downloadUrlExpiresAt: { type: 'string', description: 'downloadUrl 的过期时间（ISO 8601）' },
        error: { type: 'string' },
      },
    };
  }
  getToolPrompt(): string | null {
    return `send_file：把一份文件发到当前会话。${SEND_TOOL_BASE_PROMPT}文件大小不超过 1GB，扩展名不限；绑定的通道可能更严（微信 / 钉钉 20MB、飞书 30MB，钉钉还有扩展名白名单），超过通道上限时对话里仍能看到、通道不会收到，此时结果里会带可下载的 downloadUrl。较大的文件可能需要数分钟，请等待结果，不要重复调用。`;
  }
  protected kind(): 'image' | 'file' { return 'file'; }
  protected maxBytes(): number { return SEND_FILE_MAX_BYTES; }
  protected sourceArgName(): string { return 'file'; }
  protected emptyBytesError(): string { return '文件内容为空'; }
}
