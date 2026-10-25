import type { LlmModelConfig } from '../llm/chat-request.js';

/** 压缩触发原因（`manual` 只用于事件/日志标注，不由 shouldTrigger 返回）。 */
export type CompactionTriggerReason = 'tokens' | 'payload' | 'both';

/** 供应商请求体上限缺省时，触发阈值取上限的 80%（留 20% 给摘要指令与 JSON 转义）。 */
const PROVIDER_LIMIT_TRIGGER_RATIO = 0.8;

export class CompactionConfig {
  enabled = true;
  contextWindowTokens = 256000;
  triggerRatio = 0.8;
  /**
   * 请求体体积触发阈值（字节）；0 表示关闭体积触发。
   * 默认 40 MiB：对应 50MB 级供应商上限，留约 20% 余量。
   */
  triggerPayloadBytes = 40 * 1024 * 1024;
  maxSummaryTokens = 12000;
  loopMidwayCompact = true;

  static resolveEffectiveContextWindow(modelConfig: LlmModelConfig | null | undefined, config: CompactionConfig): number {
    if (modelConfig?.contextWindowTokens != null && modelConfig.contextWindowTokens > 0) {
      return modelConfig.contextWindowTokens;
    }
    return config.contextWindowTokens;
  }

  /**
   * 生效的请求体体积阈值：
   * - 全局阈值 0 → 关闭体积触发；
   * - 模型声明了供应商上限 → min(全局阈值, 上限 × 0.8)；
   * - 未声明上限 → 全局阈值。
   */
  static resolveEffectiveTriggerBytes(
    modelConfig: LlmModelConfig | null | undefined,
    config: CompactionConfig,
  ): number {
    if (config.triggerPayloadBytes <= 0) return 0;
    const providerLimit = modelConfig?.maxRequestBodyBytes ?? 0;
    if (providerLimit > 0) {
      const derived = Math.floor(providerLimit * PROVIDER_LIMIT_TRIGGER_RATIO);
      return Math.min(config.triggerPayloadBytes, derived);
    }
    return config.triggerPayloadBytes;
  }

  /** token / 体积任一命中即触发；`force`（手动整理）由调用方绕过。 */
  static shouldTrigger(params: {
    tokens: number;
    payloadBytes: number;
    triggerWindowTokens: number;
    effectiveTriggerBytes: number;
    config: CompactionConfig;
  }): CompactionTriggerReason | null {
    const { tokens, payloadBytes, triggerWindowTokens, effectiveTriggerBytes, config } = params;
    const tokensHit = triggerWindowTokens > 0
      && tokens >= Math.floor(triggerWindowTokens * config.triggerRatio);
    const payloadHit = effectiveTriggerBytes > 0 && payloadBytes >= effectiveTriggerBytes;
    if (tokensHit && payloadHit) return 'both';
    if (tokensHit) return 'tokens';
    if (payloadHit) return 'payload';
    return null;
  }
}
