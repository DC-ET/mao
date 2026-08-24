import type { LlmChatClient, LlmChatRequest, LlmChatResponse, LlmModelConfig } from './types.js';
import { applyClientImpersonationHeaders } from '../harness/llm/client-impersonation-headers.js';

export interface OpenAiChatClientOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class OpenAiChatClient implements LlmChatClient {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiChatClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chat(request: LlmChatRequest, config: LlmModelConfig): Promise<LlmChatResponse> {
    const url = `${stripTrailingSlash(config.baseUrl)}/chat/completions`;
    const body: Record<string, unknown> = {
      model: config.modelId,
      messages: request.messages,
      stream: request.stream ?? false,
    };
    if (request.temperature != null) {
      body.temperature = request.temperature;
    }
    if (request.audio != null && Object.keys(request.audio).length > 0) {
      body.audio = request.audio;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
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
      return JSON.parse(text) as LlmChatResponse;
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

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
