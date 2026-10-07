/**
 * 上下文构成清单（技术方案 5.2）：与 `PromptEngine.buildRequest` 同源产出，随 `context_window`
 * 事件推送，供检查器「上下文」页签渲染。只读最终请求对象，禁止事后重建（决策 1）。
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
