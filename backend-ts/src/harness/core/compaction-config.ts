import type { LlmModelConfig } from '../llm/chat-request.js';

export class CompactionConfig {
  enabled = true;
  contextWindowTokens = 256000;
  triggerRatio = 0.8;
  maxSummaryTokens = 12000;
  loopMidwayCompact = true;

  static resolveEffectiveContextWindow(modelConfig: LlmModelConfig | null | undefined, config: CompactionConfig): number {
    if (modelConfig?.contextWindowTokens != null && modelConfig.contextWindowTokens > 0) {
      return modelConfig.contextWindowTokens;
    }
    return config.contextWindowTokens;
  }
}
