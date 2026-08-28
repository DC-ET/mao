import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { ensureContentPresent } from '../core/message-history-normalizer.js';
import { ImageFileSupport } from '../tool/image-file-support.js';
import { PromptImageResizer } from '../tool/prompt-image-resizer.js';
import { harnessLog } from '../log.js';
import type {
  ChatCallback,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatUsage,
  ContentPart,
  LlmAdapter,
  LlmModelConfig,
  LlmRetryConfig,
  StreamCallback,
  ToolCall,
} from './chat-request.js';
import { DEFAULT_LLM_RETRY } from './chat-request.js';
import { EmptyResponseExhaustedException } from './empty-response-exhausted.js';
import { applyClientImpersonationHeaders } from './client-impersonation-headers.js';

const IMAGE_PLACEHOLDER = '「此处用户上传了图片」';

/** Anthropic Messages API 要求显式传 max_tokens，本期不落库，统一常量。 */
export const ANTHROPIC_MAX_OUTPUT_TOKENS = 16384;

const ANTHROPIC_VERSION = '2023-06-01';

const SUPPORTED_IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

class StreamInterruptedAfterOutputException extends Error {
  constructor(cause?: unknown) {
    super('LLM stream interrupted after output started; automatic retry disabled');
    this.name = 'StreamInterruptedAfterOutputException';
    this.cause = cause;
  }
}

/** 推理模型思考被输出长度上限截断（stop_reason=max_tokens 且无正式 content / tool calls），
 *  该轮只有思考没有回答，按可重试异常处理，重试前丢弃思考过程。 */
class StreamThinkingTruncatedException extends Error {
  constructor() {
    super('Model thinking truncated by output limit (stop_reason=max_tokens without content)');
    this.name = 'StreamThinkingTruncatedException';
  }
}

/** 上游在流已开始（HTTP 200 已发出）后失败，错误只能内嵌在 SSE 事件里下发。
 *  必须显式识别，否则会被当成一次内容为空的正常响应，进而被误判为「LLM 返回空响应」。 */
class StreamErrorEventException extends Error {
  constructor(readonly statusCode: number | null, detail: string) {
    super(`LLM stream reported error event${statusCode != null ? ` (code ${statusCode})` : ''}: ${detail}`);
    this.name = 'StreamErrorEventException';
  }

  /** 限流与服务端故障可重试；参数、鉴权、余额类错误重试无意义。 */
  get retryable(): boolean {
    if (this.statusCode == null) return true;
    return this.statusCode === 408 || this.statusCode === 429
      || (this.statusCode >= 500 && this.statusCode < 600);
  }
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: http.IncomingMessage;
  started: number;
  req: http.ClientRequest;
}

export class AnthropicLlmAdapter implements LlmAdapter {
  constructor(private readonly retry: LlmRetryConfig = DEFAULT_LLM_RETRY) {}

  async chat(
    request: ChatRequest,
    config: LlmModelConfig,
    cancelFlag?: { get(): boolean } | null,
    callback?: ChatCallback | null,
  ): Promise<ChatResponse> {
    const payload = await this.buildRequestBody(request, config, false);
    const totalStarted = process.hrtime.bigint();
    for (let attempt = 1; ; attempt++) {
      if (this.isCancelled(cancelFlag)) throw this.cancelledException();
      const attemptStarted = process.hrtime.bigint();
      try {
        const awaited = await this.awaitResponse(payload, config, false, cancelFlag, callback ?? null, config.modelId ?? '', attempt);
        harnessLog('info', `LLM response headers model=${config.modelId} phase=response_headers attempt=${attempt}`);
        if (this.isRetryableStatus(awaited.status)) {
          if (attempt > this.retry.rateLimitMaxRetries) {
            const detail = await this.readErrorBody(awaited.body);
            throw new Error(`LLM API returned ${awaited.status} after ${this.retry.rateLimitMaxRetries} retries: ${detail}`);
          }
          const delaySeconds = this.resolveRetryDelaySeconds(awaited.headers, attempt);
          this.logRetry(config.modelId, 'http_status', awaited.status, attempt, delaySeconds, attemptStarted, totalStarted);
          callback?.onRetry?.('http_status', awaited.status, attempt, this.retry.rateLimitMaxRetries, delaySeconds);
          awaited.body.resume();
          if (!(await this.sleepSecondsRespectingCancel(delaySeconds, cancelFlag))) {
            throw this.cancelledException();
          }
          continue;
        }
        if (awaited.status < 200 || awaited.status >= 300) {
          const detail = await this.readErrorBody(awaited.body);
          throw new Error(`LLM API returned ${awaited.status}: ${detail}`);
        }
        const json = await this.readBodyRespectingCancel(
          awaited.body, cancelFlag, awaited.started + this.retry.httpCallTimeoutSeconds * 1000, awaited.req,
        );
        if (this.isCancelled(cancelFlag)) throw this.cancelledException();
        return parseAnthropicChatResponse(JSON.parse(json));
      } catch (e) {
        if (this.isCancelled(cancelFlag)) throw this.cancelledException();
        if (e instanceof Error && e.message.startsWith('LLM API returned')) throw e;
        if (!this.isRetryableNetworkFailure(e) || attempt > this.retry.rateLimitMaxRetries) {
          throw new Error(`LLM call failed: ${this.networkReason(e)}`, { cause: e });
        }
        const delaySeconds = this.resolveRetryDelaySeconds(null, attempt);
        const reason = this.networkReason(e);
        this.logRetry(config.modelId, reason, null, attempt, delaySeconds, attemptStarted, totalStarted);
        callback?.onRetry?.(reason, null, attempt, this.retry.rateLimitMaxRetries, delaySeconds);
        if (!(await this.sleepSecondsRespectingCancel(delaySeconds, cancelFlag))) {
          throw this.cancelledException();
        }
      }
    }
  }

