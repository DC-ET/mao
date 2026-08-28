import type { LlmChatClient, LlmChatRequest, LlmChatResponse, LlmModelConfig } from './types.js';
import { applyClientImpersonationHeaders } from '../harness/llm/client-impersonation-headers.js';

export interface AnthropicChatClientOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 管理后台连通性测试用的 Anthropic Messages 非流式客户端（仅 chat，不含工具）。 */
export class AnthropicChatClient implements LlmChatClient {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicChatClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chat(request: LlmChatRequest, config: LlmModelConfig): Promise<LlmChatResponse> {
    const url = `${stripTrailingSlash(config.baseUrl)}/messages`;
    const systemParts: string[] = [];
    const converted: Array<Record<string, unknown>> = [];
    for (const msg of request.messages) {
      if (msg.role === 'system') {
        if (converted.length === 0) {
          const text = contentToText(msg.content);
          if (text !== '') systemParts.push(text);
        } else {
          // 非首条 system 降级为 user 文本
          converted.push({ role: 'user', content: [{ type: 'text', text: contentToText(msg.content) }] });
        }
        continue;
      }
      converted.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: [{ type: 'text', text: contentToText(msg.content) }] });
    }

    const body: Record<string, unknown> = {
      model: config.modelId,
      max_tokens: 1024,
      stream: request.stream ?? false,
      messages: converted,
    };
    if (systemParts.length > 0) body.system = systemParts.join('\n\n');
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

/** Anthropic 响应 → 统一 LlmChatResponse（取首个 text block）。 */
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
      finish_reason: stopReason === 'tool_use' ? 'tool_calls' : stopReason === 'max_tokens' ? 'length' : 'stop',
    }],
  };
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === 'object' && typeof (p as Record<string, unknown>).text === 'string' ? (p as Record<string, unknown>).text as string : '')).join('');
  }
  return String(content);
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
