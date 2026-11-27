import type { AgentFeaturedTool } from '@mao/contracts';
import { harnessLog } from '../log.js';

/**
 * Agent 特色工具（技术方案 2026-11-27）：把内置工具按「能力」分组，
 * 由 `HarnessService.buildContext()` 在会话工具出口按 Agent 配置 + 模型可用性过滤。
 * 一个能力可对应多个工具（image_generation → generate_image + edit_image）。
 */
export const TOOL_NAMES_BY_FEATURE: Record<AgentFeaturedTool, readonly string[]> = {
  image_generation: ['generate_image', 'edit_image'],
  text_to_speech: ['text_to_speech'],
};

/** 所有受 Agent 配置门控的内置工具名；从能力表派生，避免两处硬编码漂移。 */
export const FEATURED_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(TOOL_NAMES_BY_FEATURE).flat(),
);

const FEATURED_TOOL_VALUES: ReadonlySet<string> = new Set(Object.keys(TOOL_NAMES_BY_FEATURE));

/** 模型可用性查询端口（ModelService 天然满足）；未注入时保持改造前行为。 */
export interface FeaturedToolModelLookup {
  findFirstActiveImageModel(): Promise<unknown | null>;
  findFirstActiveAudioModel(): Promise<unknown | null>;
}

/** 安全解析 Agent 列；非法 JSON / 未知值一律当未启用（脏数据不打崩会话）。 */
export function parseFeaturedTools(raw: string | null | undefined): AgentFeaturedTool[] {
  if (raw == null || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const result: AgentFeaturedTool[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string' || !FEATURED_TOOL_VALUES.has(item)) continue;
    const value = item as AgentFeaturedTool;
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

/**
 * 配置 ∩ 模型可用性 → 本会话可保留的工具名。
 *
 * - `lookup == null`（精简装配 / 单测）：返回全部 gated 工具名，保持改造前行为；
 * - 某个能力的模型查询抛错：只丢弃该能力，其他能力继续（逐能力 fail-closed）；
 * - 只查配置了的能力；配置为空时零查库。
 */
export async function resolveFeaturedToolNames(
  featured: readonly AgentFeaturedTool[],
  lookup: FeaturedToolModelLookup | null,
): Promise<Set<string>> {
  if (lookup == null) {
    return new Set(FEATURED_TOOL_NAMES);
  }
  const allowed = new Set<string>();
  for (const feature of featured) {
    const toolNames = TOOL_NAMES_BY_FEATURE[feature];
    if (toolNames == null) continue;
    let available: boolean;
    try {
      available = feature === 'image_generation'
        ? (await lookup.findFirstActiveImageModel()) != null
        : (await lookup.findFirstActiveAudioModel()) != null;
    } catch (e) {
      harnessLog('warn', `[featured-tools] model lookup failed feature=${feature}: ${(e as Error).message}`);
      available = false;
    }
    if (available) {
      for (const name of toolNames) allowed.add(name);
    }
  }
  return allowed;
}