  async stream(
    request: ChatRequest,
    config: LlmModelConfig,
    callback: StreamCallback,
    cancelFlag?: { get(): boolean } | null,
  ): Promise<void> {
    const payload = await this.buildRequestBody(request, config, true);
    const totalStarted = process.hrtime.bigint();
    for (let attempt = 1; ; attempt++) {
      if (this.isCancelled(cancelFlag)) {
        callback.onError(this.cancelledException());
        return;
      }
      const attemptStarted = process.hrtime.bigint();
      let awaited: HttpResult;
      try {
        awaited = await this.awaitResponse(payload, config, true, cancelFlag, callback, config.modelId ?? '', attempt);
      } catch (e) {
        if (this.isCancelled(cancelFlag)) {
          callback.onError(this.cancelledException());
          return;
        }
        if (!this.isRetryableNetworkFailure(e) || attempt > this.retry.rateLimitMaxRetries) {
          callback.onError(e);
          return;
        }
        const delaySeconds = this.resolveRetryDelaySeconds(null, attempt);
        if (!(await this.notifyAndWaitForRetry(callback, cancelFlag, config.modelId, this.networkReason(e), null, attempt, delaySeconds, attemptStarted, totalStarted))) {
          callback.onError(this.cancelledException());
          return;
        }
        continue;
      }
      try {
        harnessLog('info', `LLM response headers model=${config.modelId} phase=response_headers attempt=${attempt}`);
        if (this.isRetryableStatus(awaited.status)) {
          if (attempt > this.retry.rateLimitMaxRetries) {
            const detail = await this.readErrorBody(awaited.body);
            callback.onError(new Error(`LLM API returned ${awaited.status} after ${this.retry.rateLimitMaxRetries} retries: ${detail}`));
            return;
          }
          const delaySeconds = this.resolveRetryDelaySeconds(awaited.headers, attempt);
          awaited.body.resume();
          if (!(await this.notifyAndWaitForRetry(callback, cancelFlag, config.modelId, 'http_status', awaited.status, attempt, delaySeconds, attemptStarted, totalStarted))) {
            callback.onError(this.cancelledException());
            return;
          }
          continue;
        }
        if (awaited.status < 200 || awaited.status >= 300) {
          const detail = await this.readErrorBody(awaited.body);
          callback.onError(new Error(`LLM API returned ${awaited.status}: ${detail}`));
          return;
        }
        await this.processStreamBody(awaited.body, callback, cancelFlag);
        return;
      } catch (e) {
        if (this.isCancelled(cancelFlag)) {
          callback.onError(this.cancelledException());
          return;
        }
        // 空响应重试耗尽是终态：原样透传给 onError，禁止包装、禁止整轮流重试
        if (e instanceof EmptyResponseExhaustedException) {
          callback.onError(e);
          return;
        }
        const streamError = e instanceof StreamErrorEventException ? e : null;
        const truncated = e instanceof StreamInterruptedAfterOutputException
          || e instanceof StreamThinkingTruncatedException;
        const retryable = streamError != null ? streamError.retryable : this.isRetryableNetworkFailure(e);
        if (!retryable || attempt > this.retry.rateLimitMaxRetries) {
          callback.onError(this.describeStreamFailure(e, streamError, truncated, retryable));
          return;
        }
        if (truncated || streamError != null) {
          // 丢弃本轮残留输出（被截断的思考或中途失败前的片段），下一轮从干净状态重新生成
          callback.onStreamReset?.();
        }
        const delaySeconds = this.resolveRetryDelaySeconds(null, attempt);
        const reason = streamError != null ? 'stream_error_event' : this.networkReason(e);
        if (!(await this.notifyAndWaitForRetry(callback, cancelFlag, config.modelId, reason, streamError?.statusCode ?? null, attempt, delaySeconds, attemptStarted, totalStarted))) {
          callback.onError(this.cancelledException());
          return;
        }
      }
    }
  }

  /** 把流式失败翻译成给用户看的最终错误。 */
  private describeStreamFailure(
    failure: unknown,
    streamError: StreamErrorEventException | null,
    truncated: boolean,
    retryable: boolean,
  ): unknown {
    if (streamError != null) {
      const suffix = retryable ? '，自动重试已耗尽，请稍后重试' : '';
      const prefix = streamError.statusCode === 429
        ? '上游模型触发限流（流式响应中途返回 429）'
        : '模型流式响应中途返回错误';
      return new Error(`${prefix}${suffix}：${streamError.message}`, { cause: streamError });
    }
    if (truncated) {
      return new Error(
        failure instanceof StreamThinkingTruncatedException
          ? '模型思考被输出上限截断，自动重试已耗尽，请重试'
          : '模型流式响应已中断，自动重试已耗尽',
        { cause: failure },
      );
    }
    return failure;
  }

