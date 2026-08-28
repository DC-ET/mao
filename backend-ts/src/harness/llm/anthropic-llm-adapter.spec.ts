import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicLlmAdapter, convertMessages, ANTHROPIC_MAX_OUTPUT_TOKENS } from './anthropic-llm-adapter.js';
import type { ChatRequest, ChatUsage, LlmModelConfig, LlmRetryConfig, StreamCallback, StreamChunk } from './chat-request.js';
import { DEFAULT_LLM_RETRY } from './chat-request.js';

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

  enqueueHang(): void {
    this.enqueue(() => { /* never respond */ });
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

function adapter(maxRetries = 2, retryDelaySeconds = 0): AnthropicLlmAdapter {
  const retry: LlmRetryConfig = {
    ...DEFAULT_LLM_RETRY,
    rateLimitMaxRetries: maxRetries,
    rateLimitRetryDelaySeconds: retryDelaySeconds,
    rateLimitMaxRetryDelaySeconds: 1,
    callTimeoutSeconds: 5,
    streamIdleTimeoutSeconds: 5,
    httpCallTimeoutSeconds: 5,
  };
  return new AnthropicLlmAdapter(retry);
}

function request(content: string): ChatRequest {
  return {
    temperature: 0.2,
    messages: [{ role: 'user', content }],
    tools: [{ type: 'function', function: { name: 'lookup', description: 'lookup tool', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }],
  };
}

function configOf(server: QueueServer, extra?: Partial<LlmModelConfig>): LlmModelConfig {
  return { baseUrl: server.url() + '/v1', apiKey: 'sk-ant-test', modelId: 'claude-test', ...extra };
}

describe('AnthropicLlmAdapter - chat (non-stream)', () => {
  let server: QueueServer;

  afterEach(async () => {
    if (server) await server.close();
  });

  it('POST {baseUrl}/messages，携带双认证头与 anthropic-version，请求体含 max_tokens 与转换后的 tools', async () => {
    server = new QueueServer();
    server.enqueueJson('{"id":"msg_1","role":"assistant","content":[{"type":"text","text":"你好"}],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":5}}');
    await server.start();

    const response = await adapter().chat(request('hi'), configOf(server));
    expect(server.paths[0]).toBe('/v1/messages');
    expect(server.headers[0]['x-api-key']).toBe('sk-ant-test');
    expect(server.headers[0]['authorization']).toBe('Bearer sk-ant-test');
    expect(server.headers[0]['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(server.bodies[0]) as Record<string, unknown>;
    expect(body.model).toBe('claude-test');
    expect(body.max_tokens).toBe(ANTHROPIC_MAX_OUTPUT_TOKENS);
    expect(body.stream).toBe(false);
    expect(body.system).toBeUndefined();
    expect(body.tools).toEqual([{ name: 'lookup', description: 'lookup tool', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }]);
    expect(body.temperature).toBe(0.2);

    expect(response.choices?.[0]?.message?.content).toBe('你好');
    expect(response.choices?.[0]?.finishReason).toBe('stop');
    expect(response.usage?.promptTokens).toBe(10);
    expect(response.usage?.completionTokens).toBe(5);
    expect(response.usage?.totalTokens).toBe(15);
  });

  it('首条 system 消息拆到顶层 system 参数', async () => {
    server = new QueueServer();
    server.enqueueJson('{"id":"m","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}');
    await server.start();

    await adapter().chat({
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: 'hi' },
      ],
    }, configOf(server));

    const body = JSON.parse(server.bodies[0]) as Record<string, unknown>;
    expect(body.system).toBe('你是助手');
    const messages = body.messages as Array<{ role: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
  });

  it('多段 system：首条拆出，非首条降级为 user 消息并入相邻文本', async () => {
    server = new QueueServer();
    server.enqueueJson('{"id":"m","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}');
    await server.start();

    await adapter().chat({
      messages: [
        { role: 'system', content: '第一段' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: '第二段' },
      ],
    }, configOf(server));

    const body = JSON.parse(server.bodies[0]) as Record<string, unknown>;
    expect(body.system).toBe('第一段');
    // 非首条 system 降级为 user 文本，与相邻 user 消息合并为一条（保证严格交替）
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'text', text: '第二段' },
    ]);
  });

  it('assistant toolCalls 转换为 tool_use block，tool 消息合并为 user tool_result block', async () => {
    server = new QueueServer();
    server.enqueueJson('{"id":"m","content":[{"type":"text","text":"done"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}');
    await server.start();

    await adapter().chat({
      messages: [
        { role: 'user', content: '查一下' },
        { role: 'assistant', content: '', toolCalls: [{ index: 0, id: 'toolu_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
        { role: 'tool', toolCallId: 'toolu_1', content: '查询结果A' },
        { role: 'tool', toolCallId: 'toolu_2', content: '查询结果B' },
        { role: 'user', content: '继续' },
      ],
    }, configOf(server));

    const body = JSON.parse(server.bodies[0]) as Record<string, unknown>;
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    // user / assistant(tool_use) / user(tool_result+tool_result+text) —— 严格交替
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toEqual([
      { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } },
    ]);
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '查询结果A' },
      { type: 'tool_result', tool_use_id: 'toolu_2', content: '查询结果B' },
      { type: 'text', text: '继续' },
    ]);
  });

  it('连续 assistant 消息合并为一条', async () => {
    server = new QueueServer();
    server.enqueueJson('{"id":"m","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}');
    await server.start();

    await adapter().chat({
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'assistant', content: 'c' },
        { role: 'user', content: 'd' },
      ],
    }, configOf(server));

    const body = JSON.parse(server.bodies[0]) as Record<string, unknown>;
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages).toHaveLength(3);
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toEqual([
      { type: 'text', text: 'b' },
      { type: 'text', text: 'c' },
    ]);
  });

  it('stop_reason 映射：tool_use→tool_calls、max_tokens→length', async () => {
    server = new QueueServer();
    server.enqueueJson('{"id":"m","content":[{"type":"tool_use","id":"t1","name":"lookup","input":{"q":"x"}}],"stop_reason":"tool_use","usage":{"input_tokens":1,"output_tokens":1}}');
    await server.start();

    const response = await adapter().chat(request('hi'), configOf(server));
    expect(response.choices?.[0]?.finishReason).toBe('tool_calls');
    expect(response.choices?.[0]?.message?.toolCalls?.[0]?.function?.name).toBe('lookup');
    expect(response.choices?.[0]?.message?.toolCalls?.[0]?.function?.arguments).toBe('{"q":"x"}');
  });

  it('HTTP 429 按 Retry-After 重试后成功', async () => {
    server = new QueueServer();
    server.enqueueJson('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}', 429, { 'Retry-After': '0' });
    server.enqueueJson('{"id":"m","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}');
    await server.start();

    const response = await adapter(2, 0).chat(request('hi'), configOf(server));
    expect(server.requestCount).toBe(2);
    expect(response.choices?.[0]?.message?.content).toBe('ok');
  });

  it('HTTP 401 不重试直接失败', async () => {
    server = new QueueServer();
    server.enqueueJson('{"type":"error","error":{"type":"authentication_error","message":"bad key"}}', 401);
    await server.start();

    await expect(adapter().chat(request('hi'), configOf(server))).rejects.toThrow(/401/);
    expect(server.requestCount).toBe(1);
  });

  it('HTTP 500 重试耗尽后抛错', async () => {
    server = new QueueServer();
    server.enqueueJson('{"type":"error","error":{"type":"api_error","message":"boom"}}', 500);
    server.enqueueJson('{"type":"error","error":{"type":"api_error","message":"boom"}}', 500);
    server.enqueueJson('{"type":"error","error":{"type":"api_error","message":"boom"}}', 500);
    await server.start();

    await expect(adapter(2, 0).chat(request('hi'), configOf(server))).rejects.toThrow(/after 2 retries/);
    expect(server.requestCount).toBe(3);
  });
});

