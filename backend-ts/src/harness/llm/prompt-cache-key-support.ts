import { harnessLog } from '../log.js';
import type { LlmModelConfig } from './chat-request.js';

/**
 * 提示词缓存增强字段的「发后自动降级」登记表（技术方案 2026-10-12 §3.2 / §4.2）。
 *
 * 背景：`prompt_cache_key`（chat-completions 默认协议）与 Anthropic 顶层 `cache_control`
 * 都是「发了更好、严格网关可能 400」的字段。无条件发送的风险不对称——一个严格网关
 * 报错会影响该模型全部调用，而漏发的代价只是没有收益，因此：
 *
 * 1. 先按 (baseUrl|modelId) 发送；
 * 2. 收到「明确因该字段被拒」的 400 后登记为不支持，并立即去掉字段重试；
 * 3. 该模型后续请求不再携带，避免每次调用都多花一个失败请求。
 *
 * 进程内记忆，重启即重置：运行时探测事实，重启后重新试一次是预期成本（一次失败请求）。
 * `unsupported` 集合单调递减，同一模型降级一次后 payload 再不携带该字段，不会死循环。
 */

/** 受降级机制保护的请求体字段（Anthropic 顶层字段与 chat-completions 顶层字段各一个）。 */
export type PromptCacheFeature = 'prompt_cache_key' | 'cache_control';

type UnsupportedKey = `${string}|${string}|${string}`;

function supportKey(config: LlmModelConfig): UnsupportedKey {
  // baseUrl / modelId / id 均可选（NULL 列产出 undefined）：用显式占位符区分「空」与「有值」。
  // 空串与缺失视为同一「空」——同一网关的同一模型不会因为一列存 NULL、一列存 ''
  // 而被拆成两个键，导致降级登记只覆盖其中一半。
  // 不掺 id 会让「两个维度同时为空」的配置碰撞成同一键——一个被降级后另一个也不再发送
  // 缓存字段；带上模型主键后即便 baseUrl/modelId 缺失也能按行隔离。
  const norm = (value: string | number | undefined): string => {
    if (value == null) return '<none>';
    const text = String(value);
    return text.trim() === '' ? '<none>' : text;
  };
  return `${norm(config.baseUrl)}|${norm(config.modelId)}|${norm(config.id)}`;
}

/** 进程内降级登记表：key=(baseUrl|modelId)，value=该模型已确认不支持的字段集合。 */
const unsupported = new Map<UnsupportedKey, Set<PromptCacheFeature>>();

export function isSupported(config: LlmModelConfig, feature: PromptCacheFeature): boolean {
  const key = supportKey(config);
  const features = unsupported.get(key);
  if (features == null) return true;
  return !features.has(feature);
}

export function markUnsupported(config: LlmModelConfig, feature: PromptCacheFeature, detail: string): void {
  const key = supportKey(config);
  const features = unsupported.get(key) ?? new Set<PromptCacheFeature>();
  features.add(feature);
  unsupported.set(key, features);
  harnessLog('warn', `prompt cache feature degraded baseUrl=${config.baseUrl ?? ''} modelId=${config.modelId ?? ''}`
    + ` feature=${feature} detail=${detail.slice(0, 300)}`);
}

/**
 * 判断一次 400 是否「因目标字段不被网关接受」而应降级。判据保守（宁可漏判不可误判）：
 * - 错误体出现字段名本身，或
 * - 出现 unknown/unexpected/unrecognized 字样且同段出现 cache。
 *
 * 403/429/5xx 与「错误体完全无关」的 400 一律不降级——那些不是字段兼容性问题。
 */
export function shouldDegrade(status: number, errorBody: string, feature: PromptCacheFeature): boolean {
  if (status !== 400) return false;
  const text = errorBody.toLowerCase();
  if (text === '') return false;
  if (text.includes(feature.toLowerCase())) return true;
  const mentionsUnknown = ['unknown', 'unexpected', 'unrecognized'].some((word) => text.includes(word));
  return mentionsUnknown && text.includes('cache');
}

/** 仅测试使用：清空降级登记表。 */
export function resetPromptCacheSupportForTest(): void {
  unsupported.clear();
}
