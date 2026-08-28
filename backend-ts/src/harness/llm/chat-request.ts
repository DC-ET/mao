export interface ChatReasoning {
  effort?: string;
}

export interface ChatThinking {
  type?: string;
}

export interface ChatAudio {
  data?: string;
  format?: string;
  transcript?: string;
  duration?: number;
}

export interface ImageUrl {
  url?: string;
}

export interface ContentPart {
  type?: string;
  text?: string;
  imageUrl?: ImageUrl;
}

export interface FunctionDef {
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface FunctionCall {
  name?: string;
  arguments?: string;
}

export interface ToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: FunctionCall;
  summary?: string;
  /** Mao 扩展（仅 openai-responses 协议）：本工具轮 reasoning 项的往返引用。
   *  只挂在轮内首个 toolCall 上，随 tool_calls JSON 持久化；其余协议序列化时忽略。 */
  reasoning?: ReasoningItemRef;
}

/** OpenAI Responses API reasoning 项引用：stateless 多轮回传 function_call 时必须携带配对的 reasoning 项。 */
export interface ReasoningItemRef {
  id?: string;
  encryptedContent?: string;
}

export interface ToolDefinition {
  type?: string;
  function?: FunctionDef;
}

export interface ChatMessage {
  role?: string;
  content?: unknown;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  audio?: ChatAudio;
  reasoningContent?: string;
}

export interface ChatRequest {
  messages?: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  stream?: boolean;
  reasoning?: ChatReasoning;
  thinking?: ChatThinking;
  enableThinking?: boolean;
  audio?: Record<string, unknown>;
}

export interface PromptTokensDetails {
  cachedTokens?: number | null;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptTokensDetails?: PromptTokensDetails | null;
}

export function emptyUsage(): ChatUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export interface ChatChoice {
  index?: number;
  message?: ChatMessage;
  finishReason?: string;
}

export interface ChatResponse {
  id?: string;
  model?: string;
  choices?: ChatChoice[];
  usage?: ChatUsage;
}

export interface StreamDelta {
  role?: string;
  content?: string;
  toolCalls?: ToolCall[];
  reasoningContent?: string;
}

export interface DeltaChoice {
  index?: number;
  delta?: StreamDelta;
  finishReason?: string;
}

export interface StreamChunk {
  id?: string;
  model?: string;
  choices?: DeltaChoice[];
}

import type { ClientImpersonation } from '@mao/contracts';

export interface LlmModelConfig {
  id?: number;
  name?: string;
  provider?: string;
  apiProtocol?: string;
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
  contextWindowTokens?: number;
  supportsVision?: boolean;
  clientImpersonation?: ClientImpersonation;
}

export interface LlmRetryConfig {
  rateLimitMaxRetries: number;
  rateLimitRetryDelaySeconds: number;
  rateLimitMaxRetryDelaySeconds: number;
  callTimeoutSeconds: number;
  httpCallTimeoutSeconds: number;
  streamIdleTimeoutSeconds: number;
}

export const DEFAULT_LLM_RETRY: LlmRetryConfig = {
  rateLimitMaxRetries: 10,
  rateLimitRetryDelaySeconds: 2,
  rateLimitMaxRetryDelaySeconds: 30,
  callTimeoutSeconds: 120,
  httpCallTimeoutSeconds: 180,
  streamIdleTimeoutSeconds: 300,
};

export interface StreamCallback {
  onChunk(chunk: StreamChunk): void;
  onComplete(usage: ChatUsage): void;
  onError(t: unknown): void;
  onStreamReset?(): void;
  onWaiting?(phase: string, elapsedSeconds: number): void;
  onRetry?(reason: string, statusCode: number | null, attempt: number, maxRetries: number, delaySeconds: number): void;
}

export type ChatCallback = Pick<StreamCallback, 'onWaiting' | 'onRetry'>;

export interface LlmAdapter {
  chat(request: ChatRequest, config: LlmModelConfig, cancelFlag?: { get(): boolean } | null, callback?: ChatCallback | null): Promise<ChatResponse>;
  stream(
    request: ChatRequest,
    config: LlmModelConfig,
    callback: StreamCallback,
    cancelFlag?: { get(): boolean } | null,
  ): Promise<void>;
}
