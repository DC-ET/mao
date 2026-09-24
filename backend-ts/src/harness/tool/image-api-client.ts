import { Buffer } from 'node:buffer';
import { applyClientImpersonationHeaders } from '../llm/client-impersonation-headers.js';
import { ImageFileSupport } from './image-file-support.js';

/** 图片 API 超时：协议默认 10 分钟。 */
export const IMAGE_API_TIMEOUT_MS = 600_000;
/** 改图单文件上限（字节）。 */
export const MAX_EDIT_IMAGE_BYTES = 20 * 1024 * 1024;

const RETRY_DELAYS_MS = [250, 1000, 2500];
const RETRY_STATUS = new Set([429, 502, 503, 504]);

export interface ImageApiConfig {
  /** 服务根地址，含 /v1；客户端会去掉尾部斜杠。 */
  baseUrl: string;
  apiKey: string;
  /** 已归一的完整模型名。 */
  model: string;
  clientImpersonation?: string | null;
}

export interface GenerateImageParams {
  prompt: string;
  n?: number;
  size?: string;
  quality?: string;
}

export interface EditImageFile {
  bytes: Buffer;
  fileName: string;
  mime: string;
}

export interface EditImageParams {
  prompt: string;
  images: EditImageFile[];
  mask?: EditImageFile | null;
  n?: number;
  size?: string;
  quality?: string;
  background?: string;
  outputFormat?: string;
  outputCompression?: number;
}

export interface ImageApiImage {
  bytes: Buffer;
  mime: string;
  source: 'b64_json' | 'url';
  /** 逻辑文件名（含扩展名），供落盘参考。 */
  fileName: string;
}

export interface ImageApiResult {
  images: ImageApiImage[];
  /** 以响应为准，可能与请求不同。 */
  model?: string;
  size?: string;
  revisedPrompt?: string;
  usage?: Record<string, unknown>;
  rawItemMeta?: Array<Record<string, unknown>>;
}

export class ImageApiError extends Error {
  constructor(
    message: string,
    readonly errorCode: string,
    readonly httpStatus?: number | null,
  ) {
    super(message);
    this.name = 'ImageApiError';
  }
}

/** 别名只在客户端归一；未知值原样透传。 */
export function normalizeImageModelName(name: string | null | undefined): string {
  const raw = (name ?? '').trim();
  const lower = raw.toLowerCase();
  if (lower === 'flare' || lower === 'gpt-image-2.5-flare') return 'gpt-image-2.5-flare';
  if (lower === 'sunburst' || lower === 'gpt-image-2.5-sunburst') return 'gpt-image-2.5-sunburst';
  return raw;
}

export function stripTrailingSlash(baseUrl: string): string {
  return (baseUrl ?? '').replace(/\/+$/, '');
}

export function buildAuthorizationHeader(apiKey: string): string {
  const key = (apiKey ?? '').trim();
  if (/^Bearer\s+/i.test(key)) return key;
  return `Bearer ${key}`;
}

export function redactSecret(text: string, apiKey: string | null | undefined): string {
  if (!apiKey || apiKey.trim() === '') return text;
  return text.split(apiKey).join('[redacted]');
}

