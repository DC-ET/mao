import { createHash } from 'node:crypto';
import type { ChatMessage } from '../llm/chat-request.js';
import type { ToolAttachment } from './tool-attachment.js';
import { isRealUserMessage } from './compaction-service.js';
import { harnessLog } from '../log.js';

/**
 * Agent 无进展工具循环止损（技术方案 2026-10-21 §4）。
 *
 * 本模块只放纯函数：判定口径由运行时 guard 与历史重放扫描共用，任何一处单独改口径都会
 * 让「执行中注入的提醒」与「重启后重算的提醒」分叉，进而击穿跨执行的前缀缓存。
 */

/** 第 5 / 10 轮结束时各注入一次提醒（模型在下一轮请求中看到）。 */
export const NO_PROGRESS_NUDGE_AT = [5, 10] as const;
/** 连续第 15 轮结果仍无变化时中止本次执行。 */
export const NO_PROGRESS_ABORT_AT = 15;

/** 工具级豁免（当前为空）：整轮全是豁免工具时视为无工具轮。 */
export const NO_PROGRESS_EXEMPT_TOOLS = new Set<string>();

export interface NoProgressCall {
  toolName: string;
  argumentsJson: string;
  /** 模型实际看到的、经 processToolResult 清洗后的结果内容。 */
  resultContent: string;
  /** 图片结果的可选附件（data_uri）；用于把图片字节纳入摘要。 */
  attachment?: ToolAttachment | null;
}

export interface NoProgressNotice {
  /** 触发轮最后一个 tool_call_id：渲染时插在该 tool 消息之后。 */
  afterToolCallId: string;
  text: string;
}

export interface NoProgressTail {
  streak: number;
  lastRoundKey: string;
  nudgedAt: number[];
}

export interface NoProgressScanResult {
  notices: NoProgressNotice[];
  tail: NoProgressTail | null;
}

/**
 * 通用易变字段清单（递归剔除）：只放「确认非语义」的传输 / 计时字段。
 *
 * 黑名单的风险是双向的：漏补字段 → 漏报；误删语义字段 → 误杀。`child_session_id` /
 * `task_id` 默认不在此表——它们对子代理结果是语义身份。新增工具若结果带随机 id，
 * 必须逐项确认，优先改用下面的按工具归一化。
 */
const VOLATILE_RESULT_KEYS = new Set<string>([
  'execution_id',
  'request_id',
  'trace_id',
  'timestamp',
  'duration_ms',
  'elapsed_ms',
  'created_at',
  'updated_at',
]);

/**
 * shell 只取语义字段。事故 2207 的形态是每次 `output_file` 都随新建会话变化
 * （`${shellSessionId}.out`），未完成时的 `message` 也带会话 id；只剔 `session_id`
 * 仍然每轮不同，会漏报。`output` / `exit_code` / `completed` 已覆盖真实结果。
 */
const SHELL_SEMANTIC_KEYS = ['exit_code', 'output', 'truncated', 'completed', 'current_workdir'] as const;

/** 调用级豁免：长等待 / 显式未完成结果不参与 streak。 */
export const NO_PROGRESS_EXEMPT_CALLS: ReadonlyArray<(call: NoProgressCall) => boolean> = [
  (call) => call.toolName === 'shell' && isShellWaitAction(call.argumentsJson),
  (call) => call.toolName === 'shell' && isIncompleteShellResult(call.resultContent),
  (call) => call.toolName === 'wait_subagents' && isTimedOutResult(call.resultContent),
];

/** 调用是否不参与本轮签名（工具级 + 调用级）。 */
export function isNoProgressExempt(call: NoProgressCall): boolean {
  if (NO_PROGRESS_EXEMPT_TOOLS.has(call.toolName)) return true;
  return NO_PROGRESS_EXEMPT_CALLS.some((predicate) => predicate(call));
}

/**
 * 参数规范化：JSON 递归按键名排序后稳定序列化；解析失败时去首尾空白并把连续空白压成单空格。
 * 键顺序排序是必须的——不同网关对 `arguments` 的键顺序不稳定，直接字符串比对会误判。
 */
export function canonicalArgs(raw: string): string {
  const text = raw ?? '';
  const parsed = parseJson(text);
  if (parsed.ok) return stableStringify(parsed.value);
  return text.trim().replace(/\s+/g, ' ');
}

/** 结果摘要：语义归一化后取 sha256 前 16 位。 */
export function resultDigest(call: NoProgressCall): string {
  const normalized = normalizeResult(call.toolName, call.resultContent ?? '');
  const imageDigest = call.attachment?.dataUri ? shortHash(call.attachment.dataUri) : '';
  return shortHash(`${call.toolName}\u0000${normalized}\u0000${imageDigest}`);
}