  /** Anthropic Messages SSE 事件流解析：把事件流映射成统一的 OpenAI 形状 StreamChunk。 */
  private async processStreamBody(
    body: http.IncomingMessage,
    callback: StreamCallback,
    cancelFlag?: { get(): boolean } | null,
  ): Promise<void> {
    const usage: ChatUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    // Anthropic usage 口径：总输入 = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
    // （input_tokens 不含缓存部分）。message_start 与 message_delta 的 usage 均为请求级累计值，
    // 部分网关（sglang/vLLM 系）message_start 的 input_tokens 为 0、真实值只在 message_delta 下发，
    // 因此按「有值即覆盖」逐字段合并，流结束后统一折算。
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let cacheReadTokens: number | null = null;
    let cacheCreationTokens: number | null = null;

    const applyUsageFields = (fields: AnthropicUsageFields): void => {
      if (fields.inputTokens != null) inputTokens = fields.inputTokens;
      if (fields.outputTokens != null) outputTokens = fields.outputTokens;
      if (fields.cacheRead != null) cacheReadTokens = fields.cacheRead;
      if (fields.cacheCreation != null) cacheCreationTokens = fields.cacheCreation;
    };

    let emitted = false;
    let done = false;
    let buffer = '';
    let stopReason: string | null = null;
    let hasContentOutput = false;
    // fatal：截断的 UTF-8 必须报错，静默降级为 U+FFFD 会让被截断的流看起来正常完成
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let lastData = Date.now();
    const idleMs = this.retry.streamIdleTimeoutSeconds * 1000;

    let idleTimedOut: Error | null = null;

    const waiting = setInterval(() => {
      if (this.isCancelled(cancelFlag)) {
        body.destroy();
        return;
      }
      callback.onWaiting?.('stream_data', Math.floor((Date.now() - lastData) / 1000));
    }, 2000);

    const idleTimer = setInterval(() => {
      if (Date.now() - lastData > idleMs) {
        idleTimedOut = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT', name: 'TimeoutError' });
        body.destroy(idleTimedOut);
      }
    }, 100);

    /** 处理一整行 SSE data；Anthropic 流没有 [DONE]，以 message_stop 事件作为结束标志。 */
    const handleLine = (line: string): void => {
      if (!line.startsWith('data:')) return;
      lastData = Date.now();
      const data = line.slice(5).trim();
      if (data === '') return;
      try {
        const evt = JSON.parse(data) as Record<string, unknown>;
        const type = typeof evt.type === 'string' ? evt.type : '';
        switch (type) {
          case 'message_start': {
            const message = isPlainObject(evt.message) ? evt.message : {};
            const u = extractUsageFields(message.usage);
            if (u != null) applyUsageFields(u);
            break;
          }
          case 'content_block_start': {
            const index = typeof evt.index === 'number' ? evt.index : -1;
            const block = isPlainObject(evt.content_block) ? evt.content_block : {};
            const blockType = typeof block.type === 'string' ? block.type : '';
            if (blockType === 'tool_use') {
              hasContentOutput = true;
              const id = typeof block.id === 'string' && block.id !== '' ? block.id : undefined;
              const name = typeof block.name === 'string' ? block.name : '';
              callback.onChunk({
                choices: [{
                  index: 0,
                  delta: { toolCalls: [{ index, id, type: 'function', function: { name, arguments: '' } }] },
                }],
              });
              emitted = true;
            }
            break;
          }
          case 'content_block_delta': {
            const index = typeof evt.index === 'number' ? evt.index : -1;
            const delta = isPlainObject(evt.delta) ? evt.delta : {};
            const deltaType = typeof delta.type === 'string' ? delta.type : '';
            if (deltaType === 'text_delta' && typeof delta.text === 'string' && delta.text !== '') {
              hasContentOutput = true;
              callback.onChunk({ choices: [{ index: 0, delta: { content: delta.text } }] });
              emitted = true;
            } else if (deltaType === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking !== '') {
              callback.onChunk({ choices: [{ index: 0, delta: { reasoningContent: delta.thinking } }] });
              emitted = true;
            } else if (deltaType === 'input_json_delta' && typeof delta.partial_json === 'string' && delta.partial_json !== '') {
              callback.onChunk({
                choices: [{ index: 0, delta: { toolCalls: [{ index, function: { arguments: delta.partial_json } }] } }],
              });
              emitted = true;
            }
            // signature_delta 仅在启用 extended thinking 时出现，本期忽略
            break;
          }
          case 'content_block_stop':
            // 无需按块收尾处理；input_json_delta 分片由 AgentLoop 按 index/id 聚合
            break;
          case 'message_delta': {
            const delta = isPlainObject(evt.delta) ? evt.delta : {};
            if (typeof delta.stop_reason === 'string' && delta.stop_reason !== '') stopReason = delta.stop_reason;
            const u = extractUsageFields(evt.usage);
            if (u != null) applyUsageFields(u);
            break;
          }
          case 'message_stop': {
            done = true;
            break;
          }
          case 'error': {
            const err = isPlainObject(evt.error) ? evt.error : {};
            const detail = typeof err.message === 'string' && err.message.trim() !== '' ? err.message : 'upstream stream error';
            throw new StreamErrorEventException(anthropicErrorTypeToStatus(err.type), detail);
          }
          default:
            break; // ping 等其他事件
        }
      } catch (e) {
        if (e instanceof StreamErrorEventException) throw e;
        harnessLog('warn', `Failed to parse Anthropic SSE event: ${data}`, e);
      }
    };

    try {
      for await (const chunk of body) {
        if (idleTimedOut) throw idleTimedOut;
        if (this.isCancelled(cancelFlag)) {
          throw new Error('Cancelled by user');
        }
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          handleLine(line);
          if (done) break;
        }
        if (done) break;
      }
      buffer += decoder.decode();
      // 上游可能不以换行结尾，残留在 buffer 里的最后一行同样是有效事件
      if (!done && buffer.trim() !== '') {
        handleLine(buffer);
        buffer = '';
      }
      if (idleTimedOut) throw idleTimedOut;
      if (!done) {
        const eof = Object.assign(new Error('stream ended before message_stop'), { name: 'EOFException' });
        if (emitted) throw new StreamInterruptedAfterOutputException(eof);
        throw eof;
      }
      // 思考被输出上限截断：只有思考没有正式回答，丢弃该轮并按可重试异常处理
      if (stopReason === 'max_tokens' && !hasContentOutput) {
        throw new StreamThinkingTruncatedException();
      }
      const finalized = finalizeUsage(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens);
      usage.promptTokens = finalized.promptTokens;
      usage.completionTokens = finalized.completionTokens;
      usage.totalTokens = finalized.totalTokens;
      if (finalized.promptTokensDetails != null) usage.promptTokensDetails = finalized.promptTokensDetails;
      callback.onComplete(usage);
    } catch (e) {
      if (idleTimedOut) throw idleTimedOut;
      if (e instanceof EmptyResponseExhaustedException) throw e;
      if (e instanceof StreamErrorEventException) throw e;
      if (e instanceof StreamInterruptedAfterOutputException || e instanceof StreamThinkingTruncatedException) throw e;
      if (emitted) throw new StreamInterruptedAfterOutputException(e);
      throw e;
    } finally {
      clearInterval(waiting);
      clearInterval(idleTimer);
    }
  }

  private awaitResponse(
    payload: string,
    config: LlmModelConfig,
    streaming: boolean,
    cancelFlag: { get(): boolean } | null | undefined,
    callback: Pick<StreamCallback, 'onWaiting'> | null,
    model: string,
    attempt: number,
  ): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const url = new URL((config.baseUrl ?? '').replace(/\/$/, '') + '/messages');
      const lib = url.protocol === 'https:' ? https : http;
      const headers: Record<string, string> = {
        // 同值双发：官方走 x-api-key，网关类渠道（如 OpenRouter 风格代理）多认 Bearer
        'x-api-key': config.apiKey ?? '',
        Authorization: `Bearer ${config.apiKey ?? ''}`,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      };
      applyClientImpersonationHeaders(headers, config.clientImpersonation);
      const started = Date.now();
      const headerDeadline = started + this.retry.callTimeoutSeconds * 1000;
      const callDeadline = streaming ? Number.POSITIVE_INFINITY : started + this.retry.httpCallTimeoutSeconds * 1000;
      let settled = false;
      let nextWaiting = started + 1000;

      let connectTimer: NodeJS.Timeout | null = null;
      const clearConnectTimer = () => {
        if (connectTimer != null) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
      };
      const req = lib.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(payload).toString() },
      }, (res) => {
        if (settled) return;
        settled = true;
        clearConnectTimer();
        clearInterval(poll);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res, started, req });
      });

      req.on('socket', (socket) => {
        if (!socket.connecting) return;
        connectTimer = setTimeout(() => {
          abort(Object.assign(new Error('connect timeout'), { name: 'ConnectException' }));
        }, 30_000);
        socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', clearConnectTimer);
      });

      const abort = (err: Error) => {
        if (settled) return;
        settled = true;
        clearConnectTimer();
        clearInterval(poll);
        req.destroy();
        reject(err);
      };

      const poll = setInterval(() => {
        if (this.isCancelled(cancelFlag)) {
          abort(this.cancelledException());
          return;
        }
        const now = Date.now();
        if (now >= headerDeadline) {
          harnessLog('warn', `LLM timeout model=${model} phase=response_headers attempt=${attempt}`);
          abort(Object.assign(new Error(`response headers timed out after ${this.retry.callTimeoutSeconds}s`), { name: 'TimeoutException' }));
          return;
        }
        if (now >= callDeadline) {
          abort(Object.assign(new Error('timeout'), { name: 'InterruptedIOException', code: 'http_call_timeout' }));
          return;
        }
        if (callback && now >= nextWaiting) {
          callback.onWaiting?.('response_headers', Math.floor((now - started) / 1000));
          nextWaiting = now + 2000;
        }
      }, 100);

      req.on('error', (err) => abort(err));
      req.write(payload);
      req.end();
    });
  }

  /** ChatRequest（OpenAI 形状）→ Anthropic Messages 请求体。 */
  private async buildRequestBody(request: ChatRequest, config: LlmModelConfig, stream: boolean): Promise<string> {
    const messages = request.messages != null ? [...request.messages] : null;
    ensureContentPresent(messages);
    const supportsVision = config.supportsVision === true;
    if (!supportsVision && messages) {
      replaceImagesWithPlaceholder(messages);
    }
    if (messages) {
      for (const msg of messages) {
        await convertImageUrlsToBase64(msg);
      }
    }
    const converted = convertMessages(messages ?? []);
    const body: Record<string, unknown> = {
      model: config.modelId ?? '',
      max_tokens: ANTHROPIC_MAX_OUTPUT_TOKENS,
      stream,
      messages: converted.messages,
    };
    if (converted.system != null) body.system = converted.system;
    if (request.temperature != null) body.temperature = request.temperature;
    if (request.tools != null && request.tools.length > 0) {
      const tools = request.tools
        .map((t) => (t.function ? { name: t.function.name ?? '', description: t.function.description ?? '', input_schema: t.function.parameters ?? { type: 'object', properties: {} } } : null))
        .filter((t): t is { name: string; description: string; input_schema: Record<string, unknown> } => t != null);
      if (tools.length > 0) body.tools = tools;
    }
    return JSON.stringify(body);
  }

  private resolveRetryDelaySeconds(headers: http.IncomingHttpHeaders | null, attempt: number): number {
    const maxDelay = this.retry.rateLimitMaxRetryDelaySeconds;
    if (headers) {
      const retryAfter = Array.isArray(headers['retry-after']) ? headers['retry-after'][0] : headers['retry-after'];
      if (retryAfter && retryAfter.trim() !== '') {
        const seconds = Number.parseInt(retryAfter.trim(), 10);
        if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, maxDelay);
      }
      // Anthropic 官方限流响应头：重试等待秒数
      const retryAfterMs = headers['retry-after-ms'];
      const msValue = Array.isArray(retryAfterMs) ? retryAfterMs[0] : retryAfterMs;
      if (msValue && msValue.trim() !== '') {
        const ms = Number.parseFloat(msValue.trim());
        if (Number.isFinite(ms) && ms > 0) return Math.min(Math.max(1, Math.ceil(ms / 1000)), maxDelay);
      }
    }
    const baseDelay = this.retry.rateLimitRetryDelaySeconds;
    if (baseDelay <= 0 || maxDelay <= 0) return 0;
    const shift = Math.min(Math.max(attempt - 1, 0), 30);
    const backoff = Math.min(baseDelay * (2 ** shift), maxDelay);
    const lower = Math.max(1, Math.floor((backoff + 1) / 2));
    return lower + Math.floor(Math.random() * (backoff + 1 - lower));
  }

  private async sleepSecondsRespectingCancel(seconds: number, cancelFlag?: { get(): boolean } | null): Promise<boolean> {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      if (this.isCancelled(cancelFlag)) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
    return true;
  }

  private async notifyAndWaitForRetry(
    callback: StreamCallback,
    cancelFlag: { get(): boolean } | null | undefined,
    model: string | undefined,
    reason: string,
    statusCode: number | null,
    attempt: number,
    delaySeconds: number,
    attemptStarted: bigint,
    totalStarted: bigint,
  ): Promise<boolean> {
    if (this.isCancelled(cancelFlag)) return false;
    this.logRetry(model, reason, statusCode, attempt, delaySeconds, attemptStarted, totalStarted);
    callback.onRetry?.(reason, statusCode, attempt, this.retry.rateLimitMaxRetries, delaySeconds);
    return this.sleepSecondsRespectingCancel(delaySeconds, cancelFlag);
  }

  private logRetry(model: string | undefined, reason: string, statusCode: number | null, attempt: number, delaySeconds: number, _a: bigint, _t: bigint): void {
    harnessLog('warn', `LLM retry model=${model} phase=retry reason=${reason} statusCode=${statusCode} attempt=${attempt} maxRetries=${this.retry.rateLimitMaxRetries} delaySeconds=${delaySeconds}`);
  }

  private isRetryableNetworkFailure(failure: unknown): boolean {
    let cause: unknown = failure;
    while (cause) {
      if (cause instanceof Error) {
        const name = cause.name;
        const msg = cause.message ?? '';
        if (cause instanceof EmptyResponseExhaustedException) return false;
        if (name === 'TimeoutException' || name === 'TimeoutError' || name === 'EOFException'
          || name === 'ConnectException' || name === 'InterruptedIOException'
          || (cause as NodeJS.ErrnoException).code === 'ETIMEDOUT'
          || (cause as NodeJS.ErrnoException).code === 'ECONNRESET'
          || (cause as NodeJS.ErrnoException).code === 'ECONNREFUSED'
          || (cause as NodeJS.ErrnoException).code === 'ENOTFOUND'
          || (cause as NodeJS.ErrnoException).code === 'EAI_AGAIN'
          || (cause as NodeJS.ErrnoException).code === 'http_call_timeout'
          || cause instanceof StreamInterruptedAfterOutputException
          || cause instanceof StreamThinkingTruncatedException
          || msg.includes('stream ended before [DONE]')
          || msg.includes('stream ended before message_stop')
          || msg.includes('timeout')
          || msg.includes('ECONNRESET')
          || msg.includes('socket hang up')) {
          return true;
        }
        cause = cause.cause;
        continue;
      }
      break;
    }
    return false;
  }

  private networkReason(failure: unknown): string {
    let cause: unknown = failure;
    while (cause) {
      if (cause instanceof Error) {
        if (cause.name === 'TimeoutException') return 'response_header_timeout';
        if (cause.name === 'TimeoutError' || (cause as NodeJS.ErrnoException).code === 'ETIMEDOUT') return 'stream_idle_timeout';
        if (cause.name === 'InterruptedIOException' || (cause as NodeJS.ErrnoException).code === 'http_call_timeout') return 'http_call_timeout';
        if (cause.name === 'ConnectException') return 'connect_failure';
        if ((cause as NodeJS.ErrnoException).code === 'ENOTFOUND') return 'dns_lookup_failure';
        if ((cause as NodeJS.ErrnoException).code === 'EAI_AGAIN') return 'dns_temporary_failure';
        if (cause.name === 'EOFException' || cause.message.includes('stream ended before message_stop')) return 'unexpected_eof';
        if (cause instanceof StreamThinkingTruncatedException) return 'thinking_truncated';
        if (cause.cause == null) break;
        cause = cause.cause;
        continue;
      }
      break;
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.toLowerCase().includes('reset')) return 'connection_reset';
    return 'io_failure';
  }

  private cancelledException(): Error {
    return new Error('Cancelled by user');
  }

  private isCancelled(cancelFlag?: { get(): boolean } | null): boolean {
    return cancelFlag != null && cancelFlag.get();
  }

  private isRetryableStatus(code: number): boolean {
    return code === 404 || code === 429 || (code >= 500 && code < 600);
  }

  private async readErrorBody(body: http.IncomingMessage): Promise<string> {
    try {
      const chunks: Buffer[] = [];
      for await (const c of body) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString('utf8');
      return text.length > 500 ? text.slice(0, 500) : text;
    } catch {
      return '';
    }
  }

  private async readBodyRespectingCancel(
    body: http.IncomingMessage,
    cancelFlag?: { get(): boolean } | null,
    callDeadline?: number,
    req?: http.ClientRequest,
  ): Promise<string> {
    const chunks: Buffer[] = [];
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error, text?: string) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        if (err) reject(err);
        else resolve(text ?? '');
      };
      const poll = setInterval(() => {
        if (this.isCancelled(cancelFlag)) {
          body.destroy();
          req?.destroy();
          finish(this.cancelledException());
          return;
        }
        if (callDeadline != null && Date.now() >= callDeadline) {
          body.destroy();
          req?.destroy();
          finish(Object.assign(new Error('timeout'), { name: 'InterruptedIOException', code: 'http_call_timeout' }));
        }
      }, 50);
      body.on('data', (c: Buffer) => chunks.push(c));
      body.on('end', () => finish(undefined, Buffer.concat(chunks).toString('utf8')));
      body.on('error', (err) => finish(err));
    });
  }
}

