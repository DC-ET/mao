import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { Db } from '../db/db.js';
import { normalizeExperienceContent } from '../agent/agent-experience.service.js';
import type { AgentExperienceRepository } from '../agent/types.js';
import { MysqlAgentExperienceRepository } from '../agent/agent.repository.js';
import type { RunTraceService } from '../session/run-trace.service.js';
import { stripCitationMarkers } from '../session/util/citation-markers.js';
import { truncateStoredText, DRAFT_LIMITS, serializeRunTrace, type DraftMaterial } from './experience-draft.service.js';
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
  /** 取消息正文（转经验原料：被点踩的回复原文），不存在返回 null */
  findMessageContent(messageId: number): Promise<string | null>;
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

  async findMessageContent(messageId: number): Promise<string | null> {
    const row = await this.db.queryOne<{ content: string | null }>(
      'SELECT content FROM message WHERE id = ? AND deleted = 0',
      [messageId],
    );
    return row?.content ?? null;
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
  /** 批量操作（convert / dismiss）的 id 上限：与仓储 IN 列表规模匹配，超长请求直接拒绝。 */
  static readonly MAX_BATCH_IDS = 100;

  constructor(
    private readonly repository: FeedbackRepository,
    private readonly messageLookup: FeedbackMessageLookup,
    private readonly sessionOwnerLookup: (sessionId: number) => Promise<number | null>,
    /** 冗余统计字段：取会话使用的 Agent，读不到时写 null */
    private readonly sessionAgentLookup: (sessionId: number) => Promise<number | null> = async () => null,
    /** 事务内写经验用的连接来源（db.transaction 把连接包成新 Db 传回调）。 */
    private readonly db: Db | null = null,
    /** 轨迹定位：转经验向导的原料来源（技术方案 §5.3）。 */
    private readonly runTraceService: RunTraceService | null = null,
    /** 目标 Agent 存在性校验（仓储直接查 agent 表）。 */
    private readonly agentExistsLookup: (agentId: number) => Promise<boolean> = async () => false,
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
      items: rows.map((row) => ({
        ...row,
        reasonLabel: REASON_LABELS[row.reason] ?? row.reason,
        contentPreview: row.contentPreview == null ? null : buildPreview(row.contentPreview),
      })),
    };
  }

  /**
   * 转经验：写经验与回写反馈状态严格同事务（技术方案 §5.2）。
   *
   * 事务外预校验（反馈存在且仍为 PENDING、目标 Agent 存在、条数 1~2）先失败先返回，
   * 不开无谓事务；事务内第一行 CAS 抢占，影响行数与传入数量不等即回滚抛
   * FEEDBACK_ALREADY_HANDLED——并发下只有一个管理员能写入。
   */
  async convertToExperience(
    operatorId: number,
    input: { feedbackIds: number[]; agentId: number; experiences: Array<{ content: string; sortOrder?: number }> },
  ): Promise<{ experienceId: number }> {
    const feedbackIds = normalizeBatchIds(input.feedbackIds);
    if (!Number.isSafeInteger(input.agentId) || input.agentId <= 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '目标 Agent 无效');
    }
    if (input.experiences.length === 0 || input.experiences.length > DRAFT_LIMITS.MAX_EXPERIENCES) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `经验条数必须为 1～${DRAFT_LIMITS.MAX_EXPERIENCES} 条`);
    }
    if (this.db == null) {
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '反馈处理未装配数据库连接');
    }
    // 预校验一：目标 Agent 必须存在（已删 / 快照过期的 Agent 不允许写入）
    if (!(await this.agentExistsLookup(input.agentId))) {
      throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
    }
    // 预校验二：全部反馈行存在且仍为 PENDING。混入已处理行时整体失败，不做部分写入。
    // 「id 不存在」与「已被处理」分开报：前者是请求过期/传错（提示刷新重查），后者是并发抢占
    // （提示被别人处理了）——同一个错误码会让前端文案无法两全。
    const rows = await this.repository.listByIds(feedbackIds);
    if (rows.length !== feedbackIds.length) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '部分反馈记录不存在');
    }
    const handled = rows.filter((row) => row.status !== 'PENDING');
    if (handled.length > 0) {
      throw new BusinessException(ErrorCode.FEEDBACK_ALREADY_HANDLED);
    }
    // 预校验三：内容在事务外先过一遍共享校验，超 300 字不进事务
    const contents = input.experiences.map((item) => normalizeExperienceContent(item.content));

    return this.db.transaction(async (tx) => {
      const feedbackRepo = new FeedbackRepository(tx);
      // 事务内必须用 tx 新建仓储：全局单例持有的是池连接，不在事务里
      const experienceRepo: AgentExperienceRepository = new MysqlAgentExperienceRepository(tx);
      const claimed = await feedbackRepo.casMarkConverted(feedbackIds, operatorId);
      if (claimed !== feedbackIds.length) {
        // 并发 convert / dismiss：CAS 影响行数不符，整体回滚
        throw new BusinessException(ErrorCode.FEEDBACK_ALREADY_HANDLED);
      }
      const ids: number[] = [];
      for (let i = 0; i < contents.length; i++) {
        ids.push(await experienceRepo.insert({
          agentId: input.agentId,
          content: contents[i],
          sortOrder: input.experiences[i].sortOrder ?? i,
          enabled: 1,
        }));
      }
      // 一次转换写多条时 experience_id 只记第一条（单值列，不做 JSON）
      await feedbackRepo.bindExperience(feedbackIds, ids[0], operatorId);
      return { experienceId: ids[0] };
    });
  }

  /**
   * 忽略：置 DISMISSED 终态并记录处理人。与 convert 同为「全或无」口径——
   * 批量里混入已处理行时整体失败并回滚，避免部分写入导致状态不一致。
   * 因此也走事务：CAS 影响行数与传入数量不符即回滚。
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

  /**
   * 装配转经验的 LLM 原料：点踩原因 + 用户原话 + 被点踩回复 + 该消息所在 run 的工具轨迹。
   *
   * 轨迹一律走 locateRunByMessageId 精确定位：listBySession 默认 limit=50 且按 id DESC
   * 取最新，时隔多日点踩会取错轮次（技术方案 §1.2 修正 2）。定位不到时该条反馈没有
   * 轨迹可用，仍以原因 + 对话原文起草（轨迹段给占位说明）。
   */
  /**
   * 转经验向导的原料入口：除原料外同时给出快照 agent_id，
   * 供路由在请求未显式指定目标 Agent 时回落（技术方案 §5.6「draft 接收可选 agentId」）。
   *
   * 快照口径：批量行的 agent_id 一致时取该值；不一致（混了不同 Agent 的点踩）时返回 null，
   * 让管理员在向导里显式选择，不猜一个默认目标。
   */
  async buildDraftContext(feedbackIds: number[]): Promise<{ materials: DraftMaterial[]; snapshotAgentId: number | null }> {
    const ids = normalizeBatchIds(feedbackIds);
    const rows = (await this.repository.listByIds(ids)).sort((a, b) => a.id - b.id);
    if (rows.length !== ids.length) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '部分反馈记录不存在');
    }
    const pending = rows.filter((row) => row.status !== 'PENDING');
    if (pending.length > 0) {
      throw new BusinessException(ErrorCode.FEEDBACK_ALREADY_HANDLED);
    }
    if (this.runTraceService == null) {
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '反馈处理未装配轨迹服务');
    }
    const agentIds = new Set(rows.map((row) => row.agentId));
    const snapshotAgentId = agentIds.size === 1 ? rows[0].agentId : null;
    const materials: DraftMaterial[] = [];
    for (const row of rows) {
      const run = await this.runTraceService.locateRunByMessageId(row.sessionId, row.messageId);
      materials.push({
        reason: row.reason,
        reasonLabel: REASON_LABELS[row.reason] ?? row.reason,
        messageId: row.messageId,
        userText: truncateStoredText(run?.userMessagePreview ?? null, DRAFT_LIMITS.MAX_USER_TEXT_CHARS),
        assistantText: await this.loadAssistantText(row.messageId),
        traceText: run == null ? '（该消息的运行轨迹不可用）' : serializeRunTrace(run),
      });
    }
    return { materials, snapshotAgentId };
  }

  async buildDraftMaterials(feedbackIds: number[]): Promise<DraftMaterial[]> {
    const { materials } = await this.buildDraftContext(feedbackIds);
    return materials;
  }

  /** 被点踩回复正文：多模态分片只取文本部分，剥掉引用标记（[^n^] 只是渲染层约定，喂给 LLM 会被复述进经验），超长截断。 */
  private async loadAssistantText(messageId: number): Promise<string> {
    const message = await this.messageLookup.findMessageContent(messageId);
    return truncateStoredText(stripCitationMarkers(message ?? ''), DRAFT_LIMITS.MAX_ASSISTANT_TEXT_CHARS);
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
