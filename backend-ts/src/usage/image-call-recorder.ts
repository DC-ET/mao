import type { ImageCallRecorder } from '../harness/tool/impl/generate-image-tool.js';
import { harnessLog } from '../harness/log.js';
import { LlmCallContext } from './llm-call-context.js';
import type { LlmCallService } from './llm-call.service.js';

/**
 * 图片调用流水适配器（技术方案 2026-11-24 §6.3）：把 `ImageCallRecorder` 端口接到
 * `LlmCallService.record`。
 *
 * scene 与零成本在这里统一决定（D3 / §10.1）：`costMicros: 0` 是「已知零价」——
 * SUM 计入但不改变总额；NULL 是「未知价」——SUM 忽略、预算闸门静默穿透，绝不能落到后者。
 * 图片工具直连 image-api-client、不经 LlmAdapter，所以 user/session/agent 无法从
 * LlmCallContext 继承，必须显式包一层 runAsync 再让 record 取用。
 */
export function createImageCallRecorder(llmCallService: LlmCallService): ImageCallRecorder {
  return {
    async record(input) {
      try {
        await LlmCallContext.runAsync({
          scene: 'image_generation',
          userId: input.userId,
          sessionId: input.sessionId,
          agentId: input.agentId,
        }, async () => {
          await llmCallService.record({
            modelConfig: {
              id: input.model?.id ?? undefined,
              name: input.model?.name ?? null,
              provider: input.model?.provider ?? null,
              apiProtocol: input.model?.apiProtocol ?? null,
              modelId: input.resolvedModelName,
            },
            stream: false,
            usage: input.usage,
            success: input.success,
            errorMessage: input.errorMessage ?? null,
            durationMs: input.durationMs,
            costMicros: 0,
          });
        });
      } catch (e) {
        // 记账失败绝不影响工具返回（D8）：LlmCallService.record 内部已 catch DB 异常，
        // 这里再包一层防 runAsync 本身或适配器逻辑抛错。
        harnessLog('warn', 'ImageCallRecorder failed', (e as Error).message);
      }
    }
  };
}
