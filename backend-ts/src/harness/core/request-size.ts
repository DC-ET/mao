import type { ChatMessage, ChatRequest, ToolDefinition } from '../llm/chat-request.js';
import { shouldEchoReasoningContent } from '../llm/json.js';

/**
 * 请求体体积估算（技术方案 2026-10-22 §4）。
 *
 * 口径与 `harness/llm/json.ts` 的 `serializeChatRequest` 对齐：只统计实际会写进
 * HTTP body 的字段（messages / tools / 顶层参数），不含 HTTP 头与分块编码开销。
 *
 * 为什么不是 `JSON.stringify` 真算：50MB 级请求每次构建都序列化会带来 100ms 级 CPU
 * 与同量级临时内存；体积只用于阈值判断，±3% 精度足够。base64 data URI 是纯 ASCII，
 * `length` 即字节数（O(1)），只有文本才走 `Buffer.byteLength`，整体 <2ms。
 *
 * 文本额外做 JSON 转义补偿：消息里的 JSON/代码文本在 body 中是字符串值，引号、反斜杠、
 * 换行都会膨胀。逐字符扫描 40MB 太慢，改为首/中/尾采样估算膨胀比例（工具输出块的转义
 * 密度在文件内基本均匀），避免「JSON 密集会话估算低 35%」导致阈值判断失效。
 */

/** 顶层参数（model / stream / reasoning_effort / prompt_cache_key 等）的固定开销。 */
const TOP_LEVEL_OVERHEAD = 160;
/** 单条消息的 JSON key、引号与逗号开销。 */
const MESSAGE_OVERHEAD = 48;
/** 单个 tool_call 的 id/type/function 结构开销。 */
const TOOL_CALL_OVERHEAD = 20;
/** 工具定义数组的结构开销（`"tools":[...]`）。 */
const TOOLS_OVERHEAD = 20;
/** 单个工具定义的 name/description/parameters 结构开销。 */
const TOOL_DEFINITION_OVERHEAD = 40;
/** 结构/字段名级的安全系数（不再承担 JSON 转义膨胀，转义按采样实测补偿）。 */
const SAFETY_FACTOR = 1.02;
/**
 * 远程 URL 图在发送前会被适配器下载并压到 ≤300KB，估算按最坏值计入。
 * 目标 300KB 迭代可能收敛在略高处（实测 307KB），再叠加 base64 膨胀 4/3 与 data URI 前缀。
 * 已知低估边界：6 次编码仍未到目标的极端噪声图（实际可到 ~1MB），以及解码失败回退原始字节的图。
 */
const REMOTE_IMAGE_BYTES = Math.ceil((320 * 1024 * 4) / 3) + 1024;
/** 转义采样长度：首/中/尾各采样这么多字符。 */
const ESCAPE_SAMPLE_CHARS = 32 * 1024;

function byteLength(text: string | null | undefined): number {
  if (text == null || text === '') return 0;
  return Buffer.byteLength(text, 'utf8');
}

function countEscapes(sample: string): number {
  let escapes = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    // " \ \b \f \n \r \t 各膨胀 1 个字符（\b \f 也是两字符短转义）；其余控制字符按 \u00XX 膨胀 5 个字符。
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x0c
      || code === 0x0a || code === 0x0d || code === 0x09) {
      escapes += 1;
    }
    else if (code < 0x20) escapes += 5;
  }
  return escapes;
}

/** JSON 字符串值在 body 中的字节数：UTF-8 字节 + 转义膨胀（首/中/尾采样外推）。 */
function jsonStringBytes(text: string | null | undefined): number {
  if (text == null || text === '') return 0;
  const len = text.length;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (len <= ESCAPE_SAMPLE_CHARS) return bytes + countEscapes(text);
  const segments = 3;
  // 每段最多 ESCAPE_SAMPLE_CHARS 个字符（首/中/尾），避免「采样」退化成三次全量扫描。
  const size = Math.min(ESCAPE_SAMPLE_CHARS, Math.floor(len / segments));
  let escapes = 0;
  for (let i = 0; i < segments; i++) {
    const start = Math.floor((len - size) * (i / (segments - 1)));
    escapes += countEscapes(text.slice(start, start + size));
  }
  return bytes + Math.round((escapes / (size * segments)) * len);
}

/**
 * 图片 URL 的 body 占用：
 * - data URI 是纯 ASCII，长度即字节数；
 * - http(s) URL 会被适配器下载并替换成压缩后的 data URI（≤300KB），按最坏值计入，
 *   否则上传图较多的会话会被严重低估（URL 只有几十字节，实际每张约 300KB）。
 */
