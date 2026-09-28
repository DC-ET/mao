import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { Db } from '../db/db.js';
import {
  FEEDBACK_REASONS, FEISHU_DISLIKE_REASON,
  FeedbackRepository, type FeedbackReason, type FeedbackSource,
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
    const row = await this.db.queryOne<{ id: number }>(
      `SELECT id FROM message
       WHERE session_id = ? AND role = 'ASSISTANT' AND deleted = 0
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
  source: FeedbackSource;
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
  constructor(
    private readonly repository: FeedbackRepository,
    private readonly messageLookup: FeedbackMessageLookup,
    private readonly sessionOwnerLookup: (sessionId: number) => Promise<number | null>,
    /** 冗余统计字段：取会话使用的 Agent，读不到时写 null */
    private readonly sessionAgentLookup: (sessionId: number) => Promise<number | null> = async () => null,
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
   * 会话级点踩 toggle（飞书进度卡点踩按钮）：取会话归属用户与最后一条 ASSISTANT 消息，
   * 有记录则删除、无记录则插入。返回 null 表示无可反馈的任务结果（会话不存在/消息被清理）。
   * 状态以 message_feedback 表为准，进程重启后再次点击结果一致。
   * 判定不区分来源：同一条消息只保留一条反馈记录（桌面端与飞书共用 `uk_message(message_id)`），
   * 任一侧的新反馈会覆盖另一侧的旧记录——与桌面端「已点踩可重新选择原因」的覆盖语义一致。
   */
  async toggleSessionDislike(userId: number, sessionId: number, source: FeedbackSource = 'desktop'): Promise<{ disliked: boolean } | null> {
    const owner = await this.sessionOwnerLookup(sessionId);
    if (owner == null) return null;
    const messageId = await this.messageLookup.findLatestAssistantMessageId(sessionId);
    if (messageId == null) return null;
    const exists = await this.repository.existsByMessageId(messageId);
    if (exists) {
      await this.repository.deleteByMessageId(messageId);
      return { disliked: false };
    }
    const agentId = await this.sessionAgentLookup(sessionId);
    await this.repository.upsert(messageId, sessionId, owner, agentId, FEISHU_DISLIKE_REASON, source);
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
    const [byReasonRows, byDay] = await Promise.all([
      this.repository.sumByReason(startDate, endDate),
      this.repository.sumByDay(startDate, endDate),
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
