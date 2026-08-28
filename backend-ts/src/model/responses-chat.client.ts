import type { LlmChatClient, LlmChatRequest, LlmChatResponse, LlmModelConfig } from './types.js';
import { applyClientImpersonationHeaders } from '../harness/llm/client-impersonation-headers.js';
import { convertMessages, mapResponsesStatusToFinishReason, RESPONSES_MAX_OUTPUT_TOKENS } from '../harness/llm/responses-llm-adapter.js';
import type { ChatMessage } from '../harness/llm/chat-request.js';

export interface ResponsesChatClientOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 管理后台连通性测试用的 Responses API 非流式客户端（仅 chat，不含工具）。
 *  消息转换复用主 Adapter 的 convertMessages，保证两链路协议行为一致。 */
export class ResponsesChatClient implements LlmChatClient {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ResponsesChatClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chat(request: LlmChatRequest, config: LlmModelConfig): Promise<LlmChatResponse> {
    const url = `${stripTrailingSlash(config.baseUrl)}/responses`;
    const converted = convertMessages(request.messages as ChatMessage[]);
    const body: Record<string, unknown> = {
      model: config.modelId,
      input: converted.input,
      // stateless：连通性探测不落服务端会话
      store: false,
      // 连通性测试只需极短输出；max_output_tokens 含 reasoning token，同样预留预算
      max_output_tokens: RESPONSES_MAX_OUTPUT_TOKENS,
      include: [],
      // 固定非流式：本客户端仅按 JSON 解析响应，不支持 SSE
      stream: false,
    };
    if (converted.instructions != null) body.instructions = converted.instructions;
    if (request.temperature != null) body.temperature = request.temperature;

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

/** Responses 响应 → 统一 LlmChatResponse（拼接全部 message 项的 output_text）。 */
function toChatResponse(raw: Record<string, unknown>): LlmChatResponse {
  const output = Array.isArray(raw.output) ? raw.output : [];
  let text = '';
  for (const item of output) {
    if (!item || typeof item !== 'object' || (item as Record<string, unknown>).type !== 'message') continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === 'object' && (part as Record<string, unknown>).type === 'output_text') {
        const t = (part as Record<string, unknown>).text;
        if (typeof t === 'string') text += t;
      }
    }
  }
  const status = typeof raw.status === 'string' ? raw.status : undefined;
  const incomplete = raw.incomplete_details != null && typeof raw.incomplete_details === 'object'
    ? (raw.incomplete_details as Record<string, unknown>)
    : {};
  return {
    choices: [{
      message: { role: 'assistant', content: text },
      finish_reason: mapResponsesStatusToFinishReason(status, incomplete.reason === 'max_output_tokens'),
    }],
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