/** 整轮签名：按模型输出顺序拼接每个调用的 toolName + canonicalArgs + resultDigest。 */
export function roundSignature(calls: NoProgressCall[]): string {
  return calls
    .map((call) => `${call.toolName}\u0001${canonicalArgs(call.argumentsJson)}\u0001${resultDigest(call)}`)
    .join('\u0002');
}

/** 提醒文案只带工具名与轮数，不带参数原文（参数可能含路径、token、客户数据）。 */
export function buildNoProgressNotice(streak: number, toolNames: string[]): string {
  const tools = toolNames.length > 0 ? toolNames.join('/') : '未知';
  const repeat = `最近 ${streak} 轮的工具调用与结果完全一致（工具：${tools}）`;
  if (streak >= NO_PROGRESS_NUDGE_AT[NO_PROGRESS_NUDGE_AT.length - 1]) {
    return `重复调用仍在继续：${repeat}。`
      + `若继续无变化，系统将在第 ${NO_PROGRESS_ABORT_AT} 轮自动中止本次执行。请立即换策略或直接给出结论。`;
  }
  return `检测到重复调用：${repeat}。继续重复不会产生新信息。`
    + '请改变做法：调整参数/关键词/路径、改用其他工具，或基于已有结果直接向用户说明结论与当前阻塞。';
}

/**
 * 扫描历史工具轮，重算出「渲染期提醒锚点」与「窗口尾部状态」。
 *
 * 语义与运行时 guard 完全同源：以真实用户消息为回合边界；assistant(tool_calls) + 其后
 * 按 id 配对的 tool 消息构成一轮；缺失 tool 输出的轮（取消 / 中断 / 孤儿消息）跳过。
 */
export function scanNoProgressNotices(
  messages: ChatMessage[],
  attachments?: Map<string, ToolAttachment> | null,
): NoProgressScanResult {
  const notices: NoProgressNotice[] = [];
  let lastRoundKey: string | null = null;
  let streak = 0;
  let nudgedAt: number[] = [];
  const reset = () => {
    lastRoundKey = null;
    streak = 0;
    nudgedAt = [];
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg == null) continue;
    if (isRealUserMessage(msg)) {
      reset();
      continue;
    }
    if (msg.role !== 'assistant' || msg.toolCalls == null || msg.toolCalls.length === 0) continue;
    const toolMessages = collectContiguousToolMessages(messages, i + 1);
    const round = buildRoundCalls(msg.toolCalls, toolMessages, attachments);
    if (round == null) continue;
    if (round.calls.length === 0) {
      reset();
      continue;
    }
    const key = roundSignature(round.calls);
    if (key === lastRoundKey) {
      streak += 1;
    } else {
      lastRoundKey = key;
      streak = 1;
      nudgedAt = [];
    }
    const threshold = NO_PROGRESS_NUDGE_AT.find((value) => value === streak);
    if (threshold != null && !nudgedAt.includes(threshold)) {
      nudgedAt.push(threshold);
      notices.push({ afterToolCallId: round.anchorToolCallId, text: buildNoProgressNotice(streak, round.toolNames) });
    }
  }

  const tail: NoProgressTail | null = streak > 0 && lastRoundKey != null
    ? { streak, lastRoundKey, nudgedAt: [...nudgedAt] }
    : null;
  return { notices, tail };
}

/**
 * 对请求副本渲染提醒：在锚点 tool 消息之后插入一条 user 角色的 `<system-notice>`。
 *
 * 纯函数：只读 notices，返回新数组，不修改入参与消息对象。同一输入重复调用结果一致；
 * 对已渲染过的数组再调用也不会重复插入（紧随锚点的同文案 notice 会被识别）。
 * 锚点缺失（tool 消息被归一化丢弃）时跳过并记 warn，不阻断请求。
 */
export function applyNoProgressNotices(
  messages: ChatMessage[],
  notices: NoProgressNotice[],
): ChatMessage[] {
  if (messages.length === 0 || notices.length === 0) return messages;
  const pending = new Map<string, string>();
  for (const notice of notices) {
    if (notice?.afterToolCallId) pending.set(notice.afterToolCallId, notice.text);
  }
  if (pending.size === 0) return messages;

  const rendered: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    rendered.push(msg);
    if (msg?.role !== 'tool' || msg.toolCallId == null || msg.toolCallId === '') continue;
    const text = pending.get(msg.toolCallId);
    if (text == null) continue;
    pending.delete(msg.toolCallId);
    if (isSameNoticeMessage(messages[i + 1], text)) continue;
    rendered.push({ role: 'user', content: wrapNotice(text) });
  }
  for (const anchor of pending.keys()) {
    harnessLog('warn', `[no-progress] notice anchor not found in rendered messages: toolCallId=${anchor}`);
  }
  return rendered;
}

