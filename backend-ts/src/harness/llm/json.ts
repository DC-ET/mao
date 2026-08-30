import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatUsage,
  ContentPart,
  StreamChunk,
  ToolCall,
} from './chat-request.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function serializeImageUrl(url: { url?: string } | undefined): unknown {
  if (!url) return undefined;
  return { url: url.url };
}

function serializeContentPart(part: ContentPart | Record<string, unknown>): unknown {
  if (isPlainObject(part) && !('imageUrl' in part) && 'image_url' in part) {
    return part;
  }
  const p = part as ContentPart;
  const out: Record<string, unknown> = {};
  if (p.type != null) out.type = p.type;
  if (p.text != null) out.text = p.text;
  if (p.imageUrl != null) out.image_url = serializeImageUrl(p.imageUrl);
  return out;
}

function serializeContent(content: unknown): unknown {
  if (Array.isArray(content)) {
    return content.map((p) => serializeContentPart(p as ContentPart));
  }
  return content;
}

function serializeToolCall(tc: ToolCall): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (tc.id != null) out.id = tc.id;
  if (tc.type != null) out.type = tc.type;
  if (tc.function != null) {
    const fn: Record<string, unknown> = {};
    if (tc.function.name != null) fn.name = tc.function.name;
    if (tc.function.arguments != null) fn.arguments = tc.function.arguments;
    out.function = fn;
  }
  if (tc.summary != null) out.summary = tc.summary;
  return out;
}

export function serializeChatMessage(msg: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (msg.role != null) out.role = msg.role;
  out.content = serializeContent(msg.content ?? '');
  if (msg.name != null) out.name = msg.name;
  if (msg.toolCallId != null) out.tool_call_id = msg.toolCallId;
  if (msg.toolCalls != null) out.tool_calls = msg.toolCalls.map(serializeToolCall);
  if (msg.audio != null) out.audio = msg.audio;
  // DeepSeek thinking 模式下，带 tools 的多轮请求要求把上一轮 assistant 的 reasoning_content
  // 原样回传，否则返回 400。其他模型忽略该字段，故统一在有值时透传。
  if (msg.reasoningContent != null && msg.reasoningContent !== '') out.reasoning_content = msg.reasoningContent;
  return out;
}

export function serializeChatRequest(request: ChatRequest, modelId: string, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: modelId,
    messages: (request.messages ?? []).map(serializeChatMessage),
    stream,
  };
  if (request.temperature != null) body.temperature = request.temperature;
  if (request.tools != null && request.tools.length > 0) {
    body.tools = request.tools.map((t) => ({
      type: t.type,
      function: t.function
        ? {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          }
        : undefined,
    }));
  }
  if (request.reasoning != null) body.reasoning = request.reasoning;
  if (request.thinking != null) body.thinking = request.thinking;
  if (request.enableThinking != null) body.enable_thinking = request.enableThinking;
  if (request.audio != null && Object.keys(request.audio).length > 0) body.audio = request.audio;
  return body;
}

function parseToolCalls(raw: unknown): ToolCall[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((item) => {
    const o = (item ?? {}) as Record<string, unknown>;
    const fn = (o.function ?? {}) as Record<string, unknown>;
    return {
      index: o.index == null ? undefined : Number(o.index),
      id: o.id == null || o.id === '' ? undefined : String(o.id),
      type: o.type as string | undefined,
      function: {
        name: fn.name as string | undefined,
        arguments: fn.arguments as string | undefined,
      },
      summary: o.summary as string | undefined,
    };
  });
}

function parseContent(raw: unknown): unknown {
  if (Array.isArray(raw)) {
    return raw.map((item) => {
      if (!isPlainObject(item)) return item;
      const imageUrl = item.image_url ?? item.imageUrl;
      const part: ContentPart = {
        type: item.type as string | undefined,
        text: item.text as string | undefined,
      };
      if (imageUrl && isPlainObject(imageUrl)) {
        part.imageUrl = { url: imageUrl.url as string | undefined };
      }
      return part;
    });
  }
  return raw;
}

function parseMessage(raw: unknown): ChatMessage | undefined {
  if (!isPlainObject(raw)) return undefined;
  return {
    role: raw.role as string | undefined,
    content: parseContent(raw.content),
    name: raw.name as string | undefined,
    toolCallId: (raw.tool_call_id ?? raw.toolCallId) as string | undefined,
    toolCalls: parseToolCalls(raw.tool_calls ?? raw.toolCalls),
    audio: raw.audio as ChatMessage['audio'],
    reasoningContent: normalizeReasoning(raw.reasoning ?? raw.reasoning_content ?? raw.reasoningContent),
  };
}

