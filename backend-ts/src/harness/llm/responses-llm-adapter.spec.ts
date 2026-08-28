import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  convertMessages,
  mapResponsesStatusToFinishReason,
  parseResponsesChatResponse,
  REASONING_REF_PREFIX,
  RESPONSES_MAX_OUTPUT_TOKENS,
  ResponsesLlmAdapter,
} from './responses-llm-adapter.js';
import type { ChatRequest, ChatUsage, LlmModelConfig, LlmRetryConfig, StreamCallback, StreamChunk, ToolCall } from './chat-request.js';
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
  usage?: ChatUsage;
  error?: unknown;
  streamResetCount = 0;

  onChunk(chunk: StreamChunk): void { this.chunks.push(chunk); }
  onStreamReset(): void { this.streamResetCount++; this.chunks = []; }
  onComplete(usage: ChatUsage): void { this.usage = usage; }
  onError(t: unknown): void { this.error = t; }
  onWaiting(phase: string): void { this.waitingPhases.push(phase); }
  onRetry(reason: string): void { this.retryReasons.push(reason); }
}

function adapter(maxRetries = 2, retryDelaySeconds = 0): ResponsesLlmAdapter {
  const retry: LlmRetryConfig = {
    ...DEFAULT_LLM_RETRY,
    rateLimitMaxRetries: maxRetries,
    rateLimitRetryDelaySeconds: retryDelaySeconds,
    rateLimitMaxRetryDelaySeconds: 1,
    callTimeoutSeconds: 5,
    streamIdleTimeoutSeconds: 5,
    httpCallTimeoutSeconds: 5,
  };
  return new ResponsesLlmAdapter(retry);
}

