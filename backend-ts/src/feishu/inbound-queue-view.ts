import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { clipByCodePoints } from '../common/utf8.js';
import type {
  FeishuInboundContext,
  FeishuInboundQueueCancelResult,
  FeishuInboundQueueItemVO,
  FeishuInboundQueueListItem,
  FeishuInboundQueueRow,
  FeishuInboundQueueViewPort,
  RunningChannel,
} from './types.js';

const SUMMARY_MAX = 60;
const FILE_REF_PATTERN = /@\{[^}]+\}@/g;
/** composePromptText 的段落标记（顺序即出现顺序）；取最后一个标记之后的内容作为用户正文。 */
const PROMPT_SECTION_MARKERS = ['【群内最近消息】\n', '【引用的消息】\n', '【用户消息】\n'];
const QUOTED_SECTION_MARKER = '【引用的消息】\n';
/** 群聊正文首行的发送者前缀（「杨佳毅：」），只剥第一处。 */
const SENDER_PREFIX_LINE = /^[^\n：]*：/;
const TERMINAL_PHASES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

/** 入队时写入的展示列（V210）。 */
export interface FeishuQueueViewColumns {
  summary: string | null;
  senderLabel: string | null;
  imageCount: number;
  fileCount: number;
}

/** 面板项的内部解析结果（不含位次与权限）。 */
interface ResolvedQueueViewItem {
  summary: string;
  senderLabel: string | null;
  imageCount: number;
  fileCount: number;
  createdAt: string | null;
}

/** 压缩连续空白：摘要展示单行，避免换行把面板行撑高。 */
function normalizeSummary(source: string): string {
  return source.replace(/\s+/g, ' ').trim();
}

/** 截断到 60 字（按 code point，emoji 不被切半），超长补省略号。 */
function clipSummary(source: string): string {
  return source.length > SUMMARY_MAX ? `${clipByCodePoints(source, SUMMARY_MAX)}…` : source;
}

function countFileRefs(source: string): number {
  return (source.match(FILE_REF_PATTERN) ?? []).length;
}

function textOfContentParts(parts: Array<Record<string, unknown>>): { text: string; imageCount: number } {
  const texts: string[] = [];
  let imageCount = 0;
  for (const part of parts) {
    if (part?.type === 'text' && part.text != null) texts.push(String(part.text));
    else if (part?.type === 'image_url') imageCount += 1;
  }
  return { text: texts.join('\n'), imageCount };
}

function senderLabelOf(context: { chatType?: string | null; senderLabel?: string | null }): string | null {
  // 与排队卡片同口径：只有群聊才展示发送者（私聊里「自己发的」没有信息量）。
  if (context.chatType !== 'group') return null;
  return context.senderLabel?.trim() || '飞书用户';
}

/** 空正文（无文字也无图片）的统一占位：与「payload 解析失败」区分开。 */
const EMPTY_SUMMARY = '[空消息]';

/**
 * 从 composePromptText 产物里还原「用户正文」。
 * - 群聊：结构是「群内最近消息 / 引用的消息 / 用户消息」三段，切到最后一个段标记之后，
 *   再剥首行发送者前缀（「杨佳毅：」）。**不按段内空行切**：用户自己写的多段落必须整体保留。
 * - 私聊：没有【用户消息】段；只有引用时取「【引用的消息】」段结束的空行之后，否则整段。
 */
function stripPromptSections(message: string, isGroup: boolean, quotedContext?: string | null): string {
  if (isGroup) {
    let start = 0;
    for (const marker of PROMPT_SECTION_MARKERS) {
      const idx = message.lastIndexOf(marker);
      if (idx >= 0 && idx + marker.length > start) start = idx + marker.length;
    }
    return message.slice(start).replace(SENDER_PREFIX_LINE, '');
  }
  // 私聊：优先按 payload 里保存的 quotedContext 精确定位引用段结束位置
  // （引用正文本身可能含空行，靠「第一个空行」切分会切进引用正文）。
  const quoted = quotedContext?.trim() ?? '';
  if (quoted !== '') {
    const idx = message.indexOf(quoted);
    if (idx >= 0) return message.slice(idx + quoted.length).replace(/^\n+/, '');
  }
  const quotedIdx = message.indexOf(QUOTED_SECTION_MARKER);
  if (quotedIdx >= 0) {
    const rest = message.slice(quotedIdx + QUOTED_SECTION_MARKER.length);
    const sep = rest.indexOf('\n\n');
    return sep >= 0 ? rest.slice(sep + 2) : rest;
  }
  return message;
}

