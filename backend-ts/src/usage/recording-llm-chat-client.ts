import type { LlmChatClient, LlmChatRequest, LlmChatResponse, LlmModelConfig } from '../model/types.js';
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
    try {
      const response = await this.delegate.chat(request, config);
      success = true;
      return response;
    } catch (e) {
      error = errorMessage(e);
      throw e;
    } finally {
      await this.callService.record({
        modelConfig: config,
        stream: false,
        usage: null,
        success,
        errorMessage: error,
        durationMs: Date.now() - started,
        retryCount: 0,
      });
    }
  }
}