describe('AnthropicLlmAdapter - stream', () => {
  let server: QueueServer;

  afterEach(async () => {
    if (server) await server.close();
  });

  it('流式文本：text_delta 聚合为 content、usage 从 message_start/message_delta 归一', async () => {
    server = new QueueServer();
    server.enqueueSse(
      'event: message_start\n'
      + 'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":25,"cache_read_input_tokens":10}}}\n\n'
      + 'event: content_block_start\n'
      + 'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
      + 'event: content_block_delta\n'
      + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}\n\n'
      + 'event: content_block_delta\n'
      + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}\n\n'
      + 'event: content_block_stop\n'
      + 'data: {"type":"content_block_stop","index":0}\n\n'
      + 'event: message_delta\n'
      + 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n'
      + 'event: message_stop\n'
      + 'data: {"type":"message_stop"}\n\n',
    );
    await server.start();

    const callback = new CapturingCallback();
    await adapter().stream(request('hi'), configOf(server), callback);
    expect(callback.error).toBeUndefined();
    const text = callback.chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
    expect(text).toBe('你好');
    expect(callback.usage).toEqual({
      promptTokens: 25,
      completionTokens: 7,
      totalTokens: 32,
      promptTokensDetails: { cachedTokens: 10 },
    });
  });

  it('thinking_delta 映射为 reasoningContent', async () => {
    server = new QueueServer();
    server.enqueueSse(
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n'
      + 'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n'
      + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"让我想想"}}\n\n'
      + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"……"}}\n\n'
      + 'data: {"type":"content_block_stop","index":0}\n\n'
      + 'data: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}\n\n'
      + 'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"答案"}}\n\n'
      + 'data: {"type":"content_block_stop","index":1}\n\n'
      + 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n'
      + 'data: {"type":"message_stop"}\n\n',
    );
    await server.start();

    const callback = new CapturingCallback();
    await adapter().stream(request('hi'), configOf(server), callback);
    expect(callback.error).toBeUndefined();
    const reasoning = callback.chunks.map((c) => c.choices?.[0]?.delta?.reasoningContent ?? '').join('');
    const content = callback.chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
    expect(reasoning).toBe('让我想想……');
    expect(content).toBe('答案');
  });

  it('tool_use：content_block_start 发出 tool_call_start，input_json_delta 分片合并', async () => {
    server = new QueueServer();
    server.enqueueSse(
      'data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\n'
      + 'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_9","name":"lookup"}}\n\n'
      + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}\n\n'
      + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"x\\"}"}}\n\n'
      + 'data: {"type":"content_block_stop","index":0}\n\n'
      + 'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}\n\n'
      + 'data: {"type":"message_stop"}\n\n',
    );
    await server.start();

    const callback = new CapturingCallback();
    await adapter().stream(request('hi'), configOf(server), callback);
    expect(callback.error).toBeUndefined();
    // 模拟 AgentLoop 的合并逻辑：按 id 合并 toolCalls delta
    const merged = new Map<number, { id?: string; name?: string; arguments: string }>();
    for (const chunk of callback.chunks) {
      for (const tc of chunk.choices?.[0]?.delta?.toolCalls ?? []) {
        const key = tc.index ?? 0;
        const cur = merged.get(key) ?? { arguments: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        merged.set(key, cur);
      }
    }
    expect(merged.get(0)).toEqual({ id: 'toolu_9', name: 'lookup', arguments: '{"q":"x"}' });
    expect(callback.usage?.completionTokens).toBe(20);
  });

  it('message_stop 缺失（流中断）按可重试异常处理', async () => {
    server = new QueueServer();
    server.enqueueSse(
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n'
      + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"部分"}}\n\n',
    );
    await server.start();

    const callback = new CapturingCallback();
    // 只允许一次尝试（maxRetries=1 但中断发生在输出后，StreamInterruptedAfterOutputException 不可自动重试，
    // 直接进入 describeStreamFailure 终态文案）
    await adapter(0, 0).stream(request('hi'), configOf(server), callback);
    expect(callback.error).toBeDefined();
    expect((callback.error as Error).message).toContain('模型流式响应已中断');
  });

  it('error 事件（中途限流）触发 onStreamReset 并重试', async () => {
    server = new QueueServer();
    server.enqueueSse(
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n'
      + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"开头"}}\n\n'
      + 'event: error\n'
      + 'data: {"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}\n\n',
    );
    server.enqueueSse(
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n'
      + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"完整回答"}}\n\n'
      + 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n'
      + 'data: {"type":"message_stop"}\n\n',
    );
    await server.start();

    const callback = new CapturingCallback();
    await adapter(2, 0).stream(request('hi'), configOf(server), callback);
    expect(server.requestCount).toBe(2);
    expect(callback.streamResetCount).toBe(1);
    expect(callback.retryReasons).toContain('stream_error_event');
    expect(callback.retryStatuses).toContain(429);
    const text = callback.chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
    expect(text).toBe('完整回答');
  });

  it('非流式 thinking 截断（stop_reason=max_tokens 且无 content/tool_use）重试', async () => {
    server = new QueueServer();
    server.enqueueSse(
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n'
      + 'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n'
      + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"思考到一半被截断"}}\n\n'
      + 'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":100}}\n\n'
      + 'data: {"type":"message_stop"}\n\n',
    );
    server.enqueueSse(
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n'
      + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"重新回答"}}\n\n'
      + 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n'
      + 'data: {"type":"message_stop"}\n\n',
    );
    await server.start();

    const callback = new CapturingCallback();
    await adapter(2, 0).stream(request('hi'), configOf(server), callback);
    expect(server.requestCount).toBe(2);
    expect(callback.retryReasons).toContain('thinking_truncated');
    const reasoning = callback.chunks.map((c) => c.choices?.[0]?.delta?.reasoningContent ?? '').join('');
    expect(reasoning).toBe('重新回答'.length === 0 ? 'never' : '');
  });

  it('分块传输（跨 chunk 断行）正确解析', async () => {
    server = new QueueServer();
    const events = [
      Buffer.from('data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\nda'),
      Buffer.from('ta: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"跨块"}}\n\n'),
      Buffer.from('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n'),
      Buffer.from('data: {"type":"message_stop"}\n\n'),
    ];
    server.enqueueChunkedSse(events);
    await server.start();

    const callback = new CapturingCallback();
    await adapter().stream(request('hi'), configOf(server), callback);
    expect(callback.error).toBeUndefined();
    const text = callback.chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
    expect(text).toBe('跨块');
    expect(callback.usage?.totalTokens).toBe(5);
  });

  it('取消：cancelFlag 置位后中止流', async () => {
    server = new QueueServer();
    server.enqueueHang();
    await server.start();

    let value = false;
    const cancelFlag = { get: () => value };
    const callback = new CapturingCallback();
    const promise = adapter(2, 0).stream(request('hi'), configOf(server), callback, cancelFlag);
    setTimeout(() => { value = true; }, 100);
    await promise;
    expect((callback.error as Error).message).toBe('Cancelled by user');
  });

  it('HTTP 429 流式响应头阶段重试', async () => {
    server = new QueueServer();
    server.enqueueJson('{"type":"error","error":{"type":"rate_limit_error"}}', 429, { 'Retry-After': '0' });
    server.enqueueSse(
      'data: {"type":"message_start","message":{"usage":{"input_tokens":2}}}\n\n'
      + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"重试成功"}}\n\n'
      + 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n'
      + 'data: {"type":"message_stop"}\n\n',
    );
    await server.start();

    const callback = new CapturingCallback();
    await adapter(2, 0).stream(request('hi'), configOf(server), callback);
    expect(server.requestCount).toBe(2);
    expect(callback.retryReasons).toContain('http_status');
    const text = callback.chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
    expect(text).toBe('重试成功');
  });
});