function request(content: string, extra?: Partial<ChatRequest>): ChatRequest {
  return {
    temperature: 0.2,
    messages: [{ role: 'user', content }],
    tools: [{ type: 'function', function: { name: 'lookup', description: 'lookup tool', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }],
    ...extra,
  };
}

function configOf(server: QueueServer, extra?: Partial<LlmModelConfig>): LlmModelConfig {
  return { baseUrl: server.url() + '/v1', apiKey: 'sk-responses-test', modelId: 'gpt-responses-test', ...extra };
}

function parseBody(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

const TOOL = { type: 'function', function: { name: 'lookup', description: 'd', parameters: { type: 'object', properties: {} } } } as const;

describe('convertMessages（请求转换）', () => {
  it('system 拆顶层 instructions、user 转 message 项', () => {
    const { instructions, input } = convertMessages([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ]);
    expect(instructions).toBe('You are helpful.');
    expect(input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
  });

  it('assistant toolCalls 平铺为 function_call 项，tool 消息转 function_call_output', () => {
    const { input } = convertMessages([
      { role: 'user', content: '查天气' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"bj"}' } }] },
      { role: 'tool', toolCallId: 'call_1', content: '晴 25 度' },
      { role: 'user', content: '谢谢' },
    ]);
    expect(input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: '查天气' }] },
      { type: 'function_call', id: 'call_1', call_id: 'call_1', name: 'lookup', arguments: '{"q":"bj"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '晴 25 度' },
      { role: 'user', content: [{ type: 'input_text', text: '谢谢' }] },
    ]);
  });

  it('并行多工具：全部 function_call 在前，全部 function_call_output 在后', () => {
    const { input } = convertMessages([
      { role: 'user', content: '查两个城市' },
      { role: 'assistant', content: '', toolCalls: [
        { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"bj"}' } },
        { id: 'call_2', type: 'function', function: { name: 'lookup', arguments: '{"q":"sh"}' } },
      ] },
      { role: 'tool', toolCallId: 'call_1', content: '晴' },
      { role: 'tool', toolCallId: 'call_2', content: '雨' },
    ]);
    const types = input.map((item) => item.type ?? `role:${item.role}`);
    expect(types).toEqual([
      'role:user', 'function_call', 'function_call', 'function_call_output', 'function_call_output',
    ]);
  });

  it('reasoning 往返：reasoning 项插在 function_call 前，带 encrypted_content 与空 summary', () => {
    const { input } = convertMessages([
      { role: 'user', content: '查天气' },
      { role: 'assistant', content: '', toolCalls: [{
        id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' },
        reasoning: { id: 'rs_1', encryptedContent: 'ENC' },
      }] },
      { role: 'tool', toolCallId: 'call_1', content: '晴' },
    ]);
    expect(input[1]).toEqual({ type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [] });
    expect((input[2] as Record<string, unknown>).type).toBe('function_call');
  });

  it('纯文本 assistant 轮也回传 reasoning 项（后继 assistant 消息满足网关约束）', () => {
    const { input } = convertMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '答案', reasoningContent: `${REASONING_REF_PREFIX}{"id":"rs_1","encryptedContent":"ENC"}` },
      { role: 'user', content: '继续' },
    ]);
    expect(input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [] },
      { role: 'assistant', content: [{ type: 'output_text', text: '答案' }] },
      { role: 'user', content: [{ type: 'input_text', text: '继续' }] },
    ]);
  });

  it('带 toolCalls 的 assistant 轮：reasoning blob 兜底提取（thinkingContent 恢复链路）', () => {
    const { input } = convertMessages([
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }], reasoningContent: `${REASONING_REF_PREFIX}{"id":"rs_blob","encryptedContent":"ENC_B"}` },
      { role: 'tool', toolCallId: 'call_1', content: 'x' },
    ]);
    expect(input[0]).toEqual({ type: 'reasoning', id: 'rs_blob', encrypted_content: 'ENC_B', summary: [] });
    expect(input[1]).toMatchObject({ type: 'function_call', call_id: 'call_1' });
  });

  it('toolCall.reasoning 优先于 reasoningContent blob', () => {
    const { input } = convertMessages([
      { role: 'assistant', content: '', toolCalls: [{
        id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' },
        reasoning: { id: 'rs_toolcall', encryptedContent: 'A' },
      }], reasoningContent: `${REASONING_REF_PREFIX}{"id":"rs_blob","encryptedContent":"B"}` },
      { role: 'tool', toolCallId: 'call_1', content: 'x' },
    ]);
    expect(input[0]).toMatchObject({ type: 'reasoning', id: 'rs_toolcall' });
  });

  it('首条之后的 system 消息：首位被 user 占据时降级为 user 文本', () => {
    const { instructions, input } = convertMessages([
      { role: 'system', content: 'first' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'mid' },
    ]);
    expect(instructions).toBe('first');
    expect(input[1]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'mid' }] });
  });

  it('无 user 消息时连续 system 合并为 instructions', () => {
    const { instructions, input } = convertMessages([
      { role: 'system', content: 'A' },
      { role: 'system', content: 'B' },
    ]);
    expect(instructions).toBe('A\n\nB');
    expect(input).toEqual([]);
  });

  it('user 消息图片转 input_image block（data URL）', () => {
    const dataUri = 'data:image/png;base64,aGk=';
    const { input } = convertMessages([
      { role: 'user', content: [{ type: 'image_url', imageUrl: { url: dataUri } }, { type: 'text', text: '这是什么' }] },
    ]);
    expect(input[0]).toEqual({
      role: 'user',
      content: [
        { type: 'input_image', image_url: dataUri },
        { type: 'input_text', text: '这是什么' },
      ],
    });
  });

  it('无配对 call_id 的 tool 消息降级为 user 文本', () => {
    const { input } = convertMessages([
      { role: 'user', content: 'hi' },
      { role: 'tool', content: '孤儿结果' },
    ]);
    expect(input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'input_text', text: '工具结果（无 call_id）：孤儿结果' }] },
    ]);
  });
});