/** 提醒渲染后的消息文本（`addSystemMessage` 同款包裹，便于模型区分系统注入）。 */
export function wrapNotice(text: string): string {
  return `<system-notice>\n${text}\n</system-notice>`;
}

function isSameNoticeMessage(message: ChatMessage | undefined, text: string): boolean {
  return message != null && message.role === 'user' && typeof message.content === 'string'
    && message.content === wrapNotice(text);
}

/** 只收紧跟在这条 assistant 消息后、连续排列的 tool 消息（按 tool_call_id 建索引）。 */
function collectContiguousToolMessages(messages: ChatMessage[], start: number): Map<string, ChatMessage> {
  const toolMessages = new Map<string, ChatMessage>();
  for (let i = start; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== 'tool') break;
    if (msg.toolCallId != null && msg.toolCallId !== '') toolMessages.set(msg.toolCallId, msg);
  }
  return toolMessages;
}

/**
 * 把一轮 tool calls 归一化成签名输入。
 * 返回 null 表示本轮不完整（有调用缺 tool 输出），整轮跳过且不改变 streak。
 * 锚点取本轮最后一个 tool_call_id（与非豁免调用无关），与执行循环传入的锚点同口径。
 */
function buildRoundCalls(
  toolCalls: NonNullable<ChatMessage['toolCalls']>,
  toolMessages: Map<string, ChatMessage>,
  attachments?: Map<string, ToolAttachment> | null,
): { calls: NoProgressCall[]; toolNames: string[]; anchorToolCallId: string } | null {
  const calls: NoProgressCall[] = [];
  const toolNames: string[] = [];
  let anchorToolCallId = '';
  for (const toolCall of toolCalls) {
    const id = toolCall.id ?? '';
    const toolMessage = id !== '' ? toolMessages.get(id) : undefined;
    if (toolMessage == null) return null;
    const call: NoProgressCall = {
      toolName: toolCall.function?.name ?? '',
      argumentsJson: toolCall.function?.arguments ?? '',
      resultContent: typeof toolMessage.content === 'string' ? toolMessage.content : '',
      attachment: attachments?.get(id) ?? null,
    };
    anchorToolCallId = id;
    if (isNoProgressExempt(call)) continue;
    calls.push(call);
    toolNames.push(call.toolName);
  }
  return { calls, toolNames, anchorToolCallId };
}

function normalizeResult(toolName: string, content: string): string {
  const parsed = parseJson(content);
  if (toolName === 'shell') {
    if (parsed.ok && isPlainObject(parsed.value)) {
      const node = parsed.value;
      const picked: Record<string, unknown> = {};
      for (const key of SHELL_SEMANTIC_KEYS) {
        if (key in node) picked[key] = node[key];
      }
      return stableStringify(picked);
    }
    return trimTrailingWhitespace(content);
  }
  if (parsed.ok) return stableStringify(stripVolatile(parsed.value));
  return trimTrailingWhitespace(content);
}

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (VOLATILE_RESULT_KEYS.has(key)) continue;
      out[key] = stripVolatile(item);
    }
    return out;
  }
  return value;
}

/** 递归按键名排序的稳定序列化；数组保持顺序。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 'null' : serialized;
}

/** 取 sha256 前 16 位十六进制（日志比对与摘要用）。 */
export function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function trimTrailingWhitespace(text: string): string {
  return text.replace(/\s+$/, '');
}

function isShellWaitAction(argumentsJson: string): boolean {
  const parsed = parseJson(argumentsJson ?? '');
  if (!parsed.ok || !isPlainObject(parsed.value)) return false;
  const action = parsed.value.action;
  return action === 'await_async' || action === 'write_stdin';
}

function isIncompleteShellResult(resultContent: string): boolean {
  const parsed = parseJson(resultContent ?? '');
  if (!parsed.ok || !isPlainObject(parsed.value)) return false;
  return parsed.value.completed === false;
}

function isTimedOutResult(resultContent: string): boolean {
  const parsed = parseJson(resultContent ?? '');
  if (!parsed.ok || !isPlainObject(parsed.value)) return false;
  return parsed.value.timedOut === true || parsed.value.timed_out === true;
}