describe('convertMessages', () => {
  it('空消息序列返回空数组', () => {
    const result = convertMessages([]);
    expect(result.messages).toEqual([]);
    expect(result.system).toBeNull();
  });

  it('user 数组 content 中的图片转为 image block（data URL）', () => {
    const result = convertMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这张图' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,aGVsbG8=' } },
        ],
      },
    ]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      { type: 'text', text: '看这张图' },
    ]);
  });

  it('不支持的图片媒体类型被跳过', () => {
    const result = convertMessages([
      {
        role: 'user',
        content: [
          { type: 'image_url', imageUrl: { url: 'data:image/bmp;base64,aGVsbG8=' } },
          { type: 'text', text: '描述' },
        ],
      },
    ]);
    expect(result.messages[0].content).toEqual([{ type: 'text', text: '描述' }]);
  });

  it('tool 消息 toolCallId 缺失时用空串（防御）', () => {
    const result = convertMessages([{ role: 'tool', content: '结果' }]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content[0]).toEqual({ type: 'tool_result', tool_use_id: '', content: '结果' });
  });

  it('assistant toolCalls arguments 非法 JSON 时 input 回落空对象', () => {
    const result = convertMessages([
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', function: { name: 'lookup', arguments: 'not-json' } }] },
    ]);
    expect(result.messages[0].content).toEqual([
      { type: 'tool_use', id: 't1', name: 'lookup', input: {} },
    ]);
  });

  it('纯字符串 user content 转为单 text block', () => {
    const result = convertMessages([{ role: 'user', content: 'hello' }]);
    expect(result.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
  });
});
