import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAiLlmAdapter } from './openai-llm-adapter.js';
import type { ChatRequest, ChatUsage, LlmModelConfig, LlmRetryConfig, StreamCallback, StreamChunk } from './chat-request.js';
import { DEFAULT_LLM_RETRY } from './chat-request.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);

class QueueServer {
  requestCount = 0;
  bodies: string[] = [];
  paths: string[] = [];
  headers: http.IncomingHttpHeaders[] = [];
  private queue: Array<(req: http.IncomingMessage, res: http.ServerResponse, body: string) => void> = [];
  private server!: http.Server;

  enqueue(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): void {
    this.queue.push(handler);
  }

  enqueueJson(body: string, status = 200, extraHeaders?: Record<string, string>): void {
    this.enqueue((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
      res.end(body);
    });
  }

  enqueueSse(body: string, status = 200): void {
    this.enqueue((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'text/event-stream' });
      res.end(body);
    });
  }

  enqueueChunkedSse(chunks: Buffer[]): void {
    this.enqueue((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      const writeNext = (index: number) => {
        if (index >= chunks.length) {
          res.end();
          return;
        }
        res.write(chunks[index]);
        setTimeout(() => writeNext(index + 1), 10);
      };
      writeNext(0);
    });
  }

  enqueueBytes(bytes: Buffer, contentType: string, status = 200): void {
    this.enqueue((_req, res) => {
      res.writeHead(status, { 'Content-Type': contentType });
      res.end(bytes);
    });
  }

  enqueueHang(): void {
    this.enqueue(() => { /* never respond */ });
  }

  enqueueDelayedJson(body: string, delayMs: number): void {
    this.enqueue((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.flushHeaders();
      setTimeout(() => res.end(body), delayMs);
    });
  }

  enqueueDelayedHeadersJson(body: string, delayMs: number): void {
    this.enqueue((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
      }, delayMs);
    });
  }

  enqueueDelayedSse(body: string, delayMs: number): void {
    this.enqueue((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      setTimeout(() => res.end(body), delayMs);
    });
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.requestCount++;
      this.paths.push(req.url ?? '');
      this.headers.push(req.headers);
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        this.bodies.push(body);
        const handler = this.queue.shift();
        if (handler) handler(req, res, body);
        else {
          res.writeHead(500);
          res.end('no queued response');
        }
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
  }

  url(): string {
    const addr = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

class CapturingCallback implements StreamCallback {
  chunks: StreamChunk[] = [];
  waitingPhases: string[] = [];
  retryReasons: string[] = [];
  retryStatuses: number[] = [];
  usage?: ChatUsage;
  error?: unknown;
  streamResetCount = 0;

  onChunk(chunk: StreamChunk): void { this.chunks.push(chunk); }
  onStreamReset(): void { this.streamResetCount++; this.chunks = []; }
  onComplete(usage: ChatUsage): void { this.usage = usage; }
  onError(t: unknown): void { this.error = t; }
  onWaiting(phase: string): void { this.waitingPhases.push(phase); }
  onRetry(reason: string, statusCode: number | null): void {
    this.retryReasons.push(reason);
    if (statusCode != null) this.retryStatuses.push(statusCode);
  }
}

function adapter(
  maxRetries: number, retryDelaySeconds: number,
  responseHeaderTimeoutSeconds = 120, streamIdleTimeoutSeconds = 120, httpCallTimeoutSeconds = 180,
): OpenAiLlmAdapter {
  const retry: LlmRetryConfig = {
    ...DEFAULT_LLM_RETRY,
    rateLimitMaxRetries: maxRetries,
    rateLimitRetryDelaySeconds: retryDelaySeconds,
    callTimeoutSeconds: responseHeaderTimeoutSeconds,
    streamIdleTimeoutSeconds,
    httpCallTimeoutSeconds,
  };
  return new OpenAiLlmAdapter(retry);
}

function request(content: string): ChatRequest {
  return {
    temperature: 0.2,
    messages: [{ role: 'user', content }],
    tools: [{ type: 'function', function: { name: 'lookup', description: 'lookup', parameters: {} } }],
  };
}

function configOf(server: QueueServer, extra?: Partial<LlmModelConfig>): LlmModelConfig {
  return { baseUrl: server.url(), apiKey: 'key', modelId: 'gpt-test', ...extra };
}

describe('OpenAiLlmAdapter', () => {
  let server: QueueServer;

  afterEach(async () => {
    await server?.close();
  });

  it('chatIncludesEmptyContentForAssistantToolOnlyMessages', async () => {
    server = new QueueServer();
    server.enqueueJson('{"id":"ok","choices":[]}');
    await server.start();
    await adapter(0, 0).chat({
      messages: [{
        role: 'assistant',
        toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      }],
    }, configOf(server));
    expect(server.bodies[0]).toContain('"content":""');
  });

  it('chatPostsOpenAiRequestAndParsesResponse', async () => {
    server = new QueueServer();
    server.enqueueJson('{"id":"chat-1","model":"gpt-test","choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}');
    await server.start();
    const response = await adapter(0, 0).chat(request('hello'), configOf(server));
    expect(response.id).toBe('chat-1');
    expect(response.usage?.totalTokens).toBe(3);
    expect(server.paths[0]).toBe('/chat/completions');
    expect(server.headers[0].authorization).toBe('Bearer key');
    expect(server.bodies[0]).toContain('"model":"gpt-test"');
    expect(server.bodies[0]).toContain('"stream":false');
    expect(server.bodies[0]).toContain('"temperature":0.2');
  });

  it('chatParsesNullableCachedTokensAndSendsNoOutputLimit', async () => {
    server = new QueueServer();
    server.enqueueJson('{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"prompt_tokens_details":{"cached_tokens":0}}}');
    server.enqueueJson('{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}');
    await server.start();
    const a = adapter(0, 0);
    const zero = await a.chat(request('zero'), configOf(server));
    const missing = await a.chat(request('missing'), configOf(server));
    expect(zero.usage?.promptTokensDetails?.cachedTokens).toBe(0);
    expect(missing.usage?.promptTokensDetails).toBeUndefined();
    expect(server.bodies[0]).not.toContain('max_tokens');
    expect(server.bodies[0]).not.toContain('max_completion_tokens');
  });

  it('cancellableChatStopsWaitingForResponse', async () => {
    server = new QueueServer();
    server.enqueueHang();
    await server.start();
    const cancelled = { v: false, get: () => cancelled.v };
    setTimeout(() => { cancelled.v = true; }, 200);
    await expect(adapter(0, 0).chat(request('cancel'), configOf(server), cancelled)).rejects.toThrow(/Cancelled by user/);
  }, 10_000);

  it('chatIncludesReasoningWhenPresentOnRequest', async () => {
    server = new QueueServer();
    server.enqueueJson('{"id":"ok","choices":[]}');
    await server.start();
    await adapter(0, 0).chat({
      messages: [{ role: 'user', content: 'hello' }],
      reasoning: { effort: 'high' },
    }, configOf(server));
    expect(server.bodies[0]).toContain('"reasoning":{"effort":"high"}');
  });

  it('chatParsesOpenRouterReasoningFields', async () => {
    server = new QueueServer();
    server.enqueueJson('{"id":"gen-1","model":"stealth/ox-alpha","choices":[{"index":0,"message":{"role":"assistant","content":"答案","reasoning":"思考过程","reasoning_details":[{"type":"reasoning.text","text":"思考过程","format":"unknown","index":0}]},"finish_reason":"stop"}]}');
    await server.start();
    const response = await adapter(0, 0).chat(request('hello'), configOf(server));
    expect(response.choices?.[0]?.message?.reasoningContent).toBe('思考过程');
    expect(response.choices?.[0]?.message?.content).toBe('答案');
  });

  it('chatParsesDeepSeekReasoningContentField', async () => {
    server = new QueueServer();
    server.enqueueJson('{"id":"gen-2","choices":[{"index":0,"message":{"role":"assistant","content":"答案","reasoning_content":"思考过程"},"finish_reason":"stop"}]}');
    await server.start();
    const response = await adapter(0, 0).chat(request('hello'), configOf(server));
    expect(response.choices?.[0]?.message?.reasoningContent).toBe('思考过程');
  });

  it('chatIncludesThinkingDisableFieldsWhenPresentOnRequest', async () => {
    server = new QueueServer();
    server.enqueueJson('{"id":"ok","choices":[]}');
    await server.start();
    await adapter(0, 0).chat({
      messages: [{ role: 'user', content: 'hello' }],
      reasoning: { effort: 'none' },
      thinking: { type: 'disabled' },
      enableThinking: false,
    }, configOf(server));
    expect(server.bodies[0]).toContain('"thinking":{"type":"disabled"}');
    expect(server.bodies[0]).toContain('"enable_thinking":false');
  });

  it('chatRetries429And5xxAndThrowsAfterRetriesExhausted', async () => {
    server = new QueueServer();
    server.enqueueJson('slow down', 429, { 'Retry-After': 'bad' });
    server.enqueueJson('{"id":"ok","choices":[]}');
    server.enqueueJson('gateway timeout', 524);
    server.enqueueJson('{"id":"ok-5xx","choices":[]}');
    server.enqueueJson('unavailable', 503);
    server.enqueueJson('unavailable', 503);
    await server.start();
    const a = adapter(1, 0);
    expect((await a.chat(request('retry-429'), configOf(server))).id).toBe('ok');
    expect((await a.chat(request('retry-5xx'), configOf(server))).id).toBe('ok-5xx');
    await expect(a.chat(request('fail'), configOf(server))).rejects.toThrow(/LLM API returned 503/);
    expect(server.requestCount).toBe(6);
  });

  it('chatConvertsImageUrlsToBase64AndKeepsFailedDownloadsAsUrl', async () => {
    server = new QueueServer();
    server.enqueueBytes(PNG_MAGIC, 'image/png');
    server.enqueueJson('{"id":"ok","choices":[]}');
    server.enqueueJson('no image', 404);
    server.enqueueJson('{"id":"fallback","choices":[]}');
    await server.start();
    const imageUrl = `${server.url()}/image.png`;
    const imagePart = { type: 'image_url', imageUrl: { url: imageUrl } };
    const req: ChatRequest = { messages: [{ role: 'user', content: [imagePart] }] };
    expect((await adapter(0, 0).chat(req, configOf(server, { supportsVision: true }))).id).toBe('ok');
    expect(imagePart.imageUrl.url).toMatch(/^data:image\/png;base64,/);

    const imageMap: Record<string, unknown> = { type: 'image_url', image_url: { url: `${server.url()}/missing.png` } };
    const mapRequest: ChatRequest = { messages: [{ role: 'user', content: [imageMap] }] };
    expect((await adapter(0, 0).chat(mapRequest, configOf(server, { supportsVision: true }))).id).toBe('fallback');
    expect((imageMap.image_url as { url: string }).url).toContain('/missing.png');
  });

  it('chatCorrectsOctetStreamImageMimeFromMagicBytes', async () => {
    server = new QueueServer();
    server.enqueueBytes(JPEG_MAGIC, 'application/octet-stream');
    server.enqueueJson('{"id":"ok","choices":[]}');
    await server.start();
    const imageUrl = `${server.url()}/uploads/1784513683408_vsg_output_1784513632639`;
    const part = { type: 'image_url', imageUrl: { url: imageUrl } };
    await adapter(0, 0).chat(
      { messages: [{ role: 'user', content: [part] }] },
      configOf(server, { supportsVision: true }),
    );
    expect(part.imageUrl.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('streamParsesSseChunksUsageErrorsAndCancellation', async () => {
    server = new QueueServer();
    server.enqueueSse(
      'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n'
      + 'data: bad-json\n\n'
      + 'data: {"choices":[{"delta":{"content":"lo"}}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n'
      + 'data: [DONE]\n\n',
    );
    server.enqueueJson('bad', 500);
    await server.start();
    const callback = new CapturingCallback();
    await adapter(0, 0).stream(request('stream'), configOf(server), callback, { get: () => false });
    expect(callback.chunks).toHaveLength(2);
    expect(callback.usage?.totalTokens).toBe(7);
    expect(callback.error).toBeUndefined();

    const errorCallback = new CapturingCallback();
    await adapter(0, 0).stream(request('error'), configOf(server), errorCallback, { get: () => false });
    expect((errorCallback.error as Error).message).toContain('LLM API returned 500');

    server.enqueueJson('timeout', 524);
    server.enqueueSse('data: {"choices":[{"delta":{"content":"retried"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n');
    const retried = new CapturingCallback();
    await adapter(1, 0).stream(request('retry-stream'), configOf(server), retried, { get: () => false });
    expect(retried.error).toBeUndefined();
    expect(retried.chunks).toHaveLength(1);
    expect(retried.usage?.totalTokens).toBe(2);

    const cancelled = new CapturingCallback();
    await adapter(0, 0).stream(request('cancel'), configOf(server), cancelled, { get: () => true });
    expect((cancelled.error as Error).message).toContain('Cancelled by user');
  });

  it('streamDecodesUtf8CharactersSplitAcrossBufferChunks', async () => {
    server = new QueueServer();
    const sse = Buffer.from(
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n',
      'utf8',
    );
    const character = Buffer.from('好', 'utf8');
    const characterStart = sse.indexOf(character);
    expect(characterStart).toBeGreaterThanOrEqual(0);
    server.enqueueChunkedSse([
      sse.subarray(0, characterStart + 1),
      sse.subarray(characterStart + 1),
    ]);
    await server.start();

    const callback = new CapturingCallback();
    await adapter(0, 0).stream(request('utf8'), configOf(server), callback, { get: () => false });

    expect(callback.error).toBeUndefined();
    expect(callback.chunks[0]?.choices?.[0]?.delta?.content).toBe('你好');
    expect(callback.chunks[0]?.choices?.[0]?.delta?.content).not.toContain('\uFFFD');
  });

  it('streamParsesFinalLineWithoutTrailingNewline', async () => {
    server = new QueueServer();
    server.enqueueSse('data: {"choices":[{"delta":{"content":"hi"}}]}\ndata: [DONE]');
    await server.start();

    const callback = new CapturingCallback();
    await adapter(0, 0).stream(request('tail'), configOf(server), callback, { get: () => false });

    expect(callback.error).toBeUndefined();
    expect(callback.usage).toBeDefined();
    expect(callback.chunks[0]?.choices?.[0]?.delta?.content).toBe('hi');
  });

  it('streamParsesFinalDataLineWithoutTrailingNewline', async () => {
    server = new QueueServer();
    server.enqueueSse('data: [DONE]\ndata: {"choices":[{"delta":{"content":"tail"}}]}');
    await server.start();

    const callback = new CapturingCallback();
    await adapter(0, 0).stream(request('tail2'), configOf(server), callback, { get: () => false });

    // [DONE] 先到，剩余残行不应再被解析
    expect(callback.error).toBeUndefined();
    expect(callback.chunks).toHaveLength(0);
  });

  it('streamRejectsIncompleteUtf8AtEndOfBody', async () => {
    server = new QueueServer();
    const validSse = Buffer.from('data: [DONE]\n\n', 'utf8');
    server.enqueueChunkedSse([Buffer.concat([validSse, Buffer.from([0xe4])])]);
    await server.start();

    const callback = new CapturingCallback();
    await adapter(0, 0).stream(request('invalid-utf8'), configOf(server), callback, { get: () => false });

    expect(callback.usage).toBeUndefined();
    expect(callback.error).toBeInstanceOf(TypeError);
    expect((callback.error as Error).message).toMatch(/encoded data|UTF-8/i);
  });

  it('streamRetries404ThenSucceedsAndReportsStatus', async () => {
    server = new QueueServer();
    server.enqueueJson('model not ready', 404);
    server.enqueueSse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    await server.start();
    const callback = new CapturingCallback();
    await adapter(1, 0).stream(request('404'), configOf(server), callback, { get: () => false });
    expect(callback.error).toBeUndefined();
    expect(callback.retryReasons).toEqual(['http_status']);
    expect(callback.retryStatuses).toEqual([404]);
  });

  it('streamRetries504ThenSucceedsAndReportsStatus', async () => {
    server = new QueueServer();
    server.enqueueJson('gw', 504);
    server.enqueueSse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    await server.start();
    const callback = new CapturingCallback();
    await adapter(1, 0).stream(request('504'), configOf(server), callback, { get: () => false });
    expect(callback.error).toBeUndefined();
    expect(callback.retryReasons).toEqual(['http_status']);
    expect(callback.retryStatuses).toEqual([504]);
  });

  it('chatWaitsForDelayedResponseHeadersWithoutTreatingSocketInactivityAsConnectTimeout', async () => {
    server = new QueueServer();
    server.enqueueDelayedHeadersJson('{"id":"delayed","choices":[]}', 200);
    await server.start();
    const response = await adapter(0, 0, 2, 3, 3).chat(request('slow-reasoning'), configOf(server));
    expect(response.id).toBe('delayed');
    expect(server.requestCount).toBe(1);
  });

  it('chatKeepsHttpCallTimeoutAndReportsItsReason', async () => {
    server = new QueueServer();
    server.enqueueDelayedJson('{"id":"late","choices":[]}', 2000);
    await server.start();
    await expect(adapter(0, 0, 5, 3, 1).chat(request('slow-chat'), configOf(server)))
      .rejects.toThrow(/http_call_timeout|timeout/);
  }, 10_000);

  it('streamIsNotLimitedByNonStreamingHttpCallTimeout', async () => {
    server = new QueueServer();
    server.enqueueDelayedSse('data: {"choices":[{"delta":{"content":"late"}}]}\n\ndata: [DONE]\n\n', 2000);
    await server.start();
    const callback = new CapturingCallback();
    await adapter(0, 0, 5, 3, 1).stream(request('long-stream'), configOf(server), callback, { get: () => false });
    expect(callback.error).toBeUndefined();
    expect(callback.chunks).toHaveLength(1);
    expect(callback.retryReasons).toEqual([]);
  }, 10_000);

  it('streamRetriesWhenIdleTimeoutOccursBeforeAnyOutput', async () => {
    server = new QueueServer();
    server.enqueueDelayedSse('data: {"choices":[{"delta":{"content":"late"}}]}\n\n', 2000);
    server.enqueueSse('data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n');
    await server.start();
    const callback = new CapturingCallback();
    await adapter(1, 0, 5, 1).stream(request('idle'), configOf(server), callback, { get: () => false });
    expect(callback.error).toBeUndefined();
    expect(callback.retryReasons).toContain('stream_idle_timeout');
    expect(callback.chunks).toHaveLength(1);
  }, 10_000);

  it('streamRetriesWithoutResetAfterMetadataOnlyChunk', async () => {
    server = new QueueServer();
    server.enqueueSse('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
    server.enqueueSse('data: {"choices":[{"delta":{"content":"complete"}}]}\n\ndata: [DONE]\n\n');
    await server.start();
    const callback = new CapturingCallback();
    await adapter(1, 0, 5, 1).stream(request('metadata'), configOf(server), callback, { get: () => false });
    expect(callback.error).toBeUndefined();
    expect(callback.streamResetCount).toBe(0);
    expect(callback.retryReasons).toEqual(['unexpected_eof']);
    expect(server.requestCount).toBe(2);
  }, 10_000);

  it('streamRetriesThinkingTruncatedAndSucceedsWithFreshOutput', async () => {
    server = new QueueServer();
    // 第 1 次：只有 thinking（reasoning_content），finish_reason=length，思考被截断
    server.enqueueSse(
      'data: {"choices":[{"delta":{"reasoning_content":"let me think deeply about this very long analysis..."}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'
      + 'data: [DONE]\n\n',
    );
    // 第 2 次：正常输出 content
    server.enqueueSse('data: {"choices":[{"delta":{"content":"review complete"}}]}\n\ndata: [DONE]\n\n');
    await server.start();
    const callback = new CapturingCallback();
    await adapter(1, 0).stream(request('truncated-thinking'), configOf(server), callback, { get: () => false });
    expect(callback.error).toBeUndefined();
    expect(callback.retryReasons).toContain('thinking_truncated');
    expect(callback.streamResetCount).toBe(1);
    expect(callback.chunks).toHaveLength(1);
    expect(callback.chunks[0]?.choices?.[0]?.delta?.content).toBe('review complete');
    expect(callback.usage).toBeDefined();
  });

  it('streamParsesOpenRouterReasoningDelta', async () => {
    server = new QueueServer();
    // OpenRouter 风格：思考阶段走 delta.reasoning / delta.reasoning_details，答案阶段走 delta.content
    server.enqueueSse(
      'data: {"choices":[{"delta":{"role":"assistant","content":"","reasoning":"思考","reasoning_details":[{"type":"reasoning.text","text":"思考","format":"unknown","index":0}]}}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":"答案"}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
      + 'data: [DONE]\n\n',
    );
    await server.start();
    const callback = new CapturingCallback();
    await adapter(0, 0).stream(request('reasoning-delta'), configOf(server), callback, { get: () => false });
    expect(callback.error).toBeUndefined();
    const reasoning = callback.chunks.map((c) => c.choices?.[0]?.delta?.reasoningContent ?? '').join('');
    const content = callback.chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
    expect(reasoning).toBe('思考');
    expect(content).toBe('答案');
  });

  it('streamReportsFriendlyErrorWhenThinkingTruncatedRetriesExhausted', async () => {
    server = new QueueServer();
    const truncatedSse =
      'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'
      + 'data: [DONE]\n\n';
    server.enqueueSse(truncatedSse);
    server.enqueueSse(truncatedSse);
    await server.start();
    const callback = new CapturingCallback();
    await adapter(1, 0).stream(request('truncated-exhausted'), configOf(server), callback, { get: () => false });
    expect(callback.usage).toBeUndefined();
    expect((callback.error as Error).message).toContain('模型思考被输出上限截断，自动重试已耗尽，请重试');
    expect(server.requestCount).toBe(2);
  });

  it('streamDoesNotTreatContentTruncationAsThinkingTruncation', async () => {
    server = new QueueServer();
    // finish_reason=length 但有正式 content：属于内容截断，按正常流完成
    server.enqueueSse(
      'data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'
      + 'data: [DONE]\n\n',
    );
    await server.start();
    const callback = new CapturingCallback();
    await adapter(0, 0).stream(request('content-truncated'), configOf(server), callback, { get: () => false });
    expect(callback.error).toBeUndefined();
    expect(callback.usage).toBeDefined();
    expect(callback.retryReasons).toEqual([]);
    expect(server.requestCount).toBe(1);
  });

  it('streamRetriesAfterVisibleOutputAndResetsPartialChunks', async () => {
    server = new QueueServer();
    server.enqueueSse('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    server.enqueueSse('data: {"choices":[{"delta":{"content":"replacement"}}]}\n\ndata: [DONE]\n\n');
    await server.start();
    const callback = new CapturingCallback();
    await adapter(1, 0, 5, 1).stream(request('partial'), configOf(server), callback, { get: () => false });
    expect(callback.error).toBeUndefined();
    expect(callback.streamResetCount).toBe(1);
    expect(callback.chunks).toHaveLength(1);
  }, 10_000);

  it('streamDoesNotRetryHttp400EvenIfOnErrorThrows', async () => {
    server = new QueueServer();
    server.enqueueJson('{"error":{"message":"Invalid schema"}}', 400);
    server.enqueueSse('data: {"choices":[{"delta":{"content":"should-not-run"}}]}\n\ndata: [DONE]\n\n');
    await server.start();
    const callback = new CapturingCallback();
    callback.onError = (t: unknown) => {
      callback.error = t;
      throw t;
    };
    await expect(adapter(3, 0).stream(request('bad-schema'), configOf(server), callback, { get: () => false }))
      .rejects.toBeTruthy();
    expect(callback.retryReasons).toEqual([]);
    expect(server.requestCount).toBe(1);
    expect((callback.error as Error).message).toContain('400');
  });
});