describe('ResponsesLlmAdapter - chat（非流式）', () => {
  let server: QueueServer;

  afterEach(async () => {
    if (server) await server.close();
  });

  it('POST {baseUrl}/responses，请求体含 store/include/max_output_tokens 与转换后的 tools', async () => {
    server = new QueueServer();
    server.enqueueJson(JSON.stringify({
      id: 'resp_1', object: 'response', status: 'completed', model: 'gpt-responses-test',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好' }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 4 } },
    }));
    await server.start();

    const response = await adapter().chat(request('hi'), configOf(server));
    expect(server.paths[0]).toBe('/v1/responses');
    expect(server.headers[0]['authorization']).toBe('Bearer sk-responses-test');
    const body = parseBody(server.bodies[0]);
    expect(body.model).toBe('gpt-responses-test');
    expect(body.stream).toBe(false);
    expect(body.store).toBe(false);
    expect(body.include).toEqual([]);
    expect(body.max_output_tokens).toBe(RESPONSES_MAX_OUTPUT_TOKENS);
    expect(body.temperature).toBe(0.2);
    expect(Array.isArray(body.tools)).toBe(true);
    const tool = (body.tools as Record<string, unknown>[])[0];
    expect(tool).toEqual({ type: 'function', name: 'lookup', description: 'lookup tool', parameters: { type: 'object', properties: { q: { type: 'string' } } } });
    expect(response.choices?.[0]?.message?.content).toBe('你好');
    expect(response.choices?.[0]?.finishReason).toBe('stop');
    expect(response.usage?.promptTokens).toBe(10);
    expect(response.usage?.completionTokens).toBe(5);
    expect(response.usage?.promptTokensDetails?.cachedTokens).toBe(4);
  });

  it('gpt-* 模型的 reasoning effort 下发到请求体', async () => {
    server = new QueueServer();
    server.enqueueJson(JSON.stringify({
      id: 'resp_2', status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }));
    await server.start();

    await adapter().chat(request('hi', { reasoning: { effort: 'high' } }), configOf(server));
    const body = parseBody(server.bodies[0]);
    expect(body.reasoning).toEqual({ effort: 'high' });
  });

  it('响应含 reasoning + function_call 时把 reasoning 引用挂到首个 toolCall', async () => {
    server = new QueueServer();
    server.enqueueJson(JSON.stringify({
      id: 'resp_3', status: 'completed',
      output: [
        { type: 'reasoning', id: 'rs_9', encrypted_content: 'ENC9', summary: [] },
        { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'lookup', arguments: '{"q":"bj"}' },
      ],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    }));
    await server.start();

    const response = await adapter().chat(request('hi'), configOf(server));
    const tc = response.choices?.[0]?.message?.toolCalls?.[0];
    expect(tc?.id).toBe('call_9');
    expect(tc?.function?.name).toBe('lookup');
    expect(tc?.reasoning).toEqual({ id: 'rs_9', encryptedContent: 'ENC9' });
    expect(response.choices?.[0]?.finishReason).toBe('stop');
  });

  it('incomplete/max_output_tokens 映射 finishReason=length', async () => {
    server = new QueueServer();
    server.enqueueJson(JSON.stringify({
      id: 'resp_4', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [], usage: { input_tokens: 3, output_tokens: 100, total_tokens: 103 },
    }));
    await server.start();

    const response = await adapter().chat(request('hi'), configOf(server));
    expect(response.choices?.[0]?.finishReason).toBe('length');
  });

  it('429 按 Retry-After 重试后成功', async () => {
    server = new QueueServer();
    server.enqueueJson(JSON.stringify({ error: { message: 'rate limited' } }), 429, { 'Retry-After': '0' });
    server.enqueueJson(JSON.stringify({
      id: 'resp_5', status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }));
    await server.start();

    const response = await adapter().chat(request('hi'), configOf(server));
    expect(server.requestCount).toBe(2);
    expect(response.choices?.[0]?.message?.content).toBe('ok');
  });

  it('400 非重试错误直接抛出', async () => {
    server = new QueueServer();
    server.enqueueJson(JSON.stringify({ error: { message: 'bad request' } }), 400);
    await server.start();

    await expect(adapter().chat(request('hi'), configOf(server))).rejects.toThrow(/LLM API returned 400/);
    expect(server.requestCount).toBe(1);
  });
});

