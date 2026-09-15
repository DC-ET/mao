import type {
  ChatCallback,
  ChatRequest,
  ChatResponse,
  ChatUsage,
  LlmAdapter,
  LlmModelConfig,
  StreamCallback,
  StreamChunk,
} from '../harness/llm/chat-request.js';
import type { LlmCallService } from './llm-call.service.js';

function hasStreamOutput(chunk: StreamChunk): boolean {
  for (const choice of chunk.choices ?? []) {
    const delta = choice.delta;
    if (!delta) continue;
    if (delta.content && delta.content.length > 0) return true;
    if (delta.reasoningContent && delta.reasoningContent.length > 0) return true;
    if (delta.toolCalls && delta.toolCalls.length > 0) return true;
  }
  return false;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export class RecordingLlmAdapter implements LlmAdapter {
  constructor(
    private readonly delegate: LlmAdapter,
    private readonly callService: LlmCallService,
  ) {}

  async chat(
    request: ChatRequest,
    config: LlmModelConfig,
    cancelFlag?: { get(): boolean } | null,
    callback?: ChatCallback | null,
  ): Promise<ChatResponse> {
    const started = Date.now();
    let retryCount = 0;
    let usage: ChatUsage | undefined;
    let success = false;
    let error: string | null = null;
    const wrappedCallback: ChatCallback | null = callback
      ? {
        onWaiting: callback.onWaiting?.bind(callback),
        onRetry: (...args) => {
          retryCount += 1;
          callback.onRetry?.(...args);
        },
      }
      : null;
    try {
      const response = await this.delegate.chat(request, config, cancelFlag, wrappedCallback);
      usage = response.usage;
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
        retryCount,
      });
    }
  }

  async stream(
    request: ChatRequest,
    config: LlmModelConfig,
    callback: StreamCallback,
    cancelFlag?: { get(): boolean } | null,
  ): Promise<void> {
    const started = Date.now();
    let retryCount = 0;
    let usage: ChatUsage | undefined;
    let success = false;
    let error: string | null = null;
    let firstTokenMs: number | null = null;
    const wrapped: StreamCallback = {
      onChunk: (chunk) => {
        if (firstTokenMs == null && hasStreamOutput(chunk)) {
          firstTokenMs = Date.now() - started;
        }
        callback.onChunk(chunk);
      },
      onComplete: (u) => {
        usage = u;
        callback.onComplete(u);
      },
      onError: (t) => {
        error = errorMessage(t);
        callback.onError(t);
      },
      onStreamReset: callback.onStreamReset?.bind(callback),
      onWaiting: callback.onWaiting?.bind(callback),
      onRetry: (...args) => {
        retryCount += 1;
        callback.onRetry?.(...args);
      },
    };
    try {
      await this.delegate.stream(request, config, wrapped, cancelFlag);
      success = error == null;
    } catch (e) {
      error = errorMessage(e);
      throw e;
    } finally {
      await this.callService.record({
        modelConfig: config,
        stream: true,
        usage,
        success,
        errorMessage: error,
        firstTokenMs,
        durationMs: Date.now() - started,
        retryCount,
      });
    }
  }
}