// ---------------------------------------------------------------------------
// 消息转换：OpenAI 形状（Mao 统一类型）→ Anthropic Messages 形状
// ---------------------------------------------------------------------------

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  source?: { type: string; media_type: string; data: string };
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

/** 纯函数转换：把 OpenAI 形状消息序列转换成 Anthropic 消息序列 + 顶层 system。
 *  关键规则：连续 role:'tool' 消息必须合并为一条 user 消息内的多个 tool_result block；
 *  tool 消息后紧跟的 user 消息并入同一条；相邻同 role 消息统一合并，保证严格交替。 */
export function convertMessages(messages: ChatMessage[]): { messages: AnthropicMessage[]; system: string | null } {
  const systemParts: string[] = [];
  const converted: AnthropicMessage[] = [];
  let toolResultBlocks: AnthropicContentBlock[] = [];
  let trailingBlocks: AnthropicContentBlock[] = [];

  const pushBlocks = (role: 'user' | 'assistant', blocks: AnthropicContentBlock[]): void => {
    const last = converted[converted.length - 1];
    if (last != null && last.role === role) {
      last.content.push(...blocks);
    } else {
      converted.push({ role, content: blocks });
    }
  };

  for (const msg of messages) {
    const role = msg.role ?? 'user';
    if (role === 'system') {
      // Anthropic 仅支持顶层 system 参数；首条外的 system 降级为 user 文本（防御，正常历史不会出现）
      if (systemParts.length === 0 && converted.length === 0) {
        const text = extractMessageText(msg.content);
        if (text !== '') systemParts.push(text);
      } else {
        const text = extractMessageText(msg.content);
        if (text !== '') pushBlocks('user', [{ type: 'text', text }]);
      }
      continue;
    }
    if (role === 'tool') {
      // tool 结果 → user 消息里的 tool_result block，与后续 user 文本合并到同一条。
      // Anthropic 要求 tool_result 位于 user 消息 block 序列最前：连续多条 tool 消息合并进同一条
      // user 消息时，必须把全部 tool_result 集中在前段（toolResultsBlocks），图片等其余 block
      // 追加在后段（trailingBlocks），否则中间夹杂的图片会导致请求 400。
      const resultText = extractMessageText(msg.content);
      toolResultBlocks.push({ type: 'tool_result', tool_use_id: msg.toolCallId ?? '', content: resultText });
      for (const part of imageParts(msg.content)) {
        const block = toAnthropicImageBlock(part);
        if (block != null) trailingBlocks.push(block);
      }
      continue;
    }
    if (toolResultBlocks.length > 0) {
      pushBlocks('user', [...toolResultBlocks, ...trailingBlocks]);
      toolResultBlocks = [];
      trailingBlocks = [];
    }
    if (role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      const text = extractMessageText(msg.content);
      if (text !== '') blocks.push({ type: 'text', text });
      for (const tc of msg.toolCalls ?? []) {
        // name 缺失不能跳过：跳过会产生悬空 tool_result（配对的 tool 消息仍在），Anthropic 将 400。
        // 兜底为空 input 的占位 tool_use，维持 tool_use/tool_result 配对完整。
        blocks.push({
          type: 'tool_use',
          id: tc.id ?? '',
          name: tc.function?.name ?? '',
          input: safeParseJsonObject(tc.function?.arguments),
        });
      }
      if (blocks.length > 0) pushBlocks('assistant', blocks);
      continue;
    }
    // user 消息
    const blocks: AnthropicContentBlock[] = [];
    for (const part of imageParts(msg.content)) {
      const block = toAnthropicImageBlock(part);
      if (block != null) blocks.push(block);
    }
    const text = extractMessageText(msg.content);
    if (text !== '' || blocks.length === 0) {
      blocks.push({ type: 'text', text });
    }
    pushBlocks('user', blocks);
  }

  if (toolResultBlocks.length > 0) {
    pushBlocks('user', [...toolResultBlocks, ...trailingBlocks]);
    toolResultBlocks = [];
    trailingBlocks = [];
  }
  return {
    messages: converted.map((m) => ({ role: m.role, content: m.content })),
    system: systemParts.length > 0 ? systemParts.join('\n\n') : null,
  };
}

