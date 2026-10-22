import { createHash } from 'node:crypto';
import { harnessLog } from '../log.js';
import type { ChatMessage, ToolDefinition } from '../llm/chat-request.js';

/**
 * 前缀指纹观测（技术方案 2026-10-12 §4.3；2026-10-22 补消息级）。
 *
 * 三层口径，全部是「所见即所发」：
 * 1. 系统提示逐节 hash：定位 memories / skills / workspace-rules 等分节漂移；
 * 2. 工具定义 hash：定位工具增删或 schema 变化；
 * 3. 渲染后消息逐条 hash：定位请求期注入造成的消息前缀断裂。
 *
 * 第 3 层覆盖不落库、也不在系统提示里的隐藏内容：`<date-change>` 日期标签、
 * tool 循环的 `<system-notice>`（后台任务 / 子代理结果、MCP 告警、无进展提醒）、
 * 快捷命令展开、工具图片注入、历史归一化、压缩交接 summary。它们只作用于本次请求副本，
 * 前两层看不到，但一旦落在历史中段就会让缓存前缀从该处断开。
 *
 * 消息比对只把「已有消息被改写 / 删除 / 重排」视为变化；尾部追加是每轮的正常行为，不告警。
 * 存储选进程内存：指纹只在「同一会话相邻两次请求」的比较中有意义，重启后第一次请求
 * 重新登记即可；多实例部署时同一会话落到不同实例会各记一份（顶多多一次「首次登记」，
 * 不产生错误结论）。Map 有上限，按插入序淘汰，避免长跑进程泄漏。
 */

/** 渲染期注入统计（仅日志归因用；内容变化由逐条消息 hash 负责）。 */
export interface PrefixInjectionCounts {
  /** 带 `<date-change>` 标签的消息条数。 */
  dateChangeTags: number;
  /** 带 `<system-notice>` 包裹的消息条数。 */
  systemNotices: number;
}

/** 单个会话的前缀快照。 */
export interface PrefixSnapshot {
  /** 系统提示分节 key → sha256(text)。逐节 hash 才能在整串变化时归因到节。 */
  systemSections: Record<string, string>;
  /** 工具定义数组的 sha256（JSON.stringify 口径，跨轮要求字节一致）。 */
  toolsHash: string;
  /** 非 system 消息逐条 32 位指纹；按最长公共前缀比对，尾部追加不算变化。 */
  messageHashes: Uint32Array;
  /** 当前请求的注入统计。 */
  injections: PrefixInjectionCounts;
  at: number;
}

/** 比对结果：供调用方（与测试）判断是否发生了前缀变化。 */
export interface PrefixObservation extends PrefixInjectionCounts {
  changedSections: string[];
  toolsChanged: boolean;
  firstObservation: boolean;
  /** 历史中段消息是否变化（已有消息被改写 / 删除 / 重排）；纯尾部追加 / 截断不算。 */
  messagesChanged: boolean;
  /** 变化是否只发生在上一轮最后一条消息（重试 / 重写尾部），不打断更早的缓存前缀。 */
  tailRewrite: boolean;
  /** 第一条不一致的消息下标（排除首条 system 后的口径）；无变化为 null。 */
  divergedAt: number | null;
  /** 当前相对上次的消息增量：正数为追加，负数为截断。 */
  appended: number;
}

const MAX_SESSIONS = 512;

const snapshots = new Map<number, PrefixSnapshot>();

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function hashTools(tools: ToolDefinition[] | undefined): string {
  return hashText(JSON.stringify(tools ?? []));
}

/** 多模态 content 里只取 text part；注入标签只可能出现在文本里。 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const part of content) {
    if (part == null || typeof part !== 'object') continue;
    const typed = part as { type?: unknown; text?: unknown };
    if (typed.type === 'text' && typeof typed.text === 'string') texts.push(typed.text);
  }
  return texts.join('\n');
}

function countInjections(messages: ChatMessage[]): PrefixInjectionCounts {
  let dateChangeTags = 0;
  let systemNotices = 0;
  for (const message of messages) {
    const text = contentText(message?.content);
    if (text.startsWith('<date-change>')) dateChangeTags++;
    if (text.startsWith('<system-notice>')) systemNotices++;
  }
  return { dateChangeTags, systemNotices };
}

/**
 * 单条消息指纹：只取协议会真正下发的字段（role / content / name / tool_call_id /
 * tool_calls 的 id / type / function / reasoning_content），忽略 senderYmd、summary
 * 等内部字段。取 sha256 前 32 位存 Uint32Array，512 会话 × 上千条也只占几 MB。
 */
