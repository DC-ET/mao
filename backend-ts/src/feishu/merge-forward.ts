import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type * as Lark from '@larksuiteoapi/node-sdk';
import { replaceMentionKeys } from './event-normalizer.js';
import { describeMessageText } from './message-detail.js';
import { botSenderLabel } from './message.service.js';

/** 飞书合并转发外壳的固定英文。只用于识别「日志里还没展开」，不拿它做入站分支。 */
export const FEISHU_MERGE_FORWARD_TEXT = 'Merged and Forwarded Message';

const MAX_DEPTH = 3;
const MAX_MESSAGES = 100;
const INLINE_LIMIT = 4000;

export function isUnexpandedMergeForwardText(content: string | null | undefined): boolean {
  return (content ?? '').trim() === FEISHU_MERGE_FORWARD_TEXT;
}

export interface ExpandMergeForwardOptions {
  /** 会话工作区；null 时超长只截断、不落盘。 */
  workspace: string | null;
  /** 批量把 open_id 解析成姓名。失败或缺失时摘录退回 open_id，不让整包失败。 */
  resolveUserNames?: (openIds: string[]) => Promise<Map<string, string>>;
}

interface RawItem {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  deleted?: boolean;
  upper_message_id?: string;
  sender?: { id?: string; sender_type?: string };
  body?: { content?: string };
  mentions?: unknown;
}

interface ForwardNode {
  messageId: string;
  msgType: string;
  createTime: string;
  deleted: boolean;
  senderId: string | null;
  senderType: string | null;
  content: Record<string, unknown>;
  mentions: Array<{ key?: string | null; name?: string | null }>;
  nested: ForwardNode[] | null;
  nestedTotal: number;
  unexpanded: 'depth' | 'cycle' | 'failed' | null;
}

interface LoadResult {
  nodes: ForwardNode[];
  total: number;
  skipped: number;
}

/**
 * 展开一条合并转发。成功返回摘录（超长时已截断并可能带全文路径）；
 * 拉不到子消息、无权限或网络失败返回 null，调用方保留固定英文。
 */
export async function expandFeishuMergeForward(
  client: Lark.Client,
  messageId: string,
  options: ExpandMergeForwardOptions,
): Promise<string | null> {
  const seen = new Set<string>();
  const loaded = await loadChildren(client, messageId, 1, seen, { left: MAX_MESSAGES });
  if (loaded == null) return null;
  const names = await lookupNames(messageId, loaded.nodes, options.resolveUserNames);
  const lines = renderNodes(loaded.nodes, loaded.total, '', names);
  if (loaded.skipped > 0) lines.push(`其余 ${loaded.skipped} 条未展开`);
  return spill(messageId, options.workspace, lines.join('\n'));
}

export interface FeishuQuotedLog {
  msgType?: string | null;
  content?: string | null;
  /** 已按群日志行拼好的 `[time] sender：content`。 */
  line: string;
}

/**
 * 引用预取。普通消息保持「日志优先，否则详情接口」。
 * 合并转发：日志已是摘录则直接用；仍是固定英文、日志未命中或私聊无日志时再展开。
 * 摘录本身已按 4000 字截断，不再走引用 500 字阈值，避免截掉末尾的全文路径。
 */
export async function resolveFeishuQuotedText(deps: {
  log: FeishuQuotedLog | null;
  fetchDetail: () => Promise<{ msgType: string; text: string } | null>;
  expand: (workspace: string | null) => Promise<string | null>;
  resolveWorkspace: () => Promise<string | null>;
  persist: (text: string) => Promise<string>;
}): Promise<string | null> {
  const log = deps.log;
  if (log != null && log.msgType !== 'merge_forward') return deps.persist(log.line);
  if (log != null && log.msgType === 'merge_forward' && !isUnexpandedMergeForwardText(log.content)) return log.line;
  if (log != null && log.msgType === 'merge_forward') {
    const excerpt = await deps.expand(await deps.resolveWorkspace());
    if (excerpt != null && excerpt.trim() !== '') return replaceQuotedBody(log.line, log.content, excerpt);
    return deps.persist(log.line);
  }
  const detail = await deps.fetchDetail();
  if (detail == null) return null;
  if (detail.msgType !== 'merge_forward') return deps.persist(detail.text);
  const excerpt = await deps.expand(await deps.resolveWorkspace());
  if (excerpt != null && excerpt.trim() !== '') return excerpt;
  return deps.persist(detail.text);
}