/** 非流式响应 → 统一 ChatResponse（OpenAI 形状）。 */
export function parseAnthropicChatResponse(raw: unknown): ChatResponse {
  const o = isPlainObject(raw) ? raw : {};
  const content = Array.isArray(o.content) ? o.content : [];
  const stopReason = typeof o.stop_reason === 'string' ? o.stop_reason : undefined;

  let text = '';
  const toolCalls: ToolCall[] = [];
  let toolIndex = 0;
  for (const block of content) {
    if (!isPlainObject(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        index: toolIndex++,
        id: typeof block.id === 'string' ? block.id : undefined,
        type: 'function',
        function: {
          name: typeof block.name === 'string' ? block.name : undefined,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
    // thinking block 在非流式路径中不回传（Mao 持久化无签名，主动开启 thinking 前不启用）
  }

  return {
    id: typeof o.id === 'string' ? o.id : undefined,
    model: typeof o.model === 'string' ? o.model : undefined,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      },
      finishReason: mapStopReason(stopReason),
    }],
    usage: mapAnthropicChatUsage(o.usage),
  };
}

export function mapStopReason(stopReason: string | undefined): string {
  switch (stopReason) {
    case 'tool_use': return 'tool_calls';
    case 'max_tokens': return 'length';
    case 'end_turn':
    case 'stop_sequence':
    default: return 'stop';
  }
}