/**
 * 入队时计算面板展示列：摘要取入站原文（`context.text`），图片/文件计数取构建后的消息与正文引用。
 * 与排队卡片 `buildFeishuQueueCard` 的差异是有意的：这里折叠空白，只承诺截断长度一致。
 */
export function buildQueueViewColumns(context: FeishuInboundContext, message: unknown): FeishuQueueViewColumns {
  const parts = Array.isArray(message) ? (message as Array<Record<string, unknown>>) : null;
  const fromParts = parts == null ? { text: '', imageCount: 0 } : textOfContentParts(parts);
  const rawText = (context.text ?? '').trim();
  const body = rawText !== '' ? rawText : fromParts.text;
  const normalized = normalizeSummary(body);
  const summary = normalized !== '' ? clipSummary(normalized) : (fromParts.imageCount > 0 ? '[图片]' : EMPTY_SUMMARY);
  return {
    summary,
    senderLabel: senderLabelOf(context),
    imageCount: fromParts.imageCount,
    // 文件引用只统计「构建后的消息」这一处事实源：composeContent 无论返回 string（无图片、
    // 引用拼在字符串末尾）还是 ContentPart[]（带图片），文件引用都在 message 里，context.text 里没有。
    fileCount: countFileRefs(stripPromptSections(
      typeof message === 'string' ? message : fromParts.text,
      context.chatType === 'group',
      context.quotedContext,
    )),
  };
}

/**
 * 存量行（V210 之前入队）回退解析：从 payload 还原展示字段。
 * 解析失败按占位文案处理，绝不抛错影响整个接口。
 */
export function parseQueuePayloadSummary(payload: string): {
  summary: string;
  senderLabel: string | null;
  imageCount: number;
  fileCount: number;
} {
  const fallback = { summary: '[无法解析的排队消息]', senderLabel: null, imageCount: 0, fileCount: 0 };
  let parsed: { message?: unknown; context?: Record<string, unknown> } | null = null;
  try {
    parsed = JSON.parse(payload) as { message?: unknown; context?: Record<string, unknown> };
  } catch {
    return fallback;
  }
  if (parsed == null || typeof parsed !== 'object') return fallback;
  const context = (parsed.context ?? {}) as {
    chatType?: string | null;
    senderLabel?: string | null;
    quotedContext?: string | null;
  };
  const message = parsed.message;
  let imageCount = 0;
  const isGroup = context.chatType === 'group';
  const partsText = Array.isArray(message)
    ? textOfContentParts(message as Array<Record<string, unknown>>)
    : null;
  const rawMessage = partsText != null ? partsText.text : (typeof message === 'string' ? message : '');
  if (partsText != null) imageCount = partsText.imageCount;
  const body = stripPromptSections(rawMessage, isGroup, context.quotedContext);
  const normalized = normalizeSummary(body);
  const summary = normalized !== '' ? clipSummary(normalized) : (imageCount > 0 ? '[图片]' : EMPTY_SUMMARY);
  return {
    summary,
    senderLabel: senderLabelOf(context),
    imageCount,
    // 与入队口径一致：文件引用只从构建后的消息里统计（单一事实源）。
    fileCount: countFileRefs(body),
  };
}

/** 取消权限：本人消息放行；发送者未绑定 mao 账号（maoUserId 为 null）时由会话 owner 放行。 */
export function canCancelQueueItem(maoUserId: number | null, viewerUserId: number): boolean {
  return maoUserId == null || maoUserId === viewerUserId;
}

/** 列表项 → 面板 VO（位次由列表顺序给出，不暴露内部 rank_no）。 */
export function toInboundQueueItemVO(
  id: number,
  item: ResolvedQueueViewItem,
  position: number,
  cancelable: boolean,
): FeishuInboundQueueItemVO {
  return {
    id: String(id),
    senderLabel: item.senderLabel ?? '',
    summary: item.summary,
    imageCount: item.imageCount,
    fileCount: item.fileCount,
    createdAt: item.createdAt,
    queuePosition: position,
    cancelable,
  };
}