async function loadChildren(
  client: Lark.Client,
  messageId: string,
  depth: number,
  seen: Set<string>,
  budget: { left: number },
): Promise<LoadResult | null> {
  if (seen.has(messageId)) return { nodes: [], total: 0, skipped: 0 };
  seen.add(messageId);
  const items = await fetchItems(client, messageId);
  if (items == null) return null;
  const children = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.upper_message_id === messageId && item.message_id != null && item.message_id !== '')
    .sort((a, b) => {
      const delta = timeValue(a.item.create_time) - timeValue(b.item.create_time);
      return delta !== 0 ? delta : a.index - b.index;
    });
  if (children.length === 0) {
    console.warn(`展开飞书合并转发失败, messageId=${messageId}, code=0`);
    return null;
  }
  const nodes: ForwardNode[] = [];
  let skipped = 0;
  for (const { item } of children) {
    if (budget.left <= 0) {
      skipped += 1;
      continue;
    }
    budget.left -= 1;
    const node = toNode(item);
    if (!node.deleted && node.msgType === 'merge_forward') {
      if (depth >= MAX_DEPTH) {
        node.unexpanded = 'depth';
      } else if (seen.has(node.messageId)) {
        node.unexpanded = 'cycle';
      } else {
        const nested = await loadChildren(client, node.messageId, depth + 1, seen, budget);
        // 嵌套包失败只降级这一层，外层已经取到的原文继续渲染。
        if (nested == null) {
          node.unexpanded = 'failed';
        } else {
          node.nested = nested.nodes;
          node.nestedTotal = nested.total;
          skipped += nested.skipped;
        }
      }
    }
    nodes.push(node);
  }
  return { nodes, total: children.length, skipped };
}

async function fetchItems(client: Lark.Client, messageId: string): Promise<RawItem[] | null> {
  try {
    const response = await client.request<{ code?: number; msg?: string; data?: { items?: RawItem[] } }>({
      url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      method: 'GET',
      params: { card_msg_content_type: 'user_card_content' },
    });
    const code = Number(response.code ?? 0);
    if (code !== 0) {
      console.warn(`展开飞书合并转发失败, messageId=${messageId}, code=${code}`);
      return null;
    }
    return response.data?.items ?? [];
  } catch (error) {
    console.warn(`展开飞书合并转发失败, messageId=${messageId}, code=${feishuErrorCode(error)}`);
    return null;
  }
}

function toNode(item: RawItem): ForwardNode {
  return {
    messageId: item.message_id ?? '',
    msgType: item.msg_type ?? 'text',
    createTime: item.create_time ?? '',
    deleted: item.deleted === true,
    senderId: item.sender?.id ?? null,
    senderType: item.sender?.sender_type ?? null,
    content: parseContent(item.body?.content),
    mentions: parseMentions(item.mentions),
    nested: null,
    nestedTotal: 0,
    unexpanded: null,
  };
}

function renderNodes(nodes: ForwardNode[], total: number, indent: string, names: Map<string, string>): string[] {
  const lines = [`${indent}【合并转发，共 ${total} 条】`];
  for (const node of nodes) {
    const prefix = `${indent}[${formatFeishuMessageTime(node.createTime)}] ${displayName(node, names)}：`;
    if (node.deleted) {
      lines.push(`${prefix}（已撤回）`);
      continue;
    }
    if (node.msgType === 'merge_forward') {
      if (node.unexpanded === 'depth') {
        lines.push(`${prefix}（嵌套合并转发超过 3 层，未展开）`);
        continue;
      }
      if (node.unexpanded === 'cycle') {
        lines.push(`${prefix}（重复的合并转发，未再次展开）`);
        continue;
      }
      if (node.unexpanded === 'failed') {
        lines.push(`${prefix}（嵌套合并转发展开失败）`);
        continue;
      }
      lines.push(prefix);
      if (node.nested != null) lines.push(...renderNodes(node.nested, node.nestedTotal, `${indent}  `, names));
      continue;
    }
    const body = replaceMentionKeys(describeMessageText(node.msgType, node.content, node.messageId), node.mentions);
    lines.push(`${prefix}${body}`);
  }
  return lines;
}