/** Anthropic usage 响应中的原始字段（均为可选，有值才覆盖）。 */
interface AnthropicUsageFields {
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheCreation?: number;
}

function extractUsageFields(raw: unknown): AnthropicUsageFields | null {
  if (!isPlainObject(raw)) return null;
  const input = toNumber(raw.input_tokens);
  const output = toNumber(raw.output_tokens);
  const cacheRead = toNumber(raw.cache_read_input_tokens);
  const cacheCreation = toNumber(raw.cache_creation_input_tokens);
  if (input == null && output == null && cacheRead == null && cacheCreation == null) return null;
  return {
    ...(input != null ? { inputTokens: input } : {}),
    ...(output != null ? { outputTokens: output } : {}),
    ...(cacheRead != null ? { cacheRead } : {}),
    ...(cacheCreation != null ? { cacheCreation } : {}),
  };
}

/** Anthropic 口径 → 统一 ChatUsage：总输入 = input + cache_creation + cache_read（与官方语义一致，
 *  OpenAI 口径的 prompt_tokens 本就是全量输入，cachedTokens 是其子集）。 */
function finalizeUsage(
  inputTokens: number | null,
  outputTokens: number | null,
  cacheRead: number | null,
  cacheCreation: number | null,
): { promptTokens: number; completionTokens: number; totalTokens: number; promptTokensDetails?: { cachedTokens: number | null } } {
  const promptTokens = (inputTokens ?? 0) + (cacheCreation ?? 0) + (cacheRead ?? 0);
  const completionTokens = outputTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ...(cacheRead != null ? { promptTokensDetails: { cachedTokens: cacheRead } } : {}),
  };
}