// 兼容 OpenRouter 风格思考字段：reasoning 为字符串，reasoning_details 为结构化分片数组
function normalizeReasoning(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw === '' ? undefined : raw;
  if (!Array.isArray(raw)) return undefined;
  const text = raw
    .map((item) => {
      if (typeof item === 'string') return item;
      if (isPlainObject(item)) return item.text;
      return undefined;
    })
    .filter((t): t is string => typeof t === 'string')
    .join('');
  return text === '' ? undefined : text;
}

function parseUsage(raw: unknown): ChatUsage | undefined {
  if (!isPlainObject(raw)) return undefined;
  const details = raw.prompt_tokens_details ?? raw.promptTokensDetails;
  const promptTokens = Number(raw.prompt_tokens ?? raw.promptTokens ?? 0);
  const completionTokens = Number(raw.completion_tokens ?? raw.completionTokens ?? 0);
  // L-6：部分网关只回 prompt/completion 不回 total_tokens，此处与 Responses 侧口径一致做兜底，
  // 避免 total 记 0 导致用量统计口径分裂。
  const hasTotal = raw.total_tokens != null || raw.totalTokens != null;
  const usage: ChatUsage = {
    promptTokens,
    completionTokens,
    totalTokens: hasTotal ? Number(raw.total_tokens ?? raw.totalTokens) : promptTokens + completionTokens,
  };
  if (isPlainObject(details)) {
    const cached = details.cached_tokens ?? details.cachedTokens;
    usage.promptTokensDetails = { cachedTokens: cached == null ? null : Number(cached) };
  }
  return usage;
}

export function parseChatResponse(raw: unknown): ChatResponse {
  const o = isPlainObject(raw) ? raw : {};
  const choicesRaw = Array.isArray(o.choices) ? o.choices : [];
  return {
    id: o.id as string | undefined,
    model: o.model as string | undefined,
    choices: choicesRaw.map((c, i) => {
      const ch = isPlainObject(c) ? c : {};
      return {
        index: Number(ch.index ?? i),
        message: parseMessage(ch.message),
        finishReason: (ch.finish_reason ?? ch.finishReason) as string | undefined,
      };
    }),
    usage: parseUsage(o.usage),
  };
}

export function parseStreamChunk(raw: unknown): StreamChunk {
  const o = isPlainObject(raw) ? raw : {};
  const choicesRaw = Array.isArray(o.choices) ? o.choices : [];
  return {
    id: o.id as string | undefined,
    model: o.model as string | undefined,
    choices: choicesRaw.map((c, i) => {
      const ch = isPlainObject(c) ? c : {};
      const delta = isPlainObject(ch.delta) ? ch.delta : undefined;
      return {
        index: Number(ch.index ?? i),
        finishReason: (ch.finish_reason ?? ch.finishReason) as string | undefined,
        delta: delta
          ? {
              role: delta.role as string | undefined,
              content: delta.content as string | undefined,
              toolCalls: parseToolCalls(delta.tool_calls ?? delta.toolCalls),
              reasoningContent: normalizeReasoning(delta.reasoning ?? delta.reasoning_content ?? delta.reasoningContent),
            }
          : undefined,
      };
    }),
  };
}

export function parseUsageFromSse(raw: unknown): ChatUsage | null {
  if (!isPlainObject(raw) || raw.usage == null) return null;
  return parseUsage(raw.usage) ?? null;
}

/** 流式响应中途失败时上游携带的错误信息（HTTP 状态已是 200，错误只能内嵌在 SSE 事件里）。 */
export interface StreamErrorEvent {
  message: string;
  /** 上游给出的原始状态码，可能缺失。 */
  code: number | null;
}

/**
 * 解析 SSE 事件里的顶层 error 字段。
 * OpenRouter 等网关在首个 token 之后触发限流时无法再改写 HTTP 状态码，
 * 会改为下发 `{"error":{"code":429,...},"choices":[{"finish_reason":"error"}]}`，
 * 若不识别就会被当成一次内容为空的正常响应。
 */
export function parseStreamErrorEvent(raw: unknown): StreamErrorEvent | null {
  if (!isPlainObject(raw)) return null;
  const err = raw.error;
  if (typeof err === 'string') {
    return err.trim() === '' ? null : { message: err, code: null };
  }
  if (!isPlainObject(err)) return null;
  const code = err.code == null ? null : Number(err.code);
  const message = typeof err.message === 'string' && err.message.trim() !== ''
    ? err.message
    : 'upstream stream error';
  const metadata = isPlainObject(err.metadata) ? err.metadata : null;
  const detail = metadata != null && typeof metadata.raw === 'string' && metadata.raw.trim() !== ''
    ? metadata.raw
    : null;
  return {
    message: detail != null ? `${message}: ${detail}` : message,
    code: code != null && Number.isFinite(code) ? code : null,
  };
}
