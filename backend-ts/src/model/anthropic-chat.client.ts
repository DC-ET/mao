import type { LlmChatClient, LlmChatRequest, LlmChatResponse, LlmModelConfig } from './types.js';
import { applyClientImpersonationHeaders } from '../harness/llm/client-impersonation-headers.js';
import { convertMessages, mapStopReason } from '../harness/llm/anthropic-llm-adapter.js';
import type { ChatMessage } from '../harness/llm/chat-request.js';

export interface AnthropicChatClientOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 管理后台连通性测试用的 Anthropic Messages 非流式客户端（仅 chat，不含工具）。
 *  消息转换复用主 Adapter 的 convertMessages，保证两链路协议行为一致。 */
export class AnthropicChatClient implements LlmChatClient {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicChatClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chat(request: LlmChatRequest, config: LlmModelConfig): Promise<LlmChatResponse> {
    const url = `${stripTrailingSlash(config.baseUrl)}/messages`;
    const converted = convertMessages(request.messages as ChatMessage[]);
    const body: Record<string, unknown> = {
      model: config.modelId,
      // 连通性测试只需极短输出，用小 max_tokens 降低探测开销
      max_tokens: 1024,
      // 固定非流式：本客户端仅按 JSON 解析响应，不支持 SSE
      stream: false,
      messages: converted.messages,
    };
    if (converted.system != null) body.system = converted.system;
    if (request.temperature != null) body.temperature = request.temperature;

    const headers: Record<string, string> = {
      'x-api-key': config.apiKey,
      Authorization: `Bearer ${config.apiKey}`,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    };
    applyClientImpersonationHeaders(headers, config.clientImpersonation);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        const snippet = text.length > 500 ? text.slice(0, 500) : text;
        throw new Error(`LLM HTTP ${response.status}: ${snippet || response.statusText}`);
      }
      if (!text) {
        throw new Error('LLM API returned empty body');
      }
      return toChatResponse(JSON.parse(text) as Record<string, unknown>);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('LLM call failed: timeout');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Anthropic 响应 → 统一 LlmChatResponse（取 text block 拼接）。 */
function toChatResponse(raw: Record<string, unknown>): LlmChatResponse {
  const content = Array.isArray(raw.content) ? raw.content : [];
  let text = '';
  for (const block of content) {
    if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
      const t = (block as Record<string, unknown>).text;
      if (typeof t === 'string') text += t;
    }
  }
  const stopReason = typeof raw.stop_reason === 'string' ? raw.stop_reason : undefined;
  return {
    choices: [{
      message: { role: 'assistant', content: text },
      finish_reason: mapStopReason(stopReason),
    }],
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
