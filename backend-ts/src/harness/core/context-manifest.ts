/**
 * 上下文构成清单（技术方案 5.2）：与 `PromptEngine.buildRequest` 同源产出，随 `context_window`
 * 事件推送，并落在会话上供刷新后回放。只存当次请求的快照，禁止按当前消息事后重建（决策 1）。
 */

/** 系统提示 / 消息 / 交接摘要的单个分节统计。tokens 为 TokenEstimator 字节估算口径。 */
export interface ContextSectionStat {
  key: string;
  label: string;
  tokens: number;
  /** 可选计数：记忆条目数、经验条数、消息条数等。 */
  count?: number;
}

export interface ContextManifest {
  /** 系统提示各节 + messages + handoff 摘要。 */
  sections: ContextSectionStat[];
  /** 本次注入的记忆条目 id（开关关闭 / 无记忆时为空数组）。 */
  memoryIds: number[];
  /** 生效窗口（模型 contextWindowTokens 优先），无法解析时为 null。 */
  estimatedWindowTokens: number | null;
}

/** manifest 序列化上限（技术方案 §7）：超限裁剪 memoryIds，避免长会话膨胀。 */
export const CONTEXT_MANIFEST_MAX_BYTES = 8 * 1024;

/**
 * 推送与落库共用的体积护栏：超限时逐步丢掉 memoryIds，仍超限则返回 null（调用方清空旧快照）。
 */
export function trimContextManifest(manifest: ContextManifest | null | undefined): ContextManifest | null {
  if (manifest == null) return null;
  const fits = (m: ContextManifest): boolean => {
    try {
      return Buffer.byteLength(JSON.stringify(m), 'utf8') <= CONTEXT_MANIFEST_MAX_BYTES;
    } catch {
      return false;
    }
  };
  let candidate: ContextManifest = { ...manifest, memoryIds: [...(manifest.memoryIds ?? [])] };
  if (fits(candidate)) return candidate;
  while (candidate.memoryIds.length > 0) {
    candidate = { ...candidate, memoryIds: candidate.memoryIds.slice(0, Math.floor(candidate.memoryIds.length / 2)) };
    if (fits(candidate)) return candidate;
  }
  return null;
}

/** 落库用 JSON。无法容纳时返回 null，表示清空上一份快照。 */
export function contextManifestJson(manifest: ContextManifest | null | undefined): string | null {
  const trimmed = trimContextManifest(manifest);
  return trimmed == null ? null : JSON.stringify(trimmed);
}