/**
 * 当前执行来源解析：feishu=飞书在跑；local=WS/其他通道在跑；null=没有可归类的执行。
 * 终态 phase 直接归零，不依赖 busy 清理时序（complete 触发通知时 busy 可能还没释放）。
 */
export function createRunningChannelResolver(deps: {
  hasFeishuRunning: (sessionId: number) => boolean;
  hasLocalClaim: (sessionId: number) => boolean;
}): (sessionId: number, phase?: string | null) => RunningChannel {
  return (sessionId, phase) => {
    if (phase != null && TERMINAL_PHASES.has(phase)) return null;
    if (deps.hasFeishuRunning(sessionId)) return 'feishu';
    if (deps.hasLocalClaim(sessionId)) return 'local';
    return null;
  };
}

export interface FeishuInboundQueueViewDeps {
  repo: {
    listQueuedBySession(sessionId: number): Promise<FeishuInboundQueueListItem[]>;
    findById(id: number): Promise<FeishuInboundQueueRow | null>;
  };
  queue: {
    cancel(id: number): Promise<FeishuInboundQueueCancelResult>;
  };
  resolveRunningChannel: (sessionId: number, phase?: string | null) => RunningChannel;
  /** 与飞书卡片按钮取消同一份终态卡（不传会话详情 URL）；null 表示不可用。 */
  renderCancelledCard: () => Record<string, unknown> | null;
  /** PATCH 飞书卡片；失败由调用方吞掉，不影响响应结果。 */
  patchQueueCard: (botId: number, cardMessageId: string, card: Record<string, unknown>) => Promise<void>;
}

/**
 * web/桌面端 QueuePanel 的飞书排队视图：只读列表 + 受控取消。
 * 不持有写队列语义（入队/认领/收尾仍在 handler 与 service），避免两套状态机。
 */
export function createFeishuInboundQueueView(deps: FeishuInboundQueueViewDeps): FeishuInboundQueueViewPort {
  async function resolveItem(row: FeishuInboundQueueListItem): Promise<ResolvedQueueViewItem> {
    const base = {
      createdAt: row.createdAt ?? null,
      senderLabel: row.senderLabel ?? null,
      imageCount: row.imageCount ?? 0,
      fileCount: row.fileCount ?? 0,
    };
    if (row.summary != null) return { ...base, summary: row.summary };
    // 存量行：按 id 单查 payload 回退（只发生在老数据上，新行不读 MEDIUMTEXT）。
    const full = await deps.repo.findById(row.id).catch(() => null);
    if (full == null) return { ...base, summary: '[无法解析的排队消息]' };
    const parsed = parseQueuePayloadSummary(full.payload);
    return { ...base, ...parsed, createdAt: base.createdAt };
  }

  return {
    async list(session, viewerUserId) {
      const rows = await deps.repo.listQueuedBySession(session.id);
      const items: FeishuInboundQueueItemVO[] = [];
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]!;
        const resolved = await resolveItem(row);
        items.push(toInboundQueueItemVO(row.id, resolved, i + 1, canCancelQueueItem(row.maoUserId ?? null, viewerUserId)));
      }
      return {
        runningChannel: deps.resolveRunningChannel(session.id, session.phase ?? null),
        lastRunFailed: session.phase === 'FAILED',
        items,
      };
    },

    async cancel(session, queueId, userId) {
      const row = await deps.repo.findById(queueId);
      if (row == null) return 'NOT_FOUND';
      // 不属于该会话的行按不存在处理，不泄露其他会话的排队信息。
      if (row.sessionId !== session.id) return 'NOT_FOUND';
      if (!canCancelQueueItem(row.maoUserId ?? null, userId)) {
        throw new BusinessException(ErrorCode.FORBIDDEN, '仅消息发送者可操作');
      }
      const result = await deps.queue.cancel(queueId);
      if (result === 'CANCELLED') {
        // 卡片同步：与飞书按钮取消同一份终态卡；PATCH 失败只记日志（库内行已删，面板已收敛）。
        if (row.cardMessageId != null) {
          const card = deps.renderCancelledCard();
          if (card != null) {
            try {
              await deps.patchQueueCard(row.botId, row.cardMessageId, card);
            } catch (error) {
              console.warn(`飞书排队卡片终态 PATCH 失败（web 取消）, queueId=${queueId}, cardMessageId=${row.cardMessageId}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      }
      return result;
    },
  };
}