function extensionForOutput(
  outputFormat: string | null | undefined,
  mime: string,
  source: 'b64_json' | 'url',
  index: number,
): string {
  const fmt = (outputFormat ?? '').toLowerCase();
  if (fmt === 'jpeg' || fmt === 'jpg') return '.jpg';
  if (fmt === 'png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  if (source === 'url') return '.png';
  return index === 0 ? '.png' : '.png';
}

function mimeFromExtension(fileName: string): string {
  const lower = (fileName ?? '').toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'application/octet-stream';
}

export function editFileMime(file: { fileName: string; mime?: string | null }): string {
  const declared = (file.mime ?? '').trim();
  if (declared && declared !== 'application/octet-stream') return declared;
  return mimeFromExtension(file.fileName);
}

interface RawImageItem {
  b64_json?: unknown;
  url?: unknown;
  revised_prompt?: unknown;
  task_id?: unknown;
  [key: string]: unknown;
}

interface RawImageResponse {
  data?: unknown;
  model?: unknown;
  size?: unknown;
  usage?: unknown;
  error?: { message?: unknown; type?: unknown; code?: unknown } | unknown;
  [key: string]: unknown;
}

async function parseBody(res: Response, apiKey: string): Promise<RawImageResponse | { raw: string }> {
  const text = await res.text();
  try {
    return JSON.parse(text) as RawImageResponse;
  } catch {
    return { raw: text };
  }
}

function extractError(
  body: RawImageResponse | { raw: string },
  status: number,
  apiKey: string,
): ImageApiError {
  if ('raw' in body) {
    const snippet = redactSecret(String(body.raw).slice(0, 500), apiKey);
    return new ImageApiError(
      `Image API ${status}（非 JSON）: ${snippet}`,
      'non_json',
      status,
    );
  }
  const err = body.error;
  if (err != null && typeof err === 'object') {
    const e = err as { message?: unknown; type?: unknown; code?: unknown };
    const code = String(e.code ?? e.type ?? '') || 'unknown';
    const message = redactSecret(String(e.message ?? e.type ?? code), apiKey);
    return new ImageApiError(`Image API ${status}: ${message}`, code, status);
  }
  return new ImageApiError(`Image API ${status}`, 'http_error', status);
}

/** 协议：仅对 429/502/503/504 或 rate_limit_exceeded 重试；参数/鉴权/超时/网络错误不重试。 */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof ImageApiError)) return false;
  if (err.httpStatus != null && RETRY_STATUS.has(err.httpStatus)) return true;
  return err.errorCode === 'rate_limit_exceeded';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  apiKey: string,
): Promise<RawImageResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]!);
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(IMAGE_API_TIMEOUT_MS),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const isTimeout = /timeout|aborted|abort/i.test(message);
      lastError = new ImageApiError(
        isTimeout ? `图片接口超时（>${IMAGE_API_TIMEOUT_MS / 60000} 分钟）` : `图片接口连接失败: ${redactSecret(message, apiKey)}`,
        isTimeout ? 'timeout' : 'network',
        null,
      );
      if (attempt < RETRY_DELAYS_MS.length && isRetryable(lastError)) continue;
      throw lastError;
    }
    const body = await parseBody(res, apiKey);
    if (res.ok) {
      if ('raw' in body) {
        throw new ImageApiError(
          `Image API ${res.status}（非 JSON）: ${redactSecret(String(body.raw).slice(0, 500), apiKey)}`,
          'non_json',
          res.status,
        );
      }
      return body;
    }
    lastError = extractError(body, res.status, apiKey);
    if (attempt < RETRY_DELAYS_MS.length && isRetryable(lastError)) continue;
    throw lastError;
  }
  throw lastError instanceof Error ? lastError : new ImageApiError('Image API failed', 'unknown');
}

function resolveUrl(baseUrl: string, rawUrl: string): string {
  const trimmed = rawUrl.trim();
  try {
    return new URL(trimmed, `${stripTrailingSlash(baseUrl)}/`).toString();
  } catch {
    return trimmed;
  }
}

function isSameOrigin(baseUrl: string, targetUrl: string): boolean {
  try {
    const base = new URL(`${stripTrailingSlash(baseUrl)}/`);
    const target = new URL(targetUrl);
    return base.protocol === target.protocol && base.host === target.host;
  } catch {
    return false;
  }
}

/**
 * 下载 data[].url 图片字节。
 * - 仅允许 http(s)，拒绝其它协议，避免 file:/gopher: 等 SSRF 面。
 * - Authorization 只在与 baseUrl 同源时附带，跨源 CDN 不外泄 apiKey。
 */
