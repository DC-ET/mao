import { createHash } from 'node:crypto';
import type { SignalCompareMode } from './types.js';

/**
 * 判定值计算与 diff 构造（docs/plan/2026-10-11-signal-watcher-technical-design.md §5.6）。
 * 纯函数，无 IO，便于单测。
 */

/** diff 片段单侧截断字数（决策 6）。 */
export const DIFF_SNIPPET_MAX_CHARS = 500;
/** JSON 路径最大段数。 */
export const MAX_JSON_PATH_SEGMENTS = 16;
/** 渲染后 prompt 上限（与 OPEN_RUN_MESSAGE_MAX_LENGTH 对齐）。 */
export const WATCHER_PROMPT_MAX_LENGTH = 32000;

/** 判定值不可用（探针失败 / JSON 解析失败 / 路径取不到值）。 */
export class ProbeValueError extends Error {}

/**
 * 点分路径取值：`data.items.0.price` → root['data']['items'][0]['price']。
 * 任一段缺失、越界、取到 undefined/null 均抛 ProbeValueError（不静默取空串——
 * 空串会让「字段消失」看起来像一次正常变化）。
 */
export function extractJsonPath(root: unknown, path: string): unknown {
  const trimmed = (path ?? '').trim();
  if (trimmed === '') throw new ProbeValueError('提取路径为空');
  const segments = trimmed.split('.');
  if (segments.length > MAX_JSON_PATH_SEGMENTS) {
    throw new ProbeValueError(`提取路径段数超过 ${MAX_JSON_PATH_SEGMENTS}`);
  }
  let current: unknown = root;
  for (const segment of segments) {
    if (segment === '') throw new ProbeValueError('提取路径含空段');
    if (current == null) throw new ProbeValueError(`路径段 ${segment} 取不到值`);
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new ProbeValueError(`数组下标 ${segment} 越界`);
      }
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') throw new ProbeValueError(`路径段 ${segment} 不是对象`);
    const record = current as Record<string, unknown>;
    // 必须按自有属性判定：`in` 会命中原型链成员（JSON.parse 的对象原型是
    // Object.prototype，'toString' in {} 为 true），把 toString/constructor 等段名
    // 当成存在并取到原型上的函数，最终归一化成空串、哈希退化成 sha256('')，
    // 「字段消失」被伪装成一次正常变化——正是本函数契约要避免的情况。
    if (!Object.prototype.hasOwnProperty.call(record, segment)) throw new ProbeValueError(`路径段 ${segment} 不存在`);
    current = record[segment];
  }
  if (current === undefined || current === null) throw new ProbeValueError('取到的值为 null');
  return current;
}

/** 判定值 → 哈希（HASH/JSON_FIELD/STATUS_CODE 三模式统一口径）。 */
export function hashProbeValue(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * JSON_FIELD 取到值后的规范化文本：字符串取原文，其余 JSON.stringify。
 * 哈希与 diff 旧值/新值必须共用同一函数，否则「内容没变但哈希变了」。
 */
export function normalizeExtractedValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? '';
}

export interface ComputeValueInput {
  compareMode: SignalCompareMode;
  httpStatus: number | null;
  /** 响应体原始字节（HASH 模式用，避免解码差异影响判定）。 */
  bodyBytes: Buffer | null;
  body: string | null;
  jsonPath: string | null;
}

/** 计算本次判定值哈希；不可判定抛 ProbeValueError。 */
export function computeValueHash(input: ComputeValueInput): string {
  if (input.compareMode === 'STATUS_CODE') {
    if (input.httpStatus == null) throw new ProbeValueError('响应无状态码');
    return hashProbeValue(String(input.httpStatus));
  }
  if (input.compareMode === 'JSON_FIELD') {
    const raw = input.body ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ProbeValueError('响应体不是合法 JSON');
    }
    if (input.jsonPath == null || input.jsonPath.trim() === '') {
      throw new ProbeValueError('未配置提取路径');
    }
    const value = extractJsonPath(parsed, input.jsonPath);
    const text = normalizeExtractedValue(value);
    return hashProbeValue(text);
  }
  // HASH
  if (input.bodyBytes == null) throw new ProbeValueError('响应体为空');
  return hashProbeValue(input.bodyBytes);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（已截断）`;
}

export interface DiffInput {
  compareMode: SignalCompareMode;
  /** 上次判定内容（HASH 模式为上次响应体片段；JSON_FIELD/STATUS_CODE 为上次取值文本）。 */
  oldText: string;
  newText: string;
  jsonPath?: string | null;
}

/** 构造 {diff} 占位内容（决策 6：旧/新各截 500 字，不做行级 diff）。 */
export function buildDiff(input: DiffInput): string {
  const oldSnippet = truncate(input.oldText ?? '', DIFF_SNIPPET_MAX_CHARS);
  const newSnippet = truncate(input.newText ?? '', DIFF_SNIPPET_MAX_CHARS);
  if (input.compareMode === 'STATUS_CODE') {
    return `[HTTP 状态码] ${oldSnippet} → ${newSnippet}`;
  }
  if (input.compareMode === 'JSON_FIELD') {
    const field = input.jsonPath ?? '';
    return `[字段 ${field}] 旧值：${oldSnippet}\n新值：${newSnippet}`;
  }
  return `[响应体前 ${DIFF_SNIPPET_MAX_CHARS} 字] 旧：${oldSnippet}\n新：${newSnippet}`;
}

export interface RenderVars {
  url: string;
  name: string;
  diff: string;
}

/**
 * 渲染 prompt 模板：`{url}` / `{name}` / `{diff}` 单遍替换。用函数式替换，
 * 替换值里的 `$` 不会被当分组引用，且不会被后续占位符二次扫描。
 */
export function renderWatcherPrompt(template: string, vars: RenderVars): string {
  const base = template ?? '';
  let out = base.replace(/\{(diff|url|name)\}/g, (_match, key: string) => vars[key as keyof RenderVars] ?? '');
  if (out.length > WATCHER_PROMPT_MAX_LENGTH) {
    out = `${out.slice(0, WATCHER_PROMPT_MAX_LENGTH)}…（已截断）`;
  }
  return out;
}

/** 探针响应 → 判定内容文本（diff 用）：JSON_FIELD 取字段值、STATUS_CODE 取状态码、HASH 取响应体。 */
export function valueTextForDiff(input: ComputeValueInput & { extracted?: unknown }): string {
  if (input.compareMode === 'STATUS_CODE') return String(input.httpStatus ?? '');
  if (input.compareMode === 'JSON_FIELD') {
    const raw = input.body ?? '';
    try {
      const parsed = JSON.parse(raw) as unknown;
      const value = extractJsonPath(parsed, input.jsonPath ?? '');
      return normalizeExtractedValue(value);
    } catch {
      return '';
    }
  }
  return input.body ?? '';
}