function displayName(node: ForwardNode, names: Map<string, string>): string {
  const type = (node.senderType ?? '').trim().toLowerCase();
  if (type === 'anonymous') return '匿名';
  if (type === 'app' || type === 'bot') return botSenderLabel(node.senderId);
  if (node.senderId == null || node.senderId === '') return '未知';
  if (type === 'user' || type === '') return names.get(node.senderId) ?? node.senderId;
  return names.get(node.senderId) ?? node.senderId;
}

async function lookupNames(
  messageId: string,
  nodes: ForwardNode[],
  resolveUserNames: ExpandMergeForwardOptions['resolveUserNames'],
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  collectUserIds(nodes, ids);
  if (ids.size === 0 || resolveUserNames == null) return new Map();
  try {
    return await resolveUserNames([...ids]);
  } catch (error) {
    console.warn(`展开飞书合并转发时解析发送人姓名失败, messageId=${messageId}: ${error instanceof Error ? error.message : String(error)}`);
    return new Map();
  }
}

function collectUserIds(nodes: ForwardNode[], ids: Set<string>): void {
  for (const node of nodes) {
    const type = (node.senderType ?? '').trim().toLowerCase();
    if ((type === 'user' || type === '') && node.senderId != null && node.senderId !== '') ids.add(node.senderId);
    if (node.nested != null) collectUserIds(node.nested, ids);
  }
}

async function spill(messageId: string, workspace: string | null, full: string): Promise<string> {
  if (full.length <= INLINE_LIMIT) return full;
  const path = workspace != null && workspace !== '' ? await writeMergeForwardFile(workspace, messageId, full) : null;
  if (path != null) return `${full.slice(0, INLINE_LIMIT)}\n全文见 @{${path}}@`;
  return `${full.slice(0, INLINE_LIMIT)}（其余已截断）`;
}

async function writeMergeForwardFile(workspace: string, messageId: string, content: string): Promise<string | null> {
  try {
    const dir = join(workspace, 'quoted');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `merge-forward-${safeMessageId(messageId)}.txt`);
    await writeFile(path, content, 'utf8');
    return path;
  } catch (error) {
    console.warn(`合并转发全文落盘失败, messageId=${messageId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function safeMessageId(messageId: string): string {
  const cleaned = messageId.replace(/[^\w.-]/g, '_');
  return cleaned === '' ? 'unknown' : cleaned;
}

/** create_time 为毫秒时间戳，格式与群日志行一致：YYYY-MM-DD HH:mm（Asia/Shanghai）。 */
export function formatFeishuMessageTime(createTime: string | null | undefined): string {
  if (createTime == null || createTime === '') return '--:--';
  const ms = Number(createTime);
  if (!Number.isFinite(ms)) return '--:--';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  const hour = pick('hour');
  const minute = pick('minute');
  if (year === '' || month === '' || day === '' || hour === '' || minute === '') return '--:--';
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function replaceQuotedBody(line: string, previous: string | null | undefined, next: string): string {
  const prev = previous ?? '';
  if (prev !== '' && line.endsWith(prev)) return `${line.slice(0, line.length - prev.length)}${next}`;
  return next;
}

function timeValue(createTime: string | undefined): number {
  const value = Number(createTime);
  return Number.isFinite(value) ? value : 0;
}

function parseContent(raw: string | undefined): Record<string, unknown> {
  if (raw == null || raw === '') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseMentions(value: unknown): Array<{ key?: string | null; name?: string | null }> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = item != null && typeof item === 'object' ? item as Record<string, unknown> : {};
    return {
      key: typeof record.key === 'string' ? record.key : null,
      name: typeof record.name === 'string' ? record.name : null,
    };
  });
}

function feishuErrorCode(error: unknown): string {
  if (error != null && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.code === 'number' || typeof record.code === 'string') return String(record.code);
    const response = record.response;
    if (response != null && typeof response === 'object') {
      const nested = response as Record<string, unknown>;
      const code = nested.code ?? (nested.data as Record<string, unknown> | undefined)?.code;
      if (typeof code === 'number' || typeof code === 'string') return String(code);
    }
  }
  return 'unknown';
}