function hashMessage(message: ChatMessage): number {
  const canonical = {
    role: message.role ?? '',
    content: message.content ?? '',
    name: message.name ?? null,
    toolCallId: message.toolCallId ?? null,
    toolCalls: message.toolCalls?.map((call) => ({
      id: call.id ?? null,
      type: call.type ?? null,
      name: call.function?.name ?? null,
      arguments: call.function?.arguments ?? null,
    })) ?? null,
    reasoningContent: message.reasoningContent ?? null,
    audio: message.audio ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest().readUInt32BE(0);
}

function hashMessages(messages: ChatMessage[]): Uint32Array {
  const hashes = new Uint32Array(messages.length);
  for (let i = 0; i < messages.length; i++) hashes[i] = hashMessage(messages[i]);
  return hashes;
}

function touch(sessionId: number, snapshot: PrefixSnapshot): void {
  // 重新 set 会把该键移到插入序末尾，超出上限时淘汰最旧的一个（LRU 简易实现）
  snapshots.delete(sessionId);
  snapshots.set(sessionId, snapshot);
  while (snapshots.size > MAX_SESSIONS) {
    const oldest = snapshots.keys().next();
    if (oldest.done) break;
    snapshots.delete(oldest.value);
  }
}

/**
 * 登记一次 buildRequest 的前缀指纹，与同会话上一次比对并打点。
 * @param sections 系统提示分节（key + text，来自 PromptEngine 的同一份 sections，所见即所发）
 * @param tools 最终请求携带的工具定义
 * @param messages 最终请求的非 system 消息（PromptEngine 传 rendered.slice(1)），
 *                 逐条 hash 后按最长公共前缀比对；尾部追加不算变化
 */
export function observePrefix(
  sessionId: number,
  sections: Array<{ key: string; text: string }>,
  tools: ToolDefinition[] | undefined,
  messages: ChatMessage[],
): PrefixObservation {
  const previous = snapshots.get(sessionId);
  const systemSections: Record<string, string> = {};
  for (const section of sections) {
    // 空节不产生 text（与 PromptEngine 的拼接口径一致），跳过与追加空串等价
    if (section.text.length === 0) continue;
    systemSections[section.key] = hashText(section.text);
  }
  const toolsHash = hashTools(tools);
  const messageHashes = hashMessages(messages);
  const injections = countInjections(messages);
  if (previous == null) {
    touch(sessionId, { systemSections, toolsHash, messageHashes, injections, at: Date.now() });
    harnessLog('info', `prefix fingerprint registered session=${sessionId}`
      + ` sections=${Object.keys(systemSections).length} tools=${tools?.length ?? 0}`
      + ` messages=${messages.length} dateTags=${injections.dateChangeTags} notices=${injections.systemNotices}`);
    return {
      changedSections: [],
      toolsChanged: false,
      firstObservation: true,
      messagesChanged: false,
      tailRewrite: false,
      divergedAt: null,
      appended: 0,
      ...injections,
    };
  }
  const changedSections: string[] = [];
  for (const [key, hash] of Object.entries(systemSections)) {
    if (previous.systemSections[key] !== hash) changedSections.push(key);
  }
  // 上一次有、这次没有的节同样算变化（节被移除也会打掉前缀）
  for (const key of Object.keys(previous.systemSections)) {
    if (!(key in systemSections)) changedSections.push(key);
  }
  const toolsChanged = previous.toolsHash !== toolsHash;
  const common = Math.min(previous.messageHashes.length, messageHashes.length);
  let divergedAt: number | null = null;
  for (let i = 0; i < common; i++) {
    if (previous.messageHashes[i] !== messageHashes[i]) {
      divergedAt = i;
      break;
    }
  }
  const messagesChanged = divergedAt != null;
  // 只改到上一轮最后一条消息属于重试 / 尾部重写，更早的缓存前缀仍然完整；
  // 只有中段（divergedAt < 倒数第一条）变化才按「前缀断裂」告警。
  const tailRewrite = divergedAt != null && divergedAt >= previous.messageHashes.length - 1;
  const appended = messageHashes.length - previous.messageHashes.length;
  touch(sessionId, { systemSections, toolsHash, messageHashes, injections, at: Date.now() });
  if (changedSections.length > 0 || toolsChanged) {
    harnessLog('warn', `prefix changed session=${sessionId} changedSections=[${changedSections.join(',')}]`
      + ` toolsChanged=${toolsChanged} messages=${messages.length}`
      + ` messageChanged=${messagesChanged}${divergedAt == null ? '' : ` divergedAt=${divergedAt}`}`);
  } else if (messagesChanged && !tailRewrite) {
    const role = messages[divergedAt!]?.role ?? 'unknown';
    harnessLog('warn', `message prefix changed session=${sessionId} divergedAt=${divergedAt} role=${role}`
      + ` prevMessages=${previous.messageHashes.length} messages=${messages.length} appended=${appended}`
      + ` dateTags=${injections.dateChangeTags} notices=${injections.systemNotices}`);
  } else if (messagesChanged) {
    harnessLog('info', `message prefix tail rewritten session=${sessionId} divergedAt=${divergedAt}`
      + ` prevMessages=${previous.messageHashes.length} messages=${messages.length} appended=${appended}`);
  } else if (appended < 0) {
    harnessLog('info', `message prefix truncated session=${sessionId}`
      + ` prevMessages=${previous.messageHashes.length} messages=${messages.length}`);
  }
  return {
    changedSections,
    toolsChanged,
    firstObservation: false,
    messagesChanged,
    tailRewrite,
    divergedAt,
    appended,
    ...injections,
  };
}

/** 会话结束时清理指纹，避免快照长期滞留（会话删除 / 执行结束路径调用）。 */
export function resetPrefixFingerprint(sessionId: number): void {
  snapshots.delete(sessionId);
}

/** 仅测试使用：清空全部指纹。 */
export function resetPrefixMonitorForTest(): void {
  snapshots.clear();
}
