import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { Db } from '../db/db.js';
import { FEEDBACK_REASONS, FeedbackRepository, type FeedbackReason } from './feedback.repository.js';

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
}

export interface FeedbackSummary {
  total: number;
  byReason: Array<{ reason: string; label: string; count: number }>;
  byDay: Array<{ date: string; count: number }>;
}export interface FeedbackDetailItem {
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
};

export class FeedbackService {
  constructor(
    private readonly repository: FeedbackRepository,
    private readonly messageLookup: FeedbackMessageLookup,
    private readonly sessionOwnerLookup: (sessionId: number) => Promise<number | null>,
  ) {}

  async dislike(userId: number, messageId: number, reason: string): Promise<void> {
    assertReason(reason);
    const ownership = await this.requireOwnedAssistantMessage(userId, messageId);
    await this.repository.upsert(messageId, ownership.sessionId, ownership.userId, ownership.agentId, reason as FeedbackReason);
  }

  async cancelDislike(userId: number, messageId: number): Promise<void> {
    await this.requireOwnedAssistantMessage(userId, messageId);
    await this.repository.deleteByMessageId(messageId);
  }

  /** 当前用户在指定会话内已点踩的消息 ID 列表（用于前端回显）；会话不存在或非本人会话返回空 */
  async listDislikedMessageIds(userId: number, sessionId: number): Promise<number[]> {
    const owner = await this.sessionOwnerLookup(sessionId);
    if (owner == null || owner !== userId) return [];
    return this.repository.listMessageIdsBySession(sessionId);
  }

  async getSummary(startDate?: string, endDate?: string): Promise<FeedbackSummary> {
    const [byReasonRows, byDay] = await Promise.all([
      this.repository.sumByReason(startDate, endDate),
      startDate && endDate ? this.repository.sumByDay(startDate, endDate) : Promise.resolve([]),
    ]);
    const byReasonMap = new Map(byReasonRows.map((r) => [r.reason, r.count]));
    const byReason = FEEDBACK_REASONS.map((reason) => ({
      reason,
      label: REASON_LABELS[reason],
      count: byReasonMap.get(reason) ?? 0,
    }));
    const total = byReason.reduce((sum, r) => sum + r.count, 0);
    return { total, byReason, byDay };
  }

  async listDetails(filter: { reason?: string; startDate?: string; endDate?: string; page: number; pageSize: number }): Promise<FeedbackDetailPage> {
    if (filter.reason && !FEEDBACK_REASONS.includes(filter.reason as FeedbackReason)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `无效的点踩原因: ${filter.reason}`);
    }
    const safePage = Math.max(1, Math.floor(filter.page));
    const safePageSize = Math.min(100, Math.max(1, Math.floor(filter.pageSize)));
    const [total, rows] = await Promise.all([
      this.repository.countTotal(filter),
      this.repository.listDetails({
        reason: filter.reason,
        startDate: filter.startDate,
        endDate: filter.endDate,
        offset: (safePage - 1) * safePageSize,
        limit: safePageSize,
      }),
    ]);
    return {
      total,
      items: rows.map((row) => ({
        ...row,
        reasonLabel: REASON_LABELS[row.reason] ?? row.reason,
        contentPreview: row.contentPreview == null ? null : buildPreview(row.contentPreview),
      })),
    };
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

function assertReason(reason: string): void {
  if (!FEEDBACK_REASONS.includes(reason as FeedbackReason)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `无效的点踩原因: ${reason}`);
  }
}
