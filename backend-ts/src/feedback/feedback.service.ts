import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { Db } from '../db/db.js';
import {
  FEEDBACK_REASONS, FEEDBACK_STATUSES, FEISHU_DISLIKE_REASON,
  FeedbackRepository, type FeedbackReason, type FeedbackSource, type FeedbackStatus,
} from './feedback.repository.js';

/** 明细摘要长度：取消息内容前 100 字符（按字符截断，避免多字节截半） */
const PREVIEW_MAX_CHARS = 100;

export interface MessageOwnership {
  messageId: number;
  sessionId: number;
  userId: number;
  agentId: number | null;
}

export interface FeedbackMessageLookup {
  /** 查询消息归属（会话 user/agent），不存在返回 null；role 非 ASSISTANT 也返回 null */
  findAssistantMessageOwner(messageId: number): Promise<MessageOwnership | null>;
  /** 查询会话内最后一条 ASSISTANT 消息 ID（与 getLatestAssistantReply 同源口径），不存在返回 null */
  findLatestAssistantMessageId(sessionId: number): Promise<number | null>;
}

export class FeedbackDbLookup implements FeedbackMessageLookup {
  constructor(private readonly db: Db) {}

  async findAssistantMessageOwner(messageId: number): Promise<MessageOwnership | null> {
    // 注意：db.query/queryOne 返回的行键为 camelCase（内部经 toCamelList 转换）
    const row = await this.db.queryOne<{ sessionId: number; userId: number; agentId: number }>(
      `SELECT s.id AS session_id, s.user_id, s.agent_id
       FROM message m
       INNER JOIN session s ON s.id = m.session_id AND s.deleted = 0
       WHERE m.id = ? AND m.role = 'ASSISTANT' AND m.deleted = 0`,
      [messageId],
    );
    if (!row) return null;
    return { messageId, sessionId: row.sessionId, userId: row.userId, agentId: row.agentId };
  }