/** 非流式响应用的完整 ChatUsage（含 totalTokens）。 */
function mapAnthropicChatUsage(raw: unknown): ChatUsage | undefined {
  const fields = extractUsageFields(raw);
  if (fields == null) return undefined;
  return finalizeUsage(fields.inputTokens ?? null, fields.outputTokens ?? null, fields.cacheRead ?? null, fields.cacheCreation ?? null);
}

function anthropicErrorTypeToStatus(type: unknown): number | null {
  switch (type) {
    case 'rate_limit_error': return 429;
    case 'authentication_error': return 401;
    case 'permission_error': return 403;
    case 'not_found_error': return 404;
    case 'request_too_large': return 413;
    case 'api_error':
    case 'overloaded_error': return 500;
    default: return null;
  }
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  let sb = '';
  for (const part of content) {
    if (part && typeof part === 'object') {
      const t = (part as Record<string, unknown>).text;
      if (typeof t === 'string') sb += t;
    } else if (typeof part === 'string') {
      sb += part;
    }
  }
  return sb;
}

function imageParts(content: unknown): ContentPart[] {
  if (!Array.isArray(content)) return [];
  return content.filter((p): p is ContentPart => {
    if (!p || typeof p !== 'object') return false;
    const t = (p as Record<string, unknown>).type;
    if (t === 'image_url') return true;
    return t == null && ((p as ContentPart).imageUrl != null || (p as Record<string, unknown>).image_url != null);
  });
}