function urlBytes(url: string | null | undefined): number {
  if (url == null || url === '') return 0;
  if (url.startsWith('data:')) return url.length;
  return REMOTE_IMAGE_BYTES;
}

function imageUrlOf(part: unknown): string | null {
  if (part == null || typeof part !== 'object') return null;
  const p = part as Record<string, unknown>;
  if (p.type !== 'image_url') return null;
  const camel = p.imageUrl as { url?: unknown } | undefined;
  if (camel != null && typeof camel.url === 'string') return camel.url;
  const snake = p.image_url as { url?: unknown } | undefined;
  if (snake != null && typeof snake.url === 'string') return snake.url;
  return null;
}

export class RequestSizeEstimator {
  /**
   * 工具定义按数组引用缓存。注意：调用方每轮 `buildToolDefinitions()` 会新建数组时命中率为 0，
   * 只有复用同一 `tools` 数组才生效；40 个工具 / 168KB schema 重算约 0.5ms，可忽略。
   */
  private readonly toolsBytesCache = new WeakMap<object, number>();

  /**
   * 估算整个请求发送到模型时的 body 字节数。
   * @param modelId 用于判断是否需要回传 reasoning_content（deepseek 系），与序列化器同口径。
   */
  estimate(request: ChatRequest, modelId?: string | null): number {
    const echoReasoning = shouldEchoReasoningContent(modelId ?? '');
    let bytes = TOP_LEVEL_OVERHEAD;
    bytes += byteLength(request.promptCacheKey);
    bytes += this.estimateTools(request.tools);
    bytes += this.estimateMessagesInternal(request.messages ?? [], echoReasoning);
    return Math.ceil(bytes * SAFETY_FACTOR);
  }

  estimateMessages(messages: ChatMessage[] | null | undefined, modelId?: string | null): number {
    const echoReasoning = shouldEchoReasoningContent(modelId ?? '');
    return Math.ceil(this.estimateMessagesInternal(messages ?? [], echoReasoning) * SAFETY_FACTOR);
  }

  private estimateMessagesInternal(messages: ChatMessage[], echoReasoning: boolean): number {
    let bytes = 0;
    for (const message of messages) bytes += this.estimateMessage(message, echoReasoning);
    return bytes;
  }

  private estimateMessage(message: ChatMessage, echoReasoning: boolean): number {
    let bytes = MESSAGE_OVERHEAD;
    bytes += byteLength(message.role);
    bytes += this.contentBytes(message.content);
    bytes += jsonStringBytes(message.name);
    bytes += byteLength(message.toolCallId);
    if (message.toolCalls != null) {
      for (const call of message.toolCalls) {
        bytes += TOOL_CALL_OVERHEAD;
        bytes += byteLength(call.id);
        bytes += jsonStringBytes(call.function?.name);
        bytes += jsonStringBytes(call.function?.arguments);
      }
    }
    if (echoReasoning && message.role === 'assistant') {
      bytes += jsonStringBytes(message.reasoningContent);
    }
    return bytes;
  }

  private contentBytes(content: unknown): number {
    if (content == null) return 0;
    if (typeof content === 'string') return jsonStringBytes(content);
    if (!Array.isArray(content)) return jsonStringBytes(String(content));
    let bytes = 0;
    for (const part of content) {
      if (part == null || typeof part !== 'object') continue;
      const imageUrl = imageUrlOf(part);
      if (imageUrl != null) {
        bytes += urlBytes(imageUrl);
        continue;
      }
      const text = (part as Record<string, unknown>).text;
      if (typeof text === 'string') bytes += jsonStringBytes(text);
    }
    return bytes;
  }

  private estimateTools(tools: ToolDefinition[] | null | undefined): number {
    if (tools == null || tools.length === 0) return 0;
    const cached = this.toolsBytesCache.get(tools);
    if (cached != null) return cached;
    let bytes = TOOLS_OVERHEAD;
    for (const tool of tools) {
      bytes += TOOL_DEFINITION_OVERHEAD;
      bytes += byteLength(tool.type);
      bytes += jsonStringBytes(tool.function?.name);
      bytes += jsonStringBytes(tool.function?.description);
      if (tool.function?.parameters != null) {
        try {
          // 工具定义在 body 里是嵌套对象，序列化一次即最终字节，不需要再做转义补偿。
          bytes += Buffer.byteLength(JSON.stringify(tool.function.parameters), 'utf8');
        } catch {
          bytes += Object.keys(tool.function.parameters).length * 20;
        }
      }
    }
    this.toolsBytesCache.set(tools, bytes);
    return bytes;
  }
}
