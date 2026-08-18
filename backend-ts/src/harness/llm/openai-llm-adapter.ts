import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
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
  StreamChunk,
} from './chat-request.js';
import { DEFAULT_LLM_RETRY } from './chat-request.js';
import { parseChatResponse, parseStreamChunk, parseUsageFromSse, serializeChatRequest } from './json.js';

const IMAGE_PLACEHOLDER = '「此处用户上传了图片」';

class StreamInterruptedAfterOutputException extends Error {
  constructor(cause?: unknown) {
    super('LLM stream interrupted after output started; automatic retry disabled');
    this.name = 'StreamInterruptedAfterOutputException';
    this.cause = cause;
  }
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: http.IncomingMessage;
  started: number;
  req: http.ClientRequest;
}

export class OpenAiLlmAdapter implements LlmAdapter {
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
        return parseChatResponse(JSON.parse(json));
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
        const interruptedAfterOutput = e instanceof StreamInterruptedAfterOutputException;
        if (!this.isRetryableNetworkFailure(e) || attempt > this.retry.rateLimitMaxRetries) {
          callback.onError(interruptedAfterOutput
            ? new Error('模型流式响应已中断，自动重试已耗尽', { cause: e })
            : e);
          return;
        }
        if (interruptedAfterOutput) {
          callback.onStreamReset?.();
        }
        const delaySeconds = this.resolveRetryDelaySeconds(null, attempt);
        if (!(await this.notifyAndWaitForRetry(callback, cancelFlag, config.modelId, this.networkReason(e), null, attempt, delaySeconds, attemptStarted, totalStarted))) {
          callback.onError(this.cancelledException());
          return;
        }
      }
    }
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

    /** 处理一整行 SSE；返回 true 表示读到了 [DONE]。 */
    const handleLine = (line: string): boolean => {
      if (!line.startsWith('data: ')) return false;
      lastData = Date.now();
      const data = line.slice(6).trim();
      if (data === '[DONE]') return true;
      try {
        const parsed = JSON.parse(data) as unknown;
        const streamChunk = parseStreamChunk(parsed);
        callback.onChunk(streamChunk);
        if (hasAccumulatedOutput(streamChunk)) emitted = true;
        const u = parseUsageFromSse(parsed);
        if (u) {
          usage.promptTokens = u.promptTokens;
          usage.completionTokens = u.completionTokens;
          usage.totalTokens = u.totalTokens;
          usage.promptTokensDetails = u.promptTokensDetails;
        }
      } catch (e) {
        harnessLog('warn', `Failed to parse SSE chunk: ${data}`, e);
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
      if (!done) {
        const eof = Object.assign(new Error('stream ended before [DONE]'), { name: 'EOFException' });
        if (emitted) throw new StreamInterruptedAfterOutputException(eof);
        throw eof;
      }
      callback.onComplete(usage);
    } catch (e) {
      if (idleTimedOut) throw idleTimedOut;
      if (e instanceof StreamInterruptedAfterOutputException) throw e;
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
      const url = new URL((config.baseUrl ?? '').replace(/\/$/, '') + '/chat/completions');
      const lib = url.protocol === 'https:' ? https : http;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.apiKey ?? ''}`,
        'Content-Type': 'application/json',
      };
      if (config.modelId?.toLowerCase().startsWith('gpt')) {
        headers['User-Agent'] = 'codex_cli_rs/0.146.0 (Linux 6.1.0; x86_64) xterm-256color';
        headers.originator = 'codex_cli_rs';
        headers['x-codex-window-id'] = '019e9e6a-e81e-7442-bac0-d3bc42cc1b45';
      }
      if (config.modelId?.toLowerCase().includes('claude')) {
        headers['User-Agent'] = 'claude-cli/999.0.0-restored (external, cli)';
        headers['x-app'] = 'cli';
        headers['X-Claude-Code-Session-Id'] = randomUUID();
        headers['x-client-request-id'] = randomUUID();
      }
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

  private async buildRequestBody(request: ChatRequest, config: LlmModelConfig, stream: boolean): Promise<string> {
    const messages = request.messages != null ? [...request.messages] : null;
    ensureContentPresent(messages);
    const supportsVision = config.supportsVision === true;
    if (!supportsVision && messages) {
      this.replaceImagesWithPlaceholder(messages);
    }
    if (messages) {
      for (const msg of messages) {
        await this.convertImageUrlsToBase64(msg);
      }
    }
    const body = serializeChatRequest({ ...request, messages: messages ?? undefined }, config.modelId ?? '', stream);
    return JSON.stringify(body);
  }

  private replaceImagesWithPlaceholder(messages: ChatMessage[]): void {
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

  private async convertImageUrlsToBase64(msg: ChatMessage): Promise<void> {
    if (!Array.isArray(msg.content)) return;
    for (const part of msg.content) {
      const url = extractImageUrl(part);
      if (!url || url.trim() === '') continue;
      try {
        let base64Uri: string | undefined;
        if (url.startsWith('data:')) {
          base64Uri = await this.resizeDataUri(url);
        } else {
          base64Uri = await this.downloadAndEncode(url);
        }
        if (base64Uri) setImageUrl(part, base64Uri);
      } catch (e) {
        harnessLog('warn', `Failed to prepare image for prompt, keeping original URL: ${url.startsWith('data:') ? 'data-uri' : url}`, e);
      }
    }
  }

  private async resizeDataUri(dataUri: string): Promise<string> {
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

  private async downloadAndEncode(imageUrl: string): Promise<string> {
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
        if (name === 'TimeoutException' || name === 'TimeoutError' || name === 'EOFException'
          || name === 'ConnectException' || name === 'InterruptedIOException'
          || (cause as NodeJS.ErrnoException).code === 'ETIMEDOUT'
          || (cause as NodeJS.ErrnoException).code === 'ECONNRESET'
          || (cause as NodeJS.ErrnoException).code === 'ECONNREFUSED'
          || (cause as NodeJS.ErrnoException).code === 'http_call_timeout'
          || cause instanceof StreamInterruptedAfterOutputException
          || msg.includes('stream ended before [DONE]')
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
        if (cause.name === 'EOFException' || cause.message.includes('stream ended before [DONE]')) return 'unexpected_eof';
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

function hasAccumulatedOutput(chunk: StreamChunk): boolean {
  if (!chunk.choices) return false;
  for (const choice of chunk.choices) {
    const delta = choice.delta;
    if (!delta) continue;
    if (delta.content) return true;
    if (delta.reasoningContent) return true;
    if (delta.toolCalls && delta.toolCalls.length > 0) return true;
  }
  return false;
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