  async findLatestAssistantMessageId(sessionId: number): Promise<number | null> {
    // 只认有文本内容的 ASSISTANT 消息：流式执行期间会产生大量只有 tool_calls、content 为空的
    // 中间消息，点踩落到它们身上会让后台预览恒为空、反馈对象也错位（本轮 vs 上一轮结果）。
    const row = await this.db.queryOne<{ id: number }>(
      `SELECT id FROM message
       WHERE session_id = ? AND role = 'ASSISTANT' AND deleted = 0
         AND content IS NOT NULL AND TRIM(content) <> ''
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [sessionId],
    );
    return row == null ? null : Number(row.id);
  }
}

export interface FeedbackSummary {
  total: number;
  byReason: Array<{ reason: string; label: string; count: number }>;
  byDay: Array<{ date: string; count: number }>;
  /** 待处理反馈数（status=PENDING）：汇总卡与明细筛选同口径。 */
  pendingCount: number;
  /** Agent × 原因 待处理矩阵（快照口径）。 */
  pendingMatrix: Array<{ agentId: number | null; agentName: string | null; reason: string; reasonLabel: string; count: number }>;
}

export interface FeedbackDetailItem {
  id: number;
  messageId: number;
  sessionId: number;
  userId: number;
  username: string | null;
  displayName: string | null;
  agentId: number | null;
  agentName: string | null;
  reason: FeedbackReason;
  reasonLabel: string;
  source: FeedbackSource;
  status: FeedbackStatus;
  handledBy: number | null;
  handledByName: string | null;
  handledAt: string | null;
  experienceId: number | null;
  sameGroupCount: number;
  /** 被点踩消息是否仍存在；false 时前端显示「消息已不存在」 */
  messageExists: boolean;
  contentPreview: string | null;
  createdAt: string;
}

export interface FeedbackDetailPage {
  total: number;
  items: FeedbackDetailItem[];
}

export const REASON_LABELS: Record<FeedbackReason, string> = {
  WRONG_RESULT: '结果错误',
  SLOW_RESPONSE: '处理速度慢',
  NOT_SOLVED: '问题未解决',
  OTHER: '其他',
  NO_REASON: '未选择原因（飞书）',
};

export class FeedbackService {
  /** 批量操作（dismiss）的 id 上限：与仓储 IN 列表规模匹配，超长请求直接拒绝。 */
  static readonly MAX_BATCH_IDS = 100;

  constructor(
    private readonly repository: FeedbackRepository,
    private readonly messageLookup: FeedbackMessageLookup,
    private readonly sessionOwnerLookup: (sessionId: number) => Promise<number | null>,
    /** 冗余统计字段：取会话使用的 Agent，读不到时写 null */
    private readonly sessionAgentLookup: (sessionId: number) => Promise<number | null> = async () => null,
    /** 事务内回写反馈状态用的连接来源（db.transaction 把连接包成新 Db 传回调）。 */
    private readonly db: Db | null = null,
  ) {}

  async dislike(userId: number, messageId: number, reason: string, source: FeedbackSource = 'desktop'): Promise<void> {
    assertReason(reason);
    const ownership = await this.requireOwnedAssistantMessage(userId, messageId);
    await this.repository.upsert(messageId, ownership.sessionId, ownership.userId, ownership.agentId, reason as FeedbackReason, source);
  }

  async cancelDislike(userId: number, messageId: number): Promise<void> {
    await this.requireOwnedAssistantMessage(userId, messageId);
    await this.repository.deleteByMessageId(messageId);
  }

  /**
   * 点踩 toggle（飞书进度卡点踩按钮）：有记录则删除、无记录则插入。返回 null 表示无可反馈的任务结果。
   * 状态以 message_feedback 表为准，进程重启后再次点击结果一致。
   * 判定不区分来源：同一条消息只保留一条反馈记录（桌面端与飞书共用 `uk_message(message_id)`），
   * 任一侧的新反馈会覆盖另一侧的旧记录——与桌面端「已点踩可重新选择原因」的覆盖语义一致。
   *
   * @param messageId 被点卡片对应的 ASSISTANT 消息（快照表解析）。显式传入时跳过「取会话最新消息」，
   *                  并用 findAssistantMessageOwner 校验消息归属（role=ASSISTANT、未删、属于该会话）防串会话；
   *                  不传时按会话最后一条 ASSISTANT 消息（桌面链路与存量飞书卡的原有行为）。
   */
  async toggleSessionDislike(userId: number, sessionId: number, source: FeedbackSource = 'desktop', messageId?: number): Promise<{ disliked: boolean } | null> {
    let targetId: number;
    let owner: number;
    if (messageId != null) {
      const ownership = await this.messageLookup.findAssistantMessageOwner(messageId);
      if (ownership == null || ownership.sessionId !== sessionId) return null;
      targetId = messageId;
      owner = ownership.userId;
    } else {
      const sessionOwner = await this.sessionOwnerLookup(sessionId);
      if (sessionOwner == null) return null;
      const latestId = await this.messageLookup.findLatestAssistantMessageId(sessionId);
      if (latestId == null) return null;
      targetId = latestId;
      owner = sessionOwner;
    }
    const exists = await this.repository.existsByMessageId(targetId);
    if (exists) {
      await this.repository.deleteByMessageId(targetId);
      return { disliked: false };
    }
    const agentId = await this.sessionAgentLookup(sessionId);
    await this.repository.upsert(targetId, sessionId, owner, agentId, FEISHU_DISLIKE_REASON, source);
    return { disliked: true };
  }

  /**
   * 当前用户在指定会话内已点踩的消息 ID 列表（用于前端回显）。
   * 会话不存在与「非本人会话」必须分开：前者是资源问题，后者是权限问题，
   * 合并成空数组会让回显丢失时无法归因（也无法与「确实没有点踩」区分）。
   */
  async listDislikedMessageIds(userId: number, sessionId: number): Promise<number[]> {
    const owner = await this.sessionOwnerLookup(sessionId);
    if (owner == null) {
      throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
    }
    if (owner !== userId) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '无权访问该会话');
    }
    return this.repository.listMessageIdsBySession(sessionId);
  }

  async getSummary(startDate?: string, endDate?: string): Promise<FeedbackSummary> {
    // byReason / byDay / total 必须同口径：任一侧日期缺省时按开区间处理，
    // 不能让 byDay 单独退化成空数组（否则同一筛选下汇总卡与趋势图互相矛盾）。
    // pendingCount / pendingMatrix 是「待处理」视角，不带日期筛选：日期是给趋势图用的，
    // 待处理看的是当前积压，与管理员选的时间段无关。
    const [byReasonRows, byDay, pendingCount, pendingMatrixRows] = await Promise.all([
      this.repository.sumByReason(startDate, endDate),
      this.repository.sumByDay(startDate, endDate),
      this.repository.countPending(),
      this.repository.countPendingGroupBy(),
    ]);
    const byReasonMap = new Map(byReasonRows.map((r) => [r.reason, r.count]));
    const byReason = FEEDBACK_REASONS.map((reason) => ({
      reason,
      label: REASON_LABELS[reason],
      count: byReasonMap.get(reason) ?? 0,
    }));
    const total = byReason.reduce((sum, r) => sum + r.count, 0);
    const pendingMatrix = pendingMatrixRows.map((row) => ({
      agentId: row.agentId,
      agentName: row.agentName,
      reason: row.reason,
      reasonLabel: REASON_LABELS[row.reason as FeedbackReason] ?? row.reason,
      count: Number(row.count),
    }));
    return { total, byReason, byDay, pendingCount, pendingMatrix };
  }

  async listDetails(filter: {
    reason?: string;
    status?: string;
    agentId?: number | null;
    startDate?: string;
    endDate?: string;
    page: number;
    pageSize: number;
  }): Promise<FeedbackDetailPage> {
    if (filter.reason && !FEEDBACK_REASONS.includes(filter.reason as FeedbackReason)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `无效的点踩原因: ${filter.reason}`);
    }
    if (filter.status && !FEEDBACK_STATUSES.includes(filter.status as FeedbackStatus)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `无效的反馈状态: ${filter.status}`);
    }
    const safePage = Math.max(1, Math.floor(filter.page));
    const safePageSize = Math.min(100, Math.max(1, Math.floor(filter.pageSize)));
    const [total, rows] = await Promise.all([
      this.repository.countTotal(filter),
      this.repository.listDetails({
        reason: filter.reason,
        status: filter.status,
        agentId: filter.agentId,
        startDate: filter.startDate,
        endDate: filter.endDate,
        offset: (safePage - 1) * safePageSize,
        limit: safePageSize,
      }),
    ]);
    return {
      total,
      items: rows.map((row) => {
        const { content, toolSummary, toolCallCount, ...rest } = row;
        return {
          ...rest,
          reasonLabel: REASON_LABELS[row.reason] ?? row.reason,
          contentPreview: buildContentPreview(row.messageExists, content, toolSummary, toolCallCount),
        };
      }),
    };
  }

  /**
   * 忽略：置 DISMISSED 终态并记录处理人。「全或无」口径——批量里混入已处理行时
   * 整体失败并回滚，避免部分写入导致状态不一致。因此走事务：CAS 影响行数与
   * 传入数量不符即回滚。
   */
  async dismiss(operatorId: number, feedbackIds: number[]): Promise<{ updated: number }> {
    const ids = normalizeBatchIds(feedbackIds);
    if (this.db == null) {
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '反馈处理未装配数据库连接');
    }
    return this.db.transaction(async (tx) => {
      const feedbackRepo = new FeedbackRepository(tx);
      const updated = await feedbackRepo.markDismissed(ids, operatorId);
      if (updated !== ids.length) {
        throw new BusinessException(ErrorCode.FEEDBACK_ALREADY_HANDLED);
      }
      return { updated };
    });
  }

  private async requireOwnedAssistantMessage(userId: number, messageId: number): Promise<MessageOwnership> {
    const ownership = await this.messageLookup.findAssistantMessageOwner(messageId);
    if (!ownership) {
      throw new BusinessException(ErrorCode.MESSAGE_NOT_FOUND);
    }
    if (ownership.userId !== userId) {
      throw new BusinessException(ErrorCode.MESSAGE_ACCESS_DENIED);
    }
    return ownership;
  }
}

/** 摘要净化：剥离内部标记语法，压缩空白后按字符截断 */
export function buildPreview(raw: string): string {
  const stripped = raw
    .replace(/\$\{([^}]+)\}\$/g, '$1')
    .replace(/#\{([^}]+)\}#/g, '$1')
    .replace(/@\{([^}]+)\}@/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length <= PREVIEW_MAX_CHARS) return stripped;
  return `${stripped.slice(0, PREVIEW_MAX_CHARS)}…`;
}

/**
 * 明细预览：消息存在时优先正文，正文为空则回退首个工具调用摘要（工具调用中间消息）。
 * 返回 null 表示「没有可展示内容」——消息已删除，或既无正文也无工具调用，
 * 由前端按 messageExists 区分两种文案，不再把「无文本」误报成「消息已不存在」。
 */
export function buildContentPreview(
  messageExists: boolean,
  content: string | null,
  toolSummary: string | null,
  toolCallCount: number,
): string | null {
  if (!messageExists) return null;
  const text = content == null ? '' : buildPreview(content);
  if (text !== '') return text;
  const summary = toolSummary == null ? '' : toolSummary.replace(/\s+/g, ' ').trim();
  if (summary === '') return null;
  const more = toolCallCount > 1 ? ` 等 ${toolCallCount} 项工具调用` : '';
  return buildPreview(`[工具调用] ${summary}${more}`);
}

/**
 * 批量 id 归一化：去重、过滤非正整数、超上限拒绝。
 * 去重是必须的——前端多选与矩阵点击可能重复传同一个 id，IN 列表里的重复值会让
 * CAS 的 affectedRows 与「传入数量」对不上，把正常请求误判成并发冲突。
 */
function normalizeBatchIds(ids: number[]): number[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '反馈 ID 列表不能为空');
  }
  const unique: number[] = [];
  const seen = new Set<number>();
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '反馈 ID 无效');
    }
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  if (unique.length > FeedbackService.MAX_BATCH_IDS) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `单次最多处理 ${FeedbackService.MAX_BATCH_IDS} 条反馈`);
  }
  return unique;
}

function assertReason(reason: string): void {
  if (!FEEDBACK_REASONS.includes(reason as FeedbackReason)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `无效的点踩原因: ${reason}`);
  }
}
