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
  ReasoningItemRef,
  StreamCallback,
  StreamChunk,
  ToolCall,
} from './chat-request.js';
import { DEFAULT_LLM_RETRY } from './chat-request.js';
import { EmptyResponseExhaustedException } from './empty-response-exhausted.js';
import { applyClientImpersonationHeaders } from './client-impersonation-headers.js';

const IMAGE_PLACEHOLDER = '「此处用户上传了图片」';

/** 默认输出上限：Responses API 的 max_output_tokens 含 reasoning token，推理模型需留思考预算。 */
export const RESPONSES_MAX_OUTPUT_TOKENS = 32768;

class StreamInterruptedAfterOutputException extends Error {
  constructor(cause?: unknown) {
    super('LLM stream interrupted after output started; automatic retry disabled');
    this.name = 'StreamInterruptedAfterOutputException';
    this.cause = cause;
  }
}

/** 推理输出被输出长度上限截断（status=incomplete + reason=max_output_tokens 且无正式内容/工具调用）。
 *  该轮只有思考没有回答，按可重试异常处理，重试前丢弃思考过程。 */
class StreamThinkingTruncatedException extends Error {
  constructor() {
    super('Model thinking truncated by output limit (incomplete/max_output_tokens without content)');
    this.name = 'StreamThinkingTruncatedException';
  }
}

/** 上游在流已开始（HTTP 200 已发出）后失败，错误只能内嵌在 SSE 事件里下发。 */
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

export class ResponsesLlmAdapter implements LlmAdapter {
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
        return parseResponsesChatResponse(JSON.parse(json));
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

