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
import { snapshotCostMicros } from './cost-micros.js';
import type { LlmCallService } from './llm-call.service.js';

/**
 * 请求构成采集（技术方案 2026-10-25-run-trace-content-and-prompt §5.2）。
 * RecordingLlmAdapter 是全部 LLM 调用的必经包装层，chat / stream 的 finally 里
 * 手里就有完整 ChatRequest——系统提示词就是其中的 system 消息、工具目录就是
 * request.tools。采集是纯读取：不改请求、不影响调用与前缀缓存行为；适配器层
 * 已把各协议归一为 role='system'，若未来引入新的系统角色（如 developer），
 * 本函数需同步。
 */

/** 系统提示词采集截断上限（字符）。MEDIUMTEXT 上限 16MB，这是应用层兜底，防极端 MCP 目录撑爆行。 */
export const SYSTEM_PROMPT_CAPTURE_MAX_CHARS = 262_144;

/** 请求里全部 role=system 消息按序 join；无 system 消息返回 null。多模态内容（理论不存在）JSON 序列化兜底。 */
export function captureSystemPrompt(request: ChatRequest): string | null {
  const parts: string[] = [];
  for (const message of request.messages ?? []) {
    if (message.role !== 'system') continue;
    parts.push(typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
  }
  if (parts.length === 0) return null;
  const joined = parts.join('\n\n');
  return joined.length > SYSTEM_PROMPT_CAPTURE_MAX_CHARS
    ? `${joined.slice(0, SYSTEM_PROMPT_CAPTURE_MAX_CHARS)}…[已截断，原长 ${joined.length} 字符]`
    : joined;
}

/** 工具名清单（OpenAI 形态 function.name），保序；无工具或缺 function 名返回 null。 */
export function captureToolNames(request: ChatRequest): string | null {
  const names = (request.tools ?? [])
    .map((tool) => tool.function?.name)
    .filter((name): name is string => typeof name === 'string' && name !== '');
  return names.length > 0 ? JSON.stringify(names) : null;
}

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
        costMicros: snapshotCostMicros(config, usage),
        systemPrompt: captureSystemPrompt(request),
        toolsJson: captureToolNames(request),
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
      onUsage: (u) => {
        usage = u;
        callback.onUsage?.(u);
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
        costMicros: snapshotCostMicros(config, usage),
        systemPrompt: captureSystemPrompt(request),
        toolsJson: captureToolNames(request),
      });
    }
  }
}
