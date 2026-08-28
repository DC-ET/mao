import type {
  ChatCallback,
  ChatRequest,
  ChatResponse,
  LlmAdapter,
  LlmModelConfig,
  StreamCallback,
} from './chat-request.js';

/**
 * 按 LlmModelConfig.provider 把调用路由到具体协议适配器。
 * 路由键做 trim + 小写归一；未注册的 provider（含空值）一律回落到默认适配器，
 * 保证存量模型（provider 为展示名或空）行为与改造前完全一致。
 */
export class LlmAdapterFacade implements LlmAdapter {
  constructor(
    private readonly delegates: Map<string, LlmAdapter>,
    private readonly fallback: LlmAdapter,
  ) {}

  private pick(config: LlmModelConfig): LlmAdapter {
    const code = config.provider?.trim().toLowerCase();
    if (code == null || code === '') return this.fallback;
    return this.delegates.get(code) ?? this.fallback;
  }

  chat(
    request: ChatRequest,
    config: LlmModelConfig,
    cancelFlag?: { get(): boolean } | null,
    callback?: ChatCallback | null,
  ): Promise<ChatResponse> {
    return this.pick(config).chat(request, config, cancelFlag, callback);
  }

  stream(
    request: ChatRequest,
    config: LlmModelConfig,
    callback: StreamCallback,
    cancelFlag?: { get(): boolean } | null,
  ): Promise<void> {
    return this.pick(config).stream(request, config, callback, cancelFlag);
  }
}
