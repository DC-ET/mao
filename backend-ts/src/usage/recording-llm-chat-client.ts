import type { LlmChatClient, LlmChatRequest, LlmChatResponse, LlmModelConfig } from '../model/types.js';
import type { ChatUsage } from '../harness/llm/chat-request.js';
import { snapshotCostMicros } from './cost-micros.js';
import type { LlmCallService } from './llm-call.service.js';

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export class RecordingLlmChatClient implements LlmChatClient {
  constructor(
    private readonly delegate: LlmChatClient,
    private readonly callService: LlmCallService,
  ) {}

  async chat(request: LlmChatRequest, config: LlmModelConfig): Promise<LlmChatResponse> {
    const started = Date.now();
    let success = false;
    let error: string | null = null;
    let usage: ChatUsage | null = null;
    try {
      const response = await this.delegate.chat(request, config);
      // 非流式响应同样带回 usage（各协议客户端已归一）；漏记会让飞书摘要、连通性测试等
      // 旁路调用的 token 与成本永久记 0，预算闸门与用量统计同时少计。
      usage = response.usage ?? null;
      success = true;
      return response;
    } catch (e) {
      error = errorMessage(e);
      throw e;
    } finally {
      await this.callService.record({
        modelConfig: config,
        stream: false,
        usage,
        success,
        errorMessage: error,
        durationMs: Date.now() - started,
        retryCount: 0,
        costMicros: snapshotCostMicros(config, usage),
      });
    }
  }
}