describe('ResponsesLlmAdapter - stream（流式）', () => {
  let server: QueueServer;

  afterEach(async () => {
    if (server) await server.close();
  });

  it('文本 delta + reasoning summary delta + usage + finishReason', async () => {
    server = new QueueServer();
    server.enqueueSse([
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_1"}}',
      '',
      'event: response.reasoning_summary_text.delta',
      'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","delta":"思考"}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"你"}',
      '',
      'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"好"}',
      '',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10,"input_tokens_details":{"cached_tokens":2}}}}',
      '',
    ].join('\n'));
    await server.start();

    const callback = new CapturingCallback();
    await adapter().stream(request('hi', { reasoning: { effort: 'high' } }), configOf(server), callback);
    expect(callback.error).toBeUndefined();
    const contents = callback.chunks.map((c) => c.choices?.[0]?.delta?.content).filter((t): t is string => t != null).join('');
    const thinkings = callback.chunks.map((c) => c.choices?.[0]?.delta?.reasoningContent).filter((t): t is string => t != null).join('');
    expect(contents).toBe('你好');
    expect(thinkings).toBe('思考');
    expect(callback.usage).toEqual({
      promptTokens: 7, completionTokens: 3, totalTokens: 10, promptTokensDetails: { cachedTokens: 2 },
    });
    const body = parseBody(server.bodies[0]);
    expect(body.stream).toBe(true);
  });

  it('function_call：output_item.added + arguments.delta 聚合出完整 toolCalls', async () => {
    server = new QueueServer();
    server.enqueueSse([
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_x","name":"lookup","arguments":""}}',
      '',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"{\\"q\\":"}',
      '',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"\\"bj\\"}"}',
      '',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_x","name":"lookup","arguments":"{\\"q\\":\\"bj\\"}"}}',
      '',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}',
      '',
    ].join('\n'));
    await server.start();

    const callback = new CapturingCallback();
    await adapter().stream(request('hi'), configOf(server), callback);
    expect(callback.error).toBeUndefined();

    // 按 AgentLoop mergeToolCall 的方式聚合
    const merged = new Map<string, ToolCall>();
    for (const chunk of callback.chunks) {
      for (const tc of chunk.choices?.[0]?.delta?.toolCalls ?? []) {
        const key = tc.id ?? String(tc.index);
        const target = merged.get(key) ?? { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
        if (tc.function?.name && !target.function?.name) target.function!.name = tc.function.name;
        if (tc.function?.arguments) target.function!.arguments = (target.function!.arguments ?? '') + tc.function.arguments;
        merged.set(key, target);
      }
    }
    expect(merged.size).toBe(1);
    const tc = merged.get('call_x');
    expect(tc?.function?.name).toBe('lookup');
    expect(tc?.function?.arguments).toBe('{"q":"bj"}');
    expect(callback.usage?.totalTokens).toBe(7);
  });

  it('网关不发 arguments.delta 时由 output_item.done 刷新完整参数', async () => {
    server = new QueueServer();
    server.enqueueSse([
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_x","name":"lookup","arguments":""}}',
      '',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_x","name":"lookup","arguments":"{\\"q\\":\\"bj\\"}"}}',
      '',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      '',
    ].join('\n'));
    await server.start();

    const callback = new CapturingCallback();
    await adapter().stream(request('hi'), configOf(server), callback);
    expect(callback.error).toBeUndefined();
    const args = callback.chunks
      .map((c) => c.choices?.[0]?.delta?.toolCalls?.[0]?.function?.arguments ?? '')
      .join('');
    expect(args).toBe('{"q":"bj"}');
  });

  it('response.failed 事件抛 StreamErrorEventException（429 可重试并触发 onStreamReset）', async () => {
    server = new QueueServer();
    server.enqueueSse([
      'data: {"type":"response.output_text.delta","item_id":"m","delta":"部"}',
      '',
      'data: {"type":"response.failed","response":{"error":{"code":429,"message":"rate limited mid-stream"}}}',
      '',
    ].join('\n'));
    server.enqueueSse([
      'data: {"type":"response.output_text.delta","item_id":"m","delta":"成功"}',
      '',
      'data: {"type":"response.completed","response":{"id":"resp_2","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      '',
    ].join('\n'));
    await server.start();

    const callback = new CapturingCallback();
    await adapter().stream(request('hi'), configOf(server), callback);
    expect(server.requestCount).toBe(2);
    expect(callback.retryReasons).toContain('stream_error_event');
    expect(callback.streamResetCount).toBe(1);
    expect(callback.error).toBeUndefined();
  });

  it('无 response.completed 的截断流：有输出报流中断，无输出报 EOF', async () => {
    // maxRetries=0：截断异常不可重试，直接暴露最终错误消息
    server = new QueueServer();
    server.enqueueSse('data: {"type":"response.output_text.delta","item_id":"m","delta":"部"}\n\n');
    await server.start();
    const withOutput = new CapturingCallback();
    await adapter(0).stream(request('hi'), configOf(server), withOutput);
    expect(String((withOutput.error as Error)?.message)).toContain('流式响应已中断');
    await server.close();

    server = new QueueServer();
    server.enqueueSse('data: {"type":"response.created","response":{"id":"r"}}\n\n');
    await server.start();
    const noOutput = new CapturingCallback();
    await adapter(0).stream(request('hi'), configOf(server), noOutput);
    expect(String((noOutput.error as Error)?.message)).toContain('stream ended before response.completed');
  });

  it('流中 Cancelled by user（cancelFlag 置位）回调 onError 且不重试', async () => {
    server = new QueueServer();
    server.enqueueChunkedSse([
      Buffer.from('data: {"type":"response.output_text.delta","item_id":"m","delta":"你"}\n\n'),
      Buffer.from('data: {"type":"response.completed","response":{"id":"r","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n'),
    ]);
    await server.start();

    const callback = new CapturingCallback();
    let cancelled = false;
    const cancelFlag = { get: () => cancelled };
    setTimeout(() => { cancelled = true; }, 5);
    await adapter().stream(request('hi'), configOf(server), callback, cancelFlag);
    expect(callback.error).toBeDefined();
  });

  it('incomplete/max_output_tokens 且只有思考：抛思考截断并整轮重试', async () => {
    server = new QueueServer();
    server.enqueueSse([
      'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs","delta":"想"}',
      '',
      'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}',
      '',
    ].join('\n'));
    server.enqueueSse([
      'data: {"type":"response.output_text.delta","item_id":"m","delta":"重试成功"}',
      '',
      'data: {"type":"response.completed","response":{"id":"resp_2","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      '',
    ].join('\n'));
    await server.start();

    const callback = new CapturingCallback();
    await adapter().stream(request('hi'), configOf(server), callback);
    expect(server.requestCount).toBe(2);
    expect(callback.retryReasons).toContain('thinking_truncated');
    expect(callback.streamResetCount).toBe(1);
    expect(callback.chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('')).toBe('重试成功');
  });
});

describe('parseResponsesChatResponse / mapResponsesStatusToFinishReason', () => {
  it('message 与 function_call 混合输出、无 reasoning 时不挂引用', () => {
    const parsed = parseResponsesChatResponse({
      id: 'r1', status: 'completed',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] },
        { type: 'function_call', id: 'fc', call_id: 'call_1', name: 'n', arguments: '{}' },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
    expect(parsed.choices?.[0]?.message?.content).toBe('a');
    expect(parsed.choices?.[0]?.message?.toolCalls?.[0]?.reasoning).toBeUndefined();
  });

  it('total_tokens 缺失时按 prompt+completion 折算', () => {
    const parsed = parseResponsesChatResponse({
      status: 'completed', output: [],
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    expect(parsed.usage?.totalTokens).toBe(14);
  });

  it('finishReason 映射', () => {
    expect(mapResponsesStatusToFinishReason('completed', false)).toBe('stop');
    expect(mapResponsesStatusToFinishReason('in_progress', false)).toBe('stop');
    expect(mapResponsesStatusToFinishReason('incomplete', false)).toBe('length');
    expect(mapResponsesStatusToFinishReason('completed', true)).toBe('length');
  });
});
