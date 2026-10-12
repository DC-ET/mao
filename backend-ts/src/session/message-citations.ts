import type { Message } from './types.js';
import type { SessionService } from './session.service.js';
import { extractCitationMarkers } from './util/citation-markers.js';

/**
 * 回复引用溯源（技术方案 docs/plan/2026-10-12-answer-citations-technical-design.md §5.2）：
 * 任务完成（TASK_COMPLETED）时，从本轮 web_search / open_web_page 的工具结果构建 URL
 * 白名单（registry），对最终回复里的 `[^n^]` 标记做白名单校验，把被引用的条目写入
 * 最终 ASSISTANT 消息的 metadata.citations。编号权在系统：n 即 registry 序号。
 */

/** 进入白名单的联网工具（决策 1：仅这两个；其他工具的 URL 不是可引用来源）。 */
const CITABLE_TOOL_NAMES = new Set(['web_search', 'open_web_page']);

/** registry 上限：单轮正常引用量远小于此，超出截断（对应标记被剥）。 */
const REGISTRY_MAX = 20;

/**  citations 数组条目（与桌面端 desktop/src/types/chat.ts 的 Citation 同构）。 */
export interface CitationEntry {
  /** registry 序号（1 起），与正文 `[^n^]` 对应；数组只含被引用条目。 */
  n: number;
  url: string;
  title: string;
}

function parseJson(content: string | null | undefined): Record<string, unknown> | null {
  if (content == null || content === '') return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim() === '' ? null : value;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 只收 http/https：工具结果理论上只含这类 URL，这里兜底防非常规协议进入 citations。 */
function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** 从 ASSISTANT 消息的 tool_calls JSON 建立 toolCallId → 工具名映射（TOOL 消息本身不带工具名）。 */
export function buildToolNameIndex(messages: Message[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'ASSISTANT' || message.toolCalls == null || message.toolCalls === '') continue;
    let calls: unknown;
    try {
      calls = JSON.parse(message.toolCalls);
    } catch {
      continue;
    }
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (call == null || typeof call !== 'object') continue;
      const node = call as { id?: unknown; function?: { name?: unknown } };
      const id = asNonEmptyString(node.id);
      const name = asNonEmptyString(node.function?.name);
      if (id != null && name != null) index.set(id, name);
    }
  }
  return index;
}

/** 从单个 TOOL 消息内容提取来源条目；失败形态（{error}）与非目标工具返回空数组。 */
export function extractSourcesFromToolResult(toolName: string, content: string | null | undefined): CitationEntry[] {
  const obj = parseJson(content);
  if (obj == null) return [];
  const out: CitationEntry[] = [];
  if (toolName === 'web_search') {
    const results = obj.results;
    if (!Array.isArray(results)) return [];
    for (const item of results) {
      if (item == null || typeof item !== 'object') continue;
      const node = item as { url?: unknown; title?: unknown };
      const url = asNonEmptyString(node.url);
      if (url == null || !isHttpUrl(url)) continue;
      out.push({ n: 0, url, title: asString(node.title) });
    }
    return out;
  }
  if (toolName === 'open_web_page') {
    // 成功形态含字符串 content；失败形态 errorJson(msg, url) 只有 {error, url}，不进白名单
    if (typeof obj.content !== 'string') return [];
    const url = asNonEmptyString(obj.url);
    if (url == null || !isHttpUrl(url)) return [];
    out.push({ n: 0, url, title: asString(obj.title) });
    return out;
  }
  return [];
}

/** 合并 metadata：保留既有键，只写 / 覆盖 citations 键。 */
export function mergeCitationsMetadata(existing: string | null | undefined, citations: CitationEntry[]): string {
  let root: Record<string, unknown> = {};
  if (existing != null && existing !== '') {
    const parsed = parseJson(existing);
    if (parsed != null) root = parsed;
  }
  root.citations = citations;
  return JSON.stringify(root);
}

export class MessageCitationService {
  constructor(private readonly sessionService: SessionService) {}

  /**
   * 为一个已完成会话构建并落库 citations。任何异常向上抛（由调用方
   * TaskTerminalService.dispatchCitationRegistry 兜底 catch）——这里是纯计算 +
   * 一次 UPDATE，失败不应静默成"没有引用"。
   */
  async buildForSession(sessionId: number): Promise<void> {
    const finalMessage = await this.sessionService.findLastAssistantMessage(sessionId);
    if (finalMessage?.id == null || finalMessage.content == null || finalMessage.content === '') return;

    // 先判有没有标记再拉全量消息：绝大多数已完成会话没有标记，省一次全量查询
    const markers = extractCitationMarkers(finalMessage.content);
    if (markers.length === 0) return;

    const messages = await this.sessionService.getRawMessages(sessionId);
    // 本轮范围：最后一条 USER 消息之后的全部 TOOL 消息（消息 id 单调递增，无需 execution_id）
    const lastUserId = messages.reduce((max, m) => (m.role === 'USER' && m.id != null ? Math.max(max, m.id) : max), 0);
    const toolNames = buildToolNameIndex(messages);

    const registry: CitationEntry[] = [];
    const seenUrls = new Set<string>();
    for (const message of messages) {
      if (message.role !== 'TOOL' || message.id == null || message.id <= lastUserId) continue;
      const toolName = message.toolCallId != null ? toolNames.get(message.toolCallId) : undefined;
      if (toolName == null || !CITABLE_TOOL_NAMES.has(toolName)) continue;
      for (const source of extractSourcesFromToolResult(toolName, message.content)) {
        if (seenUrls.has(source.url)) continue;
        seenUrls.add(source.url);
        registry.push(source);
        if (registry.length >= REGISTRY_MAX) break;
      }
      if (registry.length >= REGISTRY_MAX) break;
    }

    // 白名单校验：n ∈ [1, registry.length] 才保留；同一 n 重复引用去重；按 n 升序
    const citedNs = [...new Set(markers)].filter(n => n >= 1 && n <= registry.length).sort((a, b) => a - b);
    if (citedNs.length === 0) return;

    const citations: CitationEntry[] = citedNs.map(n => {
      const entry = registry[n - 1];
      return { n, url: entry.url, title: entry.title };
    });
    await this.sessionService.updateMessageMetadata(finalMessage.id, mergeCitationsMetadata(finalMessage.metadata, citations));
  }
}