function toAnthropicImageBlock(part: ContentPart): AnthropicContentBlock | null {
  const url = part.imageUrl?.url
    ?? ((part as Record<string, unknown>).image_url as { url?: string } | undefined)?.url;
  if (url == null || url.trim() === '') return null;
  const parsed = parseDataUriImage(url);
  if (parsed == null) return null;
  return {
    type: 'image',
    source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data },
  };
}

function parseDataUriImage(url: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (match == null) return null;
  const mediaType = match[1].toLowerCase();
  if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) return null;
  return { mediaType, data: match[2] };
}

function safeParseJsonObject(json: string | undefined): Record<string, unknown> {
  if (json == null || json.trim() === '') return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// 图片预处理：与 OpenAiLlmAdapter 相同的占位符/下载/压缩逻辑（复制自 openai-llm-adapter.ts）
// ---------------------------------------------------------------------------

function replaceImagesWithPlaceholder(messages: ChatMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!Array.isArray(msg.content)) continue;
    const textParts: unknown[] = [];
    let hasImage = false;
    for (const part of msg.content) {
      if (extractPartType(part) === 'image_url') hasImage = true;
      else textParts.push(part);
    }
    if (!hasImage) continue;
    let textContent = buildTextFromParts(textParts);
    textContent = textContent ? `${textContent}\n${IMAGE_PLACEHOLDER}` : IMAGE_PLACEHOLDER;
    messages[i] = {
      role: msg.role,
      content: textContent,
      name: msg.name,
      toolCallId: msg.toolCallId,
      toolCalls: msg.toolCalls,
    };
  }
}

async function convertImageUrlsToBase64(msg: ChatMessage): Promise<void> {
  if (!Array.isArray(msg.content)) return;
  for (const part of msg.content) {
    const url = extractImageUrl(part);
    if (!url || url.trim() === '') continue;
    try {
      let base64Uri: string | undefined;
      if (url.startsWith('data:')) {
        base64Uri = await resizeDataUri(url);
      } else {
        base64Uri = await downloadAndEncode(url);
      }
      if (base64Uri) setImageUrl(part, base64Uri);
    } catch (e) {
      harnessLog('warn', `Failed to prepare image for prompt, keeping original URL: ${url.startsWith('data:') ? 'data-uri' : url}`, e);
    }
  }
}

async function resizeDataUri(dataUri: string): Promise<string> {
  const comma = dataUri.indexOf(',');
  if (comma < 0) throw new Error('Invalid data URI');
  const meta = dataUri.slice(5, comma);
  const payload = dataUri.slice(comma + 1);
  let mimeHint: string | undefined;
  const semi = meta.indexOf(';');
  if (semi > 0) mimeHint = meta.slice(0, semi);
  else if (meta.trim() !== '' && !meta.includes('base64')) mimeHint = meta;
  if (!meta.includes('base64')) throw new Error('Only base64 data URIs are supported');
  const bytes = Buffer.from(payload, 'base64');
  const resized = await PromptImageResizer.tryResizeForPrompt(bytes, mimeHint);
  return resized ? resized.toDataUri() : dataUri;
}

async function downloadAndEncode(imageUrl: string): Promise<string> {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status} when downloading image: ${imageUrl}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const declaredMime = res.headers.get('content-type')?.split(';')[0] ?? null;
  const mimeType = ImageFileSupport.resolveImageMime(bytes, declaredMime, imageUrl);
  if (!mimeType) {
    throw new Error(`Downloaded content is not a supported image type: ${imageUrl} (Content-Type=${declaredMime})`);
  }
  const resized = await PromptImageResizer.tryResizeForPrompt(bytes, mimeType);
  if (resized) return resized.toDataUri();
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

function extractImageUrl(part: unknown): string | null {
  if (part && typeof part === 'object') {
    const p = part as ContentPart & Record<string, unknown>;
    if (p.type === 'image_url' && p.imageUrl?.url) return p.imageUrl.url;
    if (p.type === 'image_url' && p.image_url && typeof p.image_url === 'object') {
      return ((p.image_url as Record<string, unknown>).url as string) ?? null;
    }
  }
  return null;
}

function setImageUrl(part: unknown, uri: string): void {
  if (!part || typeof part !== 'object') return;
  const p = part as ContentPart & Record<string, unknown>;
  if (p.imageUrl) p.imageUrl.url = uri;
  else if (p.image_url && typeof p.image_url === 'object') {
    (p.image_url as Record<string, unknown>).url = uri;
  }
}

function extractPartType(part: unknown): string | null {
  if (part && typeof part === 'object') {
    const t = (part as Record<string, unknown>).type;
    return typeof t === 'string' ? t : null;
  }
  return null;
}

function buildTextFromParts(parts: unknown[]): string {
  let sb = '';
  for (const part of parts) {
    if (part && typeof part === 'object') {
      const t = (part as Record<string, unknown>).text;
      if (typeof t === 'string') sb += t;
    }
  }
  return sb.trim();
}