async function downloadUrl(
  url: string,
  apiKey: string,
  baseUrl: string,
): Promise<{ bytes: Buffer; mime: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ImageApiError(`图片 URL 不合法: ${url}`, 'invalid_url', null);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ImageApiError(`图片 URL 协议不支持: ${parsed.protocol}`, 'invalid_url', null);
  }
  const headers: Record<string, string> = { 'Accept-Encoding': 'identity' };
  if (isSameOrigin(baseUrl, url)) {
    headers.Authorization = buildAuthorizationHeader(apiKey);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(IMAGE_API_TIMEOUT_MS),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const isTimeout = /timeout|aborted|abort/i.test(message);
    throw new ImageApiError(
      isTimeout ? '图片下载超时' : `图片下载失败: ${redactSecret(message, apiKey)}`,
      isTimeout ? 'timeout' : 'network',
      null,
    );
  }
  if (!res.ok) {
    throw new ImageApiError(`图片下载失败 ${res.status}`, 'download_failed', res.status);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const mime = (res.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() || '';
  return { bytes, mime };
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

async function normalizeResponse(
  body: RawImageResponse,
  cfg: ImageApiConfig,
  outputFormat: string | null | undefined,
  namePrefix: string,
): Promise<ImageApiResult> {
  const data = body.data;
  if (!Array.isArray(data) || data.length === 0) {
    const topTask = body.task_id ?? (!Array.isArray(data) && data != null && typeof data === 'object'
      ? (data as RawImageItem).task_id
      : null);
    if (topTask != null) {
      throw new ImageApiError('上游返回异步任务（task_id），本工具不轮询', 'async_task_unsupported', null);
    }
    throw new ImageApiError('上游未返回图片数据', 'empty_data', null);
  }

  const images: ImageApiImage[] = [];
  const rawItemMeta: Array<Record<string, unknown>> = [];
  let revisedPrompt: string | undefined;

  for (let i = 0; i < data.length; i++) {
    const item = data[i] as RawImageItem;
    if (item == null || typeof item !== 'object') {
      throw new ImageApiError('上游未返回图片数据', 'empty_data', null);
    }
    if (item.task_id != null && item.b64_json == null && item.url == null) {
      throw new ImageApiError('上游返回异步任务（task_id），本工具不轮询', 'async_task_unsupported', null);
    }
    const meta: Record<string, unknown> = {};
    if (item.generation_id != null) meta.generation_id = item.generation_id;
    if (item.model != null) meta.model = item.model;
    if (item.size != null) meta.size = item.size;
    rawItemMeta.push(meta);

    const revised = firstString(item.revised_prompt);
    if (revised && revisedPrompt == null) revisedPrompt = revised;

    const b64 = firstString(item.b64_json);
    const rawUrl = firstString(item.url);
    if (b64) {
      const bytes = Buffer.from(b64, 'base64');
      const mime = ImageFileSupport.detectMimeFromBytes(bytes)
        ?? mimeFromExtension(`x${extensionForOutput(outputFormat, '', 'b64_json', i)}`);
      const ext = extensionForOutput(outputFormat, mime, 'b64_json', i);
      images.push({ bytes, mime, source: 'b64_json', fileName: `${namePrefix}-${i}${ext}` });
    } else if (rawUrl) {
      const abs = resolveUrl(cfg.baseUrl, rawUrl);
      const downloaded = await downloadUrl(abs, cfg.apiKey, cfg.baseUrl);
      const mime = ImageFileSupport.detectMimeFromBytes(downloaded.bytes)
        ?? (downloaded.mime.startsWith('image/') ? downloaded.mime : null)
        ?? 'image/png';
      const ext = extensionForOutput(outputFormat, mime, 'url', i);
      images.push({ bytes: downloaded.bytes, mime, source: 'url', fileName: `${namePrefix}-${i}${ext}` });
    } else {
      throw new ImageApiError('上游未返回图片数据', 'empty_data', null);
    }
  }

  const result: ImageApiResult = { images, rawItemMeta };
  const respModel = firstString(body.model) ?? firstString(rawItemMeta[0]?.model);
  if (respModel) result.model = respModel;
  const respSize = firstString(body.size) ?? firstString(rawItemMeta[0]?.size);
  if (respSize) result.size = respSize;
  if (revisedPrompt) result.revisedPrompt = revisedPrompt;
  if (body.usage != null && typeof body.usage === 'object') {
    result.usage = body.usage as Record<string, unknown>;
  }
  return result;
}

function buildAuthHeaders(cfg: ImageApiConfig, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: buildAuthorizationHeader(cfg.apiKey),
    'Accept-Encoding': 'identity',
    ...extra,
  };
  if (cfg.clientImpersonation === 'codex' || cfg.clientImpersonation === 'claude_code') {
    applyClientImpersonationHeaders(headers, cfg.clientImpersonation);
  }
  return headers;
}

function clampN(n: number | null | undefined, fallback = 1): number {
  const v = n == null ? fallback : Math.trunc(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(10, Math.max(1, v));
}

/** 文生图：仅发送 model/prompt/n/size/quality，不带 response_format 等协议外字段。 */
export async function callImageGenerations(
  cfg: ImageApiConfig,
  params: GenerateImageParams,
): Promise<ImageApiResult> {
  const prompt = (params.prompt ?? '').trim();
  if (!prompt) throw new ImageApiError('prompt 不能为空', 'invalid_params', null);

  const body: Record<string, unknown> = {
    model: normalizeImageModelName(cfg.model),
    prompt,
    n: clampN(params.n),
  };
  const size = (params.size ?? '').trim();
  if (size) body.size = size;
  const quality = (params.quality ?? '').trim();
  if (quality) body.quality = quality;

  const url = `${stripTrailingSlash(cfg.baseUrl)}/images/generations`;
  const raw = await fetchWithRetry(url, {
    method: 'POST',
    headers: buildAuthHeaders(cfg, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  }, cfg.apiKey);
  return normalizeResponse(raw, cfg, null, 'gen');
}

/** 改图：multipart/form-data；多图重复同名字段 image。 */
export async function callImageEdits(
  cfg: ImageApiConfig,
  params: EditImageParams,
): Promise<ImageApiResult> {
  const prompt = (params.prompt ?? '').trim();
  if (!prompt) throw new ImageApiError('prompt 不能为空', 'invalid_params', null);
  if (!params.images || params.images.length === 0) {
    throw new ImageApiError('image_paths 至少需要一张本地图片', 'invalid_params', null);
  }

  const form = new FormData();
  form.append('model', normalizeImageModelName(cfg.model));
  form.append('prompt', prompt);
  form.append('n', String(clampN(params.n)));
  const size = (params.size ?? '').trim() || 'auto';
  form.append('size', size);
  const quality = (params.quality ?? '').trim() || 'auto';
  form.append('quality', quality);
  const background = (params.background ?? '').trim() || 'auto';
  form.append('background', background);
  const outputFormat = (params.outputFormat ?? '').trim() || 'png';
  form.append('output_format', outputFormat);
  if (outputFormat === 'jpeg' && params.outputCompression != null && Number.isFinite(params.outputCompression)) {
    const c = Math.min(100, Math.max(0, Math.trunc(params.outputCompression)));
    form.append('output_compression', String(c));
  }

  for (const img of params.images) {
    const mime = editFileMime(img);
    form.append('image', new Blob([new Uint8Array(img.bytes)], { type: mime }), img.fileName);
  }
  if (params.mask) {
    const mime = editFileMime(params.mask);
    form.append('mask', new Blob([new Uint8Array(params.mask.bytes)], { type: mime }), params.mask.fileName);
  }

  const url = `${stripTrailingSlash(cfg.baseUrl)}/images/edits`;
  const raw = await fetchWithRetry(url, {
    method: 'POST',
    // Content-Type 必须由 FormData 连同 boundary 生成，禁止手写。
    headers: buildAuthHeaders(cfg),
    body: form,
  }, cfg.apiKey);
  return normalizeResponse(raw, cfg, outputFormat, 'edit');
}

export function toImageApiError(e: unknown, apiKey?: string | null): ImageApiError {
  if (e instanceof ImageApiError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new ImageApiError(redactSecret(message, apiKey), 'unknown', null);
}