  private async processStreamBody(
    body: http.IncomingMessage,
    callback: StreamCallback,
    cancelFlag?: { get(): boolean } | null,
  ): Promise<void> {
    const usage: ChatUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let emitted = false;
    let done = false;
    let buffer = '';
    let finishReason: string | null = null;
    let responseIncomplete = false;
    let hasContentOutput = false;
    let hasToolCallOutput = false;
    let sawResponseCompleted = false;
    // fatal：截断的 UTF-8 必须报错，静默降级为 U+FFFD 会让被截断的流看起来正常完成
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let lastData = Date.now();
    const idleMs = this.retry.streamIdleTimeoutSeconds * 1000;

    let idleTimedOut: Error | null = null;

    // Responses 的 arguments.delta/output_item.done 只带 item_id（fc_*），而 Mao 与回传 function_call_output
    // 统一用 call_id（call_*）作为聚合键。此映射在 added/done 事件里登记 item_id → call_id。
    const callKeyByItemId = new Map<string, string>();
    // 已收到过 arguments.delta 的聚合键：这类 item 的完整参数已通过增量累积，done 事件不再重复下发
    const keysWithArgsDelta = new Set<string>();
    // 本轮 reasoning 项的往返引用（流式捕获）：挂到轮内首个 toolCall 随 tool_calls JSON 持久化，
    // 下一轮 convertMessages 回传为配对的 reasoning 项（强制校验网关缺它即 400）
    let streamingReasoningRef: ReasoningItemRef | null = null;
    let firstToolCallEmitted = false;
    const rememberCallKeyMapping = (itemId: string | undefined, callKey: string): void => {
      if (itemId != null && itemId !== '' && itemId !== callKey) callKeyByItemId.set(itemId, callKey);
    };
    const resolveCallKey = (itemIdOrCallId: string | undefined, outputIndex: number | undefined): string => {
      if (itemIdOrCallId != null && itemIdOrCallId !== '') {
        const mapped = callKeyByItemId.get(itemIdOrCallId);
        if (mapped != null) return mapped;
        return itemIdOrCallId;
      }
      return `__idx_${outputIndex ?? 0}`;
    };

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

    const handleEvent = (event: ResponsesStreamEvent): void => {
      switch (event.type) {
        case 'response.output_text.delta': {
          hasContentOutput = true;
          emitted = true;
          emitChunk(callback, event.item_id, { content: event.delta ?? '' });
          return;
        }
        case 'response.reasoning_summary_text.delta': {
          emitted = true;
          emitChunk(callback, event.item_id, { reasoningContent: event.delta ?? '' });
          return;
        }
        case 'response.output_item.added': {
          const item = event.item;
          // reasoning item（含加密内容引用）：流式捕获，待首个 function_call 出现时挂靠下发
          if (isPlainObject(item) && item.type === 'reasoning') {
            const ref: ReasoningItemRef = {};
            const id = str(item.id);
            const enc = str(item.encrypted_content);
            if (id != null && id !== '') ref.id = id;
            if (enc != null && enc !== '') ref.encryptedContent = enc;
            if (ref.id != null || ref.encryptedContent != null) streamingReasoningRef = ref;
            return;
          }
          if (isPlainObject(item) && item.type === 'function_call') {
            hasToolCallOutput = true;
            emitted = true;
            // 以 call_id 作为增量聚合键（与回传 function_call_output 的 call_id 一致）；
            // 网关未下发 call_id 时退回 item.id / output_index 兜底
            const syntheticId = str(item.call_id) ?? str(item.id) ?? `__idx_${event.output_index ?? 0}`;
            rememberCallKeyMapping(str(item.id), syntheticId);
            emitChunk(callback, syntheticId, {
              toolCalls: [{
                id: syntheticId,
                index: event.output_index ?? 0,
                ...(streamingReasoningRef != null && !firstToolCallEmitted ? { reasoning: streamingReasoningRef } : {}),
                function: { name: item.name as string | undefined, arguments: '' },
              }],
            });
            firstToolCallEmitted = true;
          }
          return;
        }
        case 'response.function_call_arguments.delta': {
          // arguments.delta 只带 item_id，需映射回聚合键（added 事件里的 item.id → call_id）
          const syntheticId = resolveCallKey(event.item_id, event.output_index);
          keysWithArgsDelta.add(syntheticId);
          emitted = true;
          emitChunk(callback, syntheticId, {
            toolCalls: [{ id: syntheticId, index: event.output_index ?? 0, function: { arguments: event.delta ?? '' } }],
          });
          return;
        }
        case 'response.output_item.done': {
          // 兼容不发 arguments.delta 事件的网关：done item 携带完整参数时在此下发。
          // 已通过 arguments.delta 增量下发过的 item 跳过（完整值再发会被 AgentLoop 拼接两遍）。
          const item = event.item;
          if (isPlainObject(item) && item.type === 'reasoning') {
            // reasoning done 携带 include 换取的 encrypted_content：原地补全已挂靠的引用
            //（AgentLoop 通过首个 function_call delta 持有同一对象）；未挂靠且尚未有工具调用时兜底捕获
            const enc = str(item.encrypted_content);
            const id = str(item.id);
            if (streamingReasoningRef != null) {
              if (enc != null && enc !== '' && streamingReasoningRef.encryptedContent == null) {
                streamingReasoningRef.encryptedContent = enc;
              }
              if ((streamingReasoningRef.id == null || streamingReasoningRef.id === '') && id != null && id !== '') {
                streamingReasoningRef.id = id;
              }
            } else if (!firstToolCallEmitted && ((id != null && id !== '') || (enc != null && enc !== ''))) {
              streamingReasoningRef = { ...(id != null && id !== '' ? { id } : {}), ...(enc != null && enc !== '' ? { encryptedContent: enc } : {}) };
            }
            return;
          }
          if (isPlainObject(item) && item.type === 'function_call') {
            const syntheticId = resolveCallKey(str(item.call_id) ?? str(item.id), event.output_index);
            rememberCallKeyMapping(str(item.id), syntheticId);
            if (!keysWithArgsDelta.has(syntheticId) && typeof item.arguments === 'string' && item.arguments !== '') {
              emitted = true;
              emitChunk(callback, syntheticId, {
                toolCalls: [{
                  id: syntheticId,
                  index: event.output_index ?? 0,
                  function: {
                    name: item.name as string | undefined,
                    arguments: item.arguments,
                  },
                }],
              });
            }
          }
          return;
        }
        case 'response.failed': {
          const response = event.response;
          const err = isPlainObject(response) && isPlainObject(response.error) ? response.error : {};
          const code = toNumber(err.code);
          throw new StreamErrorEventException(code, str(err.message) ?? 'response.failed');
        }
        case 'error': {
          const err = event;
          const code = toNumber((err as Record<string, unknown>).code);
          throw new StreamErrorEventException(code, str((err as Record<string, unknown>).message) ?? 'stream error event');
        }
        case 'response.incomplete': {
          // 终态事件：响应未正常完成（如输出长度截断）；usage 与 completed 同样提取，保证截断轮用量统计不失真
          responseIncomplete = true;
          const response = event.response;
          if (isPlainObject(response)) {
            const u = parseResponsesUsage(response.usage);
            if (u != null) usageObjAssign(usage, u);
            if (isPlainObject(response.incomplete_details)) {
              if (response.incomplete_details.reason === 'max_output_tokens') finishReason = 'length';
            }
          }
          done = true;
          return;
        }
        case 'response.completed': {
          sawResponseCompleted = true;
          const response = event.response;
          if (isPlainObject(response)) {
            const u = parseResponsesUsage(response.usage);
            if (u != null) usageObjAssign(usage, u);
            finishReason = mapResponsesStatusToFinishReason(str(response.status), responseIncomplete);
          }
          return;
        }
        default:
          return;
      }
    };

    /** 处理一整行 SSE；返回 true 表示流正常终止。 */
    const handleLine = (line: string): boolean => {
      if (!line.startsWith('data: ')) return false;
      lastData = Date.now();
      const data = line.slice(6).trim();
      if (data === '[DONE]') return true;
      try {
        const parsed = JSON.parse(data) as unknown;
        if (!isPlainObject(parsed)) return false;
        const event = parsed as ResponsesStreamEvent;
        handleEvent(event);
        // response.completed / response.incomplete 均为终态事件，读到位即正常收流
        if (event.type === 'response.completed' || event.type === 'response.incomplete') return true;
      } catch (e) {
        if (e instanceof StreamErrorEventException) throw e;
        harnessLog('warn', `Failed to parse SSE event: ${data}`, e);
      }
      return false;
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
          if (handleLine(line)) {
            done = true;
            break;
          }
        }
        if (done) break;
      }
      buffer += decoder.decode();
      // 上游可能不以换行结尾，残留在 buffer 里的最后一行同样是有效事件
      if (!done && buffer.trim() !== '') {
        if (handleLine(buffer)) done = true;
        buffer = '';
      }
      if (idleTimedOut) throw idleTimedOut;
      // Responses SSE 不发 [DONE]，response.completed/incomplete/error/failed 即终态；缺失视为流被截断
      if (!done && !sawResponseCompleted && !responseIncomplete) {
        const eof = Object.assign(new Error('stream ended before response.completed'), { name: 'EOFException' });
        if (emitted) throw new StreamInterruptedAfterOutputException(eof);
        throw eof;
      }
      // 推理模型思考被输出上限截断：只有思考没有正式回答，丢弃该轮并按可重试异常处理
      if (finishReason === 'length' && !hasContentOutput && !hasToolCallOutput) {
        throw new StreamThinkingTruncatedException();
      }
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
      const url = new URL((config.baseUrl ?? '').replace(/\/$/, '') + '/responses');
      const lib = url.protocol === 'https:' ? https : http;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.apiKey ?? ''}`,
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

  /** ChatRequest（OpenAI Chat 形状）→ Responses API 请求体。 */
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
    const body = buildResponsesBody(request, config, messages ?? [], stream);
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
          || msg.includes('stream ended before response.completed')
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
        if (cause.name === 'EOFException' || cause.message.includes('stream ended before response.completed')) return 'unexpected_eof';
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
// 请求体构建：ChatRequest（OpenAI Chat 形状）→ Responses API
// ---------------------------------------------------------------------------

function buildResponsesBody(request: ChatRequest, config: LlmModelConfig, messages: ChatMessage[], stream: boolean): Record<string, unknown> {
  const { instructions, input } = convertMessages(messages);
  const body: Record<string, unknown> = {
    model: config.modelId ?? '',
    input,
    store: false,
    stream,
  };
  if (instructions != null) body.instructions = instructions;
  if (request.temperature != null) body.temperature = request.temperature;
  // 会话粘性缓存路由：无 key 时网关多上游负载均衡，前缀缓存命中随机（实测确认）
  if (request.promptCacheKey != null && request.promptCacheKey !== '') {
    body.prompt_cache_key = request.promptCacheKey;
  }
  if (request.tools != null && request.tools.length > 0) {
    body.tools = request.tools.map((t) => ({
      type: 'function',
      name: t.function?.name,
      description: t.function?.description,
      parameters: t.function?.parameters,
    }));
  }
  // reasoning effort：PromptEngine 已对 gpt-* 模型下发 {effort:'high'}；Responses 网关同样按 gpt-* 前缀判断
  if (request.reasoning != null) {
    body.reasoning = { effort: request.reasoning.effort ?? 'high' };
  }
  // stateless 多轮的 reasoning 上下文往返：function_call 回传时需配对 reasoning 项，且网关只在
  // include:['reasoning.encrypted_content'] 生效时下发密文。include 常驻：若按"历史已有引用"条件下发，
  // 首轮工具调用流式期间引用尚未入历史、include 为空 → 拿不到密文 → 下轮无引用可回传，形成死锁。
  // 代价仅是请求体多一个空 include 项（纯文本轮网关不下发 reasoning 时无额外输出）。
  body.include = ['reasoning.encrypted_content'];
  // 输出上限含 reasoning token，推理模型需预留思考预算，统一给足
  body.max_output_tokens = RESPONSES_MAX_OUTPUT_TOKENS;
  return body;
}

/**
 * ChatMessage 序列 → Responses input items。
 * 关键规则（stateless 多轮，store:false）：
 * - 历史 assistant 的 reasoning 引用（toolCalls[0].reasoning）回传为 {type:'reasoning', id, encrypted_content, summary:[]}；
 *   网关要求 reasoning 项后必须紧跟 assistant 消息或 function_call，故 reasoning 项插入本轮 assistant 内容之前；
 * - 历史 assistant 消息转为 message 项（role:'assistant'），其 toolCalls 平铺为后续 function_call 项；
 * - tool 消息 → function_call_output（同轮多个 tool 结果全部输出后再进入下一轮）；
 * - 网关要求「function_call 项与其 function_call_output 项之间不得插入其他输出类型」，
 *   因此先平铺全部 function_call，再统一输出全部 function_call_output（并行多工具场景）；
 * - 中途 system（防御）降级为 user 文本。
 */
export function convertMessages(messages: ChatMessage[]): { instructions: string | null; input: Record<string, unknown>[] } {  const instructionsParts: string[] = [];
  const input: Record<string, unknown>[] = [];
  // 连续 tool 消息缓冲：统一在缓冲结束时输出 function_call_output
  let toolBuffer: Array<{ callId: string; content: string }> = [];

  const flushToolBuffer = (): void => {
    if (toolBuffer.length === 0) return;
    for (const t of toolBuffer) {
      input.push({ type: 'function_call_output', call_id: t.callId, output: t.content });
    }
    toolBuffer = [];
  };

  for (const msg of messages) {
    const role = msg.role ?? 'user';
    if (role === 'system') {
      const text = extractMessageText(msg.content);
      if (text === '') continue;
      if (input.length === 0) {
        instructionsParts.push(text);
      } else {
        // 非 instructions 位置的 system：先冲刷工具缓冲，降级为 user 文本
        flushToolBuffer();
        input.push({ role: 'user', content: [{ type: 'input_text', text }] });
      }
      continue;
    }
    if (role === 'tool') {
      if (msg.toolCallId == null || msg.toolCallId === '') {
        // 无配对 call_id 的 tool 消息无法映射为 function_call_output，降级为 user 文本，避免静默丢失结果
        const text = extractMessageText(msg.content);
        if (text !== '') {
          flushToolBuffer();
          input.push({ role: 'user', content: [{ type: 'input_text', text: `工具结果（无 call_id）：${text}` }] });
        }
        continue;
      }
      toolBuffer.push({ callId: msg.toolCallId, content: extractMessageText(msg.content) });
      continue;
    }
    if (role === 'assistant') {
      const reasoningRef = extractReasoningRef(msg);
      const text = extractMessageText(msg.content);
      const toolCalls = msg.toolCalls ?? [];
      const callsToEmit = toolCalls.filter((tc) => tc.function?.name != null);
      flushToolBuffer();
      // 本轮输出序列：[reasoning 引用] + [assistant 文本] + [function_call...]
      // 网关要求 reasoning 项后必须紧跟 assistant 消息或 function_call；
      // 纯 reasoning 轮（无文本无 function_call）补一条空格 assistant 消息满足该约束。
      if (reasoningRef != null) {
        input.push(reasoningItem(reasoningRef));
      }
      if (text !== '' || (reasoningRef != null && callsToEmit.length === 0)) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text: text !== '' ? text : ' ' }] });
      }
      for (const tc of callsToEmit) {
        input.push(functionCallItem(tc));
      }
      continue;
    }
    // user 消息
    if (toolBuffer.length > 0) {
      // tool 后紧跟 user：先冲刷 function_call_output（顺序保证）
      flushToolBuffer();
    }
    const blocks: Record<string, unknown>[] = [];
    for (const part of imageParts(msg.content)) {
      const block = toResponsesImageBlock(part);
      if (block != null) blocks.push(block);
    }
    const text = extractMessageText(msg.content);
    if (text !== '' || blocks.length === 0) {
      blocks.push({ type: 'input_text', text });
    }
    input.push({ role: 'user', content: blocks });
  }
  if (toolBuffer.length > 0) {
    flushToolBuffer();
  }
  return {
    instructions: instructionsParts.length > 0 ? instructionsParts.join('\n\n') : null,
    input,
  };
}

function reasoningItem(ref: ReasoningItemRef): Record<string, unknown> {
  return {
    type: 'reasoning',
    ...(ref.id != null && ref.id !== '' ? { id: ref.id } : {}),
    ...(ref.encryptedContent != null && ref.encryptedContent !== '' ? { encrypted_content: ref.encryptedContent } : {}),
    summary: [],
  };
}

function functionCallItem(tc: ToolCall): Record<string, unknown> {
  // 不回传 id（响应侧 item id，fc_* 格式）：持久化的 tc.id 是 call_id（call_*），
  // 填进 id 属格式错配；配对只依赖 call_id，官方 API 中 id 为可选字段
  return {
    type: 'function_call',
    call_id: tc.id ?? '',
    name: tc.function?.name ?? '',
    arguments: tc.function?.arguments ?? '{}',
  };
}

function extractReasoningRef(msg: ChatMessage): ReasoningItemRef | null {
  const fromToolCalls = msg.toolCalls?.find((tc) => tc.reasoning != null)?.reasoning ?? null;
  if (fromToolCalls != null) return fromToolCalls;
  if (msg.reasoningContent != null && msg.reasoningContent.startsWith(REASONING_REF_PREFIX)) {
    try {
      const parsed = JSON.parse(msg.reasoningContent.slice(REASONING_REF_PREFIX.length)) as unknown;
      if (isPlainObject(parsed) && (typeof parsed.id === 'string' || typeof parsed.encryptedContent === 'string')) {
        return { id: str(parsed.id), encryptedContent: str(parsed.encryptedContent) };
      }
    } catch {
      // 损坏的 JSON 引用按缺失处理，function_call 回传时网关可能 400（可接受的降级）
    }
 }
  return null;
}

/** reasoning 往返引用的持久化前缀：thinkingContent 里以它开头的内容是 JSON 引用而非人类可读文本。 */
export const REASONING_REF_PREFIX = '__mao_responses_reasoning__:';

// ---------------------------------------------------------------------------
// 响应解析：Responses API → ChatResponse（OpenAI 形状）
// ---------------------------------------------------------------------------

/** Responses 响应 → 统一 ChatResponse（OpenAI 形状）。 */
export function parseResponsesChatResponse(raw: unknown): ChatResponse {
  const o = isPlainObject(raw) ? raw : {};
  const output = Array.isArray(o.output) ? o.output : [];
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  let reasoningRef: ReasoningItemRef | null = null;
  let toolIndex = 0;
  for (const item of output) {
    if (!isPlainObject(item)) continue;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (isPlainObject(part) && part.type === 'output_text' && typeof part.text === 'string') {
          textParts.push(part.text);
        }
      }
    } else if (item.type === 'reasoning') {
      const ref: ReasoningItemRef = {};
      if (typeof item.id === 'string' && item.id !== '') ref.id = item.id;
      if (typeof item.encrypted_content === 'string' && item.encrypted_content !== '') {
        ref.encryptedContent = item.encrypted_content;
      }
      if (ref.id != null || ref.encryptedContent != null) reasoningRef = ref;
    } else if (item.type === 'function_call') {
      toolCalls.push({
        index: toolIndex++,
        id: typeof item.call_id === 'string' && item.call_id !== '' ? item.call_id : (typeof item.id === 'string' ? item.id : undefined),
        type: 'function',
        function: {
          name: typeof item.name === 'string' ? item.name : undefined,
          arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
        },
      });
    }
  }
  if (reasoningRef != null && toolCalls.length > 0) {
    toolCalls[0].reasoning = reasoningRef;
  }
  const status = typeof o.status === 'string' ? o.status : undefined;
  const incomplete = isPlainObject(o.incomplete_details) ? o.incomplete_details : {};
  const finishReason = mapResponsesStatusToFinishReason(
    status,
    incomplete.reason === 'max_output_tokens',
  );
  return {
    id: typeof o.id === 'string' ? o.id : undefined,
    model: typeof o.model === 'string' ? o.model : undefined,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: textParts.join(''),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      },
      finishReason,
    }],
    usage: parseResponsesUsage(o.usage) ?? undefined,
  };
}

export function mapResponsesStatusToFinishReason(status: string | undefined, maxOutputTokens: boolean): string {
  if (maxOutputTokens) return 'length';
  if (status === 'incomplete') return 'length';
  return 'stop';
}

/** Responses usage → 统一 ChatUsage。input_tokens_details.cached_tokens → cachedTokens。 */
function parseResponsesUsage(raw: unknown): ChatUsage | null {
  if (!isPlainObject(raw)) return null;
  const promptTokens = toNumber(raw.input_tokens) ?? 0;
  const completionTokens = toNumber(raw.output_tokens) ?? 0;
  const usage: ChatUsage = {
    promptTokens,
    completionTokens,
    totalTokens: toNumber(raw.total_tokens) ?? (promptTokens + completionTokens),
  };
  const details = raw.input_tokens_details;
  if (isPlainObject(details) && details.cached_tokens != null) {
    const cached = toNumber(details.cached_tokens);
    if (cached != null) usage.promptTokensDetails = { cachedTokens: cached };
  }
  return usage;
}

// ---------------------------------------------------------------------------
// 流式事件 → StreamChunk 适配
// ---------------------------------------------------------------------------

function emitChunk(
  callback: StreamCallback,
  itemId: string | undefined,
  delta: { content?: string; reasoningContent?: string; toolCalls?: ToolCall[] },
): void {
  const chunk: StreamChunk = {
    id: itemId,
    choices: [{
      index: 0,
      delta,
    }],
  };
  callback.onChunk(chunk);
}

interface ResponsesStreamEvent extends Record<string, unknown> {
  type?: string;
  item_id?: string;
  output_index?: number;
  delta?: string;
  item?: unknown;
  response?: unknown;
}

// ---------------------------------------------------------------------------
// 图片预处理与消息文本提取（与 AnthropicLlmAdapter 相同逻辑的本地副本）
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

function imageParts(content: unknown): ContentPart[] {
  if (!Array.isArray(content)) return [];
  return content.filter((p): p is ContentPart => isPlainObject(p) && p.type === 'image_url');
}

/** OpenAI Chat 形状 image_url part → Responses input_image block（仅 data URL）。 */
function toResponsesImageBlock(part: ContentPart): Record<string, unknown> | null {
  const url = extractImageUrl(part);
  if (url == null || url.trim() === '') return null;
  return { type: 'input_image', image_url: url };
}

function extractMessageText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let out = '';
    for (const item of content) {
      if (isPlainObject(item)) {
        const t = item.text;
        if (typeof t === 'string') out += t;
      }
    }
    return out;
  }
  return String(content);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function usageObjAssign(target: ChatUsage, u: ChatUsage): void {
  target.promptTokens = u.promptTokens;
  target.completionTokens = u.completionTokens;
  target.totalTokens = u.totalTokens;
  target.promptTokensDetails = u.promptTokensDetails;
}
