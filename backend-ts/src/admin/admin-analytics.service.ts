import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import type { Agent, LlmModel, UserRow } from '../domain/types.js';
import { addDaysYmd, shanghaiYmd } from '../common/json.js';
import type { StatisticsService } from '../statistics/statistics.service.js';

/** 统计窗口：闭区间日期 + 半开时间区间 [startAt, endAtExclusive)，避免 23:59:59 边界丢数据。 */
export interface AnalyticsRange {
  days: number;
  startYmd: string;
  endYmd: string;
  startAt: string;
  endAtExclusive: string;
}

export interface DailySessionRow {
  day: string;
  count: number;
}

export interface DailyMessageRow {
  day: string;
  count: number;
  tokens: number;
}

export interface DailyUsageRow {
  day: string;
  totalTokens: number;
  callCount: number;
}

export interface PhaseCountRow {
  phase: string;
  count: number;
}

export interface GroupSessionRow {
  id: number;
  sessionCount: number;
}

export interface GroupMessageRow {
  id: number;
  messageCount: number;
  totalTokens: number;
}

export interface GroupUsageRow {
  id: number;
  totalTokens: number;
  callCount: number;
}

export interface NamedCountRow {
  key: string;
  count: number;
}

export interface AdminAnalyticsStore {
  selectDailySessionCounts(range: AnalyticsRange): Promise<DailySessionRow[]>;
  selectDailyMessageStats(range: AnalyticsRange): Promise<DailyMessageRow[]>;
  selectDailyUsageStats(range: AnalyticsRange): Promise<DailyUsageRow[]>;
  selectLivePhaseCounts(): Promise<PhaseCountRow[]>;
  selectPhaseCounts(range: AnalyticsRange): Promise<PhaseCountRow[]>;
  selectSessionCountsByAgent(range: AnalyticsRange): Promise<GroupSessionRow[]>;
  selectMessageStatsByAgent(range: AnalyticsRange): Promise<GroupMessageRow[]>;
  selectSessionCountsByUser(range: AnalyticsRange): Promise<GroupSessionRow[]>;
  selectMessageStatsByUser(range: AnalyticsRange): Promise<GroupMessageRow[]>;
  selectSessionCountsByModel(range: AnalyticsRange): Promise<GroupSessionRow[]>;
  selectMessageStatsByModel(range: AnalyticsRange): Promise<GroupMessageRow[]>;
  selectUsageStatsByModel(range: AnalyticsRange): Promise<GroupUsageRow[]>;
  selectSessionTypeCounts(range: AnalyticsRange): Promise<NamedCountRow[]>;
  selectExecutionModeCounts(range: AnalyticsRange): Promise<NamedCountRow[]>;
  countActiveUsers(range: AnalyticsRange): Promise<number>;
  countSessions(range: AnalyticsRange): Promise<number>;
  sumMessages(range: AnalyticsRange): Promise<{ count: number; tokens: number }>;
  sumUsageTokens(range: AnalyticsRange): Promise<number>;
  listAgents(): Promise<Agent[]>;
  listUsers(): Promise<UserRow[]>;
  listModelsOrderByCreatedDesc(): Promise<LlmModel[]>;
}

export class AdminAnalyticsDbStore implements AdminAnalyticsStore {
  constructor(private readonly db: Db) {}

  selectDailySessionCounts(range: AnalyticsRange): Promise<DailySessionRow[]> {
    return this.db.query(
      `SELECT DATE(created_at) AS day, COUNT(*) AS count
       FROM session
       WHERE created_at >= ? AND created_at < ? AND deleted = 0
       GROUP BY DATE(created_at)`,
      [range.startAt, range.endAtExclusive],
    );
  }

  selectDailyMessageStats(range: AnalyticsRange): Promise<DailyMessageRow[]> {
    return this.db.query(
      `SELECT DATE(created_at) AS day, COUNT(*) AS count, COALESCE(SUM(token_count), 0) AS tokens
       FROM message
       WHERE created_at >= ? AND created_at < ? AND deleted = 0
       GROUP BY DATE(created_at)`,
      [range.startAt, range.endAtExclusive],
    );
  }

  selectDailyUsageStats(range: AnalyticsRange): Promise<DailyUsageRow[]> {
    return this.db.query(
      `SELECT DATE(created_at) AS day, COALESCE(SUM(total_tokens), 0) AS totalTokens, COUNT(*) AS callCount
       FROM llm_usage
       WHERE created_at >= ? AND created_at < ?
       GROUP BY DATE(created_at)`,
      [range.startAt, range.endAtExclusive],
    );
  }

  selectLivePhaseCounts(): Promise<PhaseCountRow[]> {
    return this.db.query(
      `SELECT COALESCE(phase, 'IDLE') AS phase, COUNT(*) AS count
       FROM session WHERE deleted = 0 GROUP BY COALESCE(phase, 'IDLE')`,
    );
  }

  selectPhaseCounts(range: AnalyticsRange): Promise<PhaseCountRow[]> {
    return this.db.query(
      `SELECT COALESCE(phase, 'IDLE') AS phase, COUNT(*) AS count
       FROM session
       WHERE created_at >= ? AND created_at < ? AND deleted = 0
       GROUP BY COALESCE(phase, 'IDLE')`,
      [range.startAt, range.endAtExclusive],
    );
  }

  selectSessionCountsByAgent(range: AnalyticsRange): Promise<GroupSessionRow[]> {
    return this.db.query(
      `SELECT agent_id AS id, COUNT(*) AS sessionCount
       FROM session
       WHERE created_at >= ? AND created_at < ? AND deleted = 0
       GROUP BY agent_id`,
      [range.startAt, range.endAtExclusive],
    );
  }

  selectMessageStatsByAgent(range: AnalyticsRange): Promise<GroupMessageRow[]> {
    return this.db.query(
      `SELECT s.agent_id AS id, COUNT(m.id) AS messageCount, COALESCE(SUM(m.token_count), 0) AS totalTokens
       FROM message m JOIN session s ON m.session_id = s.id
       WHERE m.created_at >= ? AND m.created_at < ? AND m.deleted = 0 AND s.deleted = 0
       GROUP BY s.agent_id`,
      [range.startAt, range.endAtExclusive],
    );
  }

  selectSessionCountsByUser(range: AnalyticsRange): Promise<GroupSessionRow[]> {
    return this.db.query(
      `SELECT user_id AS id, COUNT(*) AS sessionCount
       FROM session
       WHERE created_at >= ? AND created_at < ? AND deleted = 0
       GROUP BY user_id`,
      [range.startAt, range.endAtExclusive],
    );
  }

  selectMessageStatsByUser(range: AnalyticsRange): Promise<GroupMessageRow[]> {
    return this.db.query(
      `SELECT s.user_id AS id, COUNT(m.id) AS messageCount, COALESCE(SUM(m.token_count), 0) AS totalTokens
       FROM message m JOIN session s ON m.session_id = s.id
       WHERE m.created_at >= ? AND m.created_at < ? AND m.deleted = 0 AND s.deleted = 0
       GROUP BY s.user_id`,
      [range.startAt, range.endAtExclusive],
    );
  }

  selectSessionCountsByModel(range: AnalyticsRange): Promise<GroupSessionRow[]> {
    return this.db.query(
      `SELECT model_id AS id, COUNT(*) AS sessionCount
       FROM session
       WHERE created_at >= ? AND created_at < ? AND model_id IS NOT NULL AND deleted = 0
       GROUP BY model_id`,
      [range.startAt, range.endAtExclusive],
    );
  }

  selectMessageStatsByModel(range: AnalyticsRange): Promise<GroupMessageRow[]> {
    return this.db.query(
      `SELECT model_id AS id, COUNT(*) AS messageCount, COALESCE(SUM(token_count), 0) AS totalTokens
       FROM message
       WHERE created_at >= ? AND created_at < ? AND model_id IS NOT NULL AND deleted = 0
       GROUP BY model_id`,
      [range.startAt, range.endAtExclusive],
    );
  }

  selectUsageStatsByModel(range: AnalyticsRange): Promise<GroupUsageRow[]> {
    return this.db.query(
      `SELECT model_id AS id, COALESCE(SUM(total_tokens), 0) AS totalTokens, COUNT(*) AS callCount
       FROM llm_usage
       WHERE created_at >= ? AND created_at < ?
       GROUP BY model_id`,
      [range.startAt, range.endAtExclusive],
    );
  }

  selectSessionTypeCounts(range: AnalyticsRange): Promise<NamedCountRow[]> {
    return this.db.query(
      `SELECT COALESCE(session_type, 'NORMAL') AS \`key\`, COUNT(*) AS count
       FROM session
       WHERE created_at >= ? AND created_at < ? AND deleted = 0
       GROUP BY COALESCE(session_type, 'NORMAL')`,
      [range.startAt, range.endAtExclusive],
    );
  }

  selectExecutionModeCounts(range: AnalyticsRange): Promise<NamedCountRow[]> {
    return this.db.query(
      `SELECT COALESCE(execution_mode, 'CLOUD') AS \`key\`, COUNT(*) AS count
       FROM session
       WHERE created_at >= ? AND created_at < ? AND deleted = 0
       GROUP BY COALESCE(execution_mode, 'CLOUD')`,
      [range.startAt, range.endAtExclusive],
    );
  }

  async countActiveUsers(range: AnalyticsRange): Promise<number> {
    const row = await this.db.queryOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM (
         SELECT user_id FROM session
          WHERE created_at >= ? AND created_at < ? AND deleted = 0
         UNION
         SELECT s.user_id FROM message m JOIN session s ON m.session_id = s.id
          WHERE m.created_at >= ? AND m.created_at < ? AND m.deleted = 0 AND s.deleted = 0
       ) t`,
      [range.startAt, range.endAtExclusive, range.startAt, range.endAtExclusive],
    );
    return Number(row?.c ?? 0);
  }

  async countSessions(range: AnalyticsRange): Promise<number> {
    const row = await this.db.queryOne<{ c: number }>(
      'SELECT COUNT(*) AS c FROM session WHERE created_at >= ? AND created_at < ? AND deleted = 0',
      [range.startAt, range.endAtExclusive],
    );
    return Number(row?.c ?? 0);
  }

  async sumMessages(range: AnalyticsRange): Promise<{ count: number; tokens: number }> {
    const row = await this.db.queryOne<{ count: number; tokens: number }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(token_count), 0) AS tokens
       FROM message WHERE created_at >= ? AND created_at < ? AND deleted = 0`,
      [range.startAt, range.endAtExclusive],
    );
    return { count: Number(row?.count ?? 0), tokens: Number(row?.tokens ?? 0) };
  }

  async sumUsageTokens(range: AnalyticsRange): Promise<number> {
    const row = await this.db.queryOne<{ tokens: number }>(
      'SELECT COALESCE(SUM(total_tokens), 0) AS tokens FROM llm_usage WHERE created_at >= ? AND created_at < ?',
      [range.startAt, range.endAtExclusive],
    );
    return Number(row?.tokens ?? 0);
  }

  listAgents(): Promise<Agent[]> {
    return this.db.query(`SELECT * FROM agent WHERE ${notDeleted()}`);
  }

  listUsers(): Promise<UserRow[]> {
    return this.db.query(`SELECT * FROM user WHERE ${notDeleted()}`);
  }

  listModelsOrderByCreatedDesc(): Promise<LlmModel[]> {
    return this.db.query(`SELECT * FROM llm_model WHERE ${notDeleted()} ORDER BY created_at DESC`);
  }
}

const PHASES = ['IDLE', 'RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'];
const RANK_LIMIT = 20;
const MAX_SCOPE_LIMIT = 100;

export interface AnalyticsPeriodMeta {
  days: number;
  start: string;
  end: string;
  previousStart: string;
  previousEnd: string;
}

export interface AnalyticsInsight {
  level: 'info' | 'warn';
  text: string;
  path?: string;
}

export class AdminAnalyticsService {
  constructor(
    private readonly statisticsService: StatisticsService,
    private readonly store: AdminAnalyticsStore,
  ) {}

  /**
   * 汇总统计窗口内的趋势、结构与环比；overview 中的阶段数是实时快照而非窗口内数据。
   * endOffset 将窗口结束日往前偏移 N 天（0=今日结尾，1=昨日结尾），用于「昨日」等固定日窗口。
   * @deprecated 管理后台已按 scope 拆分调用；本方法暂留给 mao-cli 与兼容路径。
   */
  async summary(days: number, endOffset = 0): Promise<Record<string, unknown>> {
    const { range, previous } = this.resolveWindows(days, endOffset);
    const safeDays = range.days;

    // 各分支互不依赖，并行取数：message 聚合单条就要数百毫秒，串行会把页面拖到秒级
    const [
      baseOverview,
      livePhaseRows,
      periodPhaseRows,
      trends,
      activeUsers,
      previousTotals,
      agentStats,
      userActivity,
      modelStats,
    ] = await Promise.all([
      this.statisticsService.getOverview(),
      this.store.selectLivePhaseCounts(),
      this.store.selectPhaseCounts(range),
      this.trends(range),
      this.store.countActiveUsers(range),
      this.previousTotals(previous),
      this.agentStats(range, RANK_LIMIT),
      this.userActivity(range, RANK_LIMIT),
      this.modelStats(range),
    ]);

    const livePhases = phaseMap(livePhaseRows);
    const periodPhases = phaseMap(periodPhaseRows);

    return {
      period: this.periodMeta(range, previous),
      overview: {
        ...baseOverview,
        runningSessions: livePhases.get('RUNNING') ?? 0,
        waitingSessions: livePhases.get('WAITING_APPROVAL') ?? 0,
        failedSessions: livePhases.get('FAILED') ?? 0,
        cancelledSessions: livePhases.get('CANCELLED') ?? 0,
      },
      periodTotals: {
        ...sumTrends(trends),
        activeUsers,
        completedSessions: periodPhases.get('COMPLETED') ?? 0,
        failedSessions: periodPhases.get('FAILED') ?? 0,
      },
      previousTotals,
      trends,
      phaseDistribution: PHASES.map((phase) => ({ phase, count: periodPhases.get(phase) ?? 0 })),
      agentStats,
      userActivity,
      modelStats,
      days: safeDays,
    };
  }

  /** 总览：运行态 + 窗口合计 + 环比 + Token spark + 规则洞察；不拉维度排行。 */
  async overview(days: number, endOffset = 0): Promise<Record<string, unknown>> {
    const { range, previous } = this.resolveWindows(days, endOffset);
    const [baseOverview, livePhaseRows, periodPhaseRows, trends, activeUsers, previousTotals] = await Promise.all([
      this.statisticsService.getOverview(),
      this.store.selectLivePhaseCounts(),
      this.store.selectPhaseCounts(range),
      this.trends(range),
      this.store.countActiveUsers(range),
      this.previousTotals(previous),
    ]);

    const livePhases = phaseMap(livePhaseRows);
    const periodPhases = phaseMap(periodPhaseRows);
    const periodTotals = {
      ...sumTrends(trends),
      activeUsers,
      completedSessions: periodPhases.get('COMPLETED') ?? 0,
      failedSessions: periodPhases.get('FAILED') ?? 0,
    };

    return {
      period: this.periodMeta(range, previous),
      overview: {
        ...baseOverview,
        runningSessions: livePhases.get('RUNNING') ?? 0,
        waitingSessions: livePhases.get('WAITING_APPROVAL') ?? 0,
        failedSessions: livePhases.get('FAILED') ?? 0,
        cancelledSessions: livePhases.get('CANCELLED') ?? 0,
      },
      periodTotals,
      previousTotals,
      spark: trends.map((row) => ({
        date: String(row.date),
        totalTokens: toNumber(row.totalTokens),
      })),
      phaseDistribution: PHASES.map((phase) => ({ phase, count: periodPhases.get(phase) ?? 0 })),
      insights: buildOverviewInsights(periodTotals, previousTotals),
    };
  }

  /** 趋势：日序列 + 窗口合计 + 环比。 */
  async trendsScope(days: number, endOffset = 0): Promise<Record<string, unknown>> {
    const { range, previous } = this.resolveWindows(days, endOffset);
    const [trends, activeUsers, previousTotals] = await Promise.all([
      this.trends(range),
      this.store.countActiveUsers(range),
      this.previousTotals(previous),
    ]);
    const periodPhases = phaseMap(await this.store.selectPhaseCounts(range));
    return {
      period: this.periodMeta(range, previous),
      trends,
      periodTotals: {
        ...sumTrends(trends),
        activeUsers,
        completedSessions: periodPhases.get('COMPLETED') ?? 0,
        failedSessions: periodPhases.get('FAILED') ?? 0,
      },
      previousTotals,
    };
  }

  /** 模型：窗口内有用量的模型聚合 + Token 合计。 */
  async modelsScope(days: number, endOffset = 0): Promise<Record<string, unknown>> {
    const { range, previous } = this.resolveWindows(days, endOffset);
    const [modelStats, previousTotals, trends] = await Promise.all([
      this.modelStats(range),
      this.previousTotals(previous),
      this.trends(range),
    ]);
    return {
      period: this.periodMeta(range, previous),
      modelStats,
      periodTotals: { totalTokens: sumTrends(trends).totalTokens },
      previousTotals,
    };
  }

  /** 用户：窗口内活跃用户排行/明细，默认 Top 20。 */
  async usersScope(days: number, endOffset = 0, limit = RANK_LIMIT): Promise<Record<string, unknown>> {
    const { range, previous } = this.resolveWindows(days, endOffset);
    const safeLimit = clampLimit(limit);
    const [userActivity, activeUsers, previousTotals] = await Promise.all([
      this.userActivity(range, safeLimit),
      this.store.countActiveUsers(range),
      this.previousTotals(previous),
    ]);
    return {
      period: this.periodMeta(range, previous),
      userActivity,
      periodTotals: { activeUsers },
      previousTotals,
    };
  }

  /** Agent：窗口内会话/消息/Token 排行，默认 Top 20。 */
  async agentsScope(days: number, endOffset = 0, limit = RANK_LIMIT): Promise<Record<string, unknown>> {
    const { range, previous } = this.resolveWindows(days, endOffset);
    const safeLimit = clampLimit(limit);
    const [agentStats, previousTotals] = await Promise.all([
      this.agentStats(range, safeLimit),
      this.previousTotals(previous),
    ]);
    return {
      period: this.periodMeta(range, previous),
      agentStats,
      previousTotals,
    };
  }

  /** 会话：窗口 phase 分布 + 类型/执行模式结构 + 实时运行态。 */
  async sessionsScope(days: number, endOffset = 0): Promise<Record<string, unknown>> {
    const { range, previous } = this.resolveWindows(days, endOffset);
    const [phaseRows, liveRows, typeRows, modeRows, activeUsers, previousTotals] = await Promise.all([
      this.store.selectPhaseCounts(range),
      this.store.selectLivePhaseCounts(),
      this.store.selectSessionTypeCounts(range),
      this.store.selectExecutionModeCounts(range),
      this.store.countActiveUsers(range),
      this.previousTotals(previous),
    ]);
    const periodPhases = phaseMap(phaseRows);
    const livePhases = phaseMap(liveRows);
    const completedSessions = periodPhases.get('COMPLETED') ?? 0;
    const failedSessions = periodPhases.get('FAILED') ?? 0;
    const sessions = [...periodPhases.values()].reduce((sum, count) => sum + count, 0);
    return {
      period: this.periodMeta(range, previous),
      phaseDistribution: PHASES.map((phase) => ({ phase, count: periodPhases.get(phase) ?? 0 })),
      sessionTypes: typeRows
        .filter((row) => toNumber(row.count) > 0)
        .map((row) => ({ sessionType: String(row.key), count: toNumber(row.count) })),
      executionModes: modeRows
        .filter((row) => toNumber(row.count) > 0)
        .map((row) => ({ executionMode: String(row.key), count: toNumber(row.count) })),
      livePhases: PHASES.map((phase) => ({ phase, count: livePhases.get(phase) ?? 0 })),
      periodTotals: { sessions, activeUsers, completedSessions, failedSessions },
      previousTotals,
    };
  }

  private resolveWindows(days: number, endOffset: number): { range: AnalyticsRange; previous: AnalyticsRange } {
    const safeDays = Math.max(1, Math.min(Math.trunc(days) || 1, 90));
    const safeOffset = Math.max(0, Math.min(Math.trunc(endOffset) || 0, 365));
    const range = buildRange(addDaysYmd(shanghaiYmd(), -safeOffset), safeDays);
    const previous = buildRange(addDaysYmd(range.startYmd, -1), safeDays);
    return { range, previous };
  }

  private periodMeta(range: AnalyticsRange, previous: AnalyticsRange): AnalyticsPeriodMeta {
    return {
      days: range.days,
      start: range.startYmd,
      end: range.endYmd,
      previousStart: previous.startYmd,
      previousEnd: previous.endYmd,
    };
  }

  private async trends(range: AnalyticsRange): Promise<Array<Record<string, unknown>>> {
    const [sessionRows, messageRows, usageRows] = await Promise.all([
      this.store.selectDailySessionCounts(range),
      this.store.selectDailyMessageStats(range),
      this.store.selectDailyUsageStats(range),
    ]);
    const sessions = dayMap(sessionRows, (r) => r.day, (r) => r.count);
    const messages = dayMap(messageRows, (r) => r.day, (r) => r.count);
    const chatTokens = dayMap(messageRows, (r) => r.day, (r) => r.tokens);
    const backgroundTokens = dayMap(usageRows, (r) => r.day, (r) => r.totalTokens);
    const backgroundCalls = dayMap(usageRows, (r) => r.day, (r) => r.callCount);

    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < range.days; i++) {
      const date = addDaysYmd(range.startYmd, i);
      const chat = chatTokens.get(date) ?? 0;
      const background = backgroundTokens.get(date) ?? 0;
      rows.push({
        date,
        sessions: sessions.get(date) ?? 0,
        messages: messages.get(date) ?? 0,
        chatTokens: chat,
        backgroundTokens: background,
        totalTokens: chat + background,
        backgroundCalls: backgroundCalls.get(date) ?? 0,
      });
    }
    return rows;
  }

  private async previousTotals(previous: AnalyticsRange): Promise<Record<string, number>> {
    const [sessions, messages, backgroundTokens, activeUsers] = await Promise.all([
      this.store.countSessions(previous),
      this.store.sumMessages(previous),
      this.store.sumUsageTokens(previous),
      this.store.countActiveUsers(previous),
    ]);
    return {
      sessions,
      messages: messages.count,
      chatTokens: messages.tokens,
      backgroundTokens,
      totalTokens: messages.tokens + backgroundTokens,
      activeUsers,
    };
  }

  private async agentStats(range: AnalyticsRange, limit = RANK_LIMIT): Promise<Array<Record<string, unknown>>> {
    const [agents, sessionRows, messageRows] = await Promise.all([
      this.store.listAgents(),
      this.store.selectSessionCountsByAgent(range),
      this.store.selectMessageStatsByAgent(range),
    ]);
    const names = new Map(agents.filter((a) => a.id != null).map((a) => [a.id!, a.name ?? '未知']));
    const sessionCounts = idMap(sessionRows, (r) => r.sessionCount);
    const messageCounts = idMap(messageRows, (r) => r.messageCount);
    const tokens = idMap(messageRows, (r) => r.totalTokens);
    const rows: Array<Record<string, unknown>> = [];
    for (const agentId of unionKeys(sessionCounts, messageCounts)) {
      rows.push({
        agentId,
        agentName: names.get(agentId) ?? '未知',
        sessionCount: sessionCounts.get(agentId) ?? 0,
        messageCount: messageCounts.get(agentId) ?? 0,
        totalTokens: tokens.get(agentId) ?? 0,
      });
    }
    rows.sort(byNumberDesc('sessionCount', 'messageCount'));
    return rows.slice(0, clampLimit(limit));
  }

  private async userActivity(range: AnalyticsRange, limit = RANK_LIMIT): Promise<Array<Record<string, unknown>>> {
    const [users, sessionRows, messageRows] = await Promise.all([
      this.store.listUsers(),
      this.store.selectSessionCountsByUser(range),
      this.store.selectMessageStatsByUser(range),
    ]);
    const sessionCounts = idMap(sessionRows, (r) => r.sessionCount);
    const messageCounts = idMap(messageRows, (r) => r.messageCount);
    const tokens = idMap(messageRows, (r) => r.totalTokens);
    const rows: Array<Record<string, unknown>> = [];
    for (const user of users) {
      const sessionCount = sessionCounts.get(user.id!) ?? 0;
      const messageCount = messageCounts.get(user.id!) ?? 0;
      if (sessionCount === 0 && messageCount === 0) {
        continue;
      }
      rows.push({
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        sessionCount,
        messageCount,
        totalTokens: tokens.get(user.id!) ?? 0,
        lastLoginAt: user.lastLoginAt != null ? String(user.lastLoginAt) : null,
      });
    }
    rows.sort(byNumberDesc('messageCount', 'totalTokens'));
    return rows.slice(0, clampLimit(limit));
  }

  private async modelStats(range: AnalyticsRange): Promise<Array<Record<string, unknown>>> {
    const [models, sessionRows, messageRows, usageRows] = await Promise.all([
      this.store.listModelsOrderByCreatedDesc(),
      this.store.selectSessionCountsByModel(range),
      this.store.selectMessageStatsByModel(range),
      this.store.selectUsageStatsByModel(range),
    ]);
    const sessionCounts = idMap(sessionRows, (r) => r.sessionCount);
    const messageCounts = idMap(messageRows, (r) => r.messageCount);
    const chatTokens = idMap(messageRows, (r) => r.totalTokens);
    const backgroundTokens = idMap(usageRows, (r) => r.totalTokens);
    const backgroundCalls = idMap(usageRows, (r) => r.callCount);
    const rows: Array<Record<string, unknown>> = [];
    for (const model of models) {
      const chat = chatTokens.get(model.id!) ?? 0;
      const background = backgroundTokens.get(model.id!) ?? 0;
      const sessionCount = sessionCounts.get(model.id!) ?? 0;
      const messageCount = messageCounts.get(model.id!) ?? 0;
      const calls = backgroundCalls.get(model.id!) ?? 0;
      // 窗口内完全未被调用的模型不返回，避免明细表被大量全零行淹没
      if (sessionCount === 0 && messageCount === 0 && chat === 0 && background === 0 && calls === 0) {
        continue;
      }
      rows.push({
        modelId: model.id,
        modelName: model.name,
        provider: model.provider,
        status: model.status,
        isDefault: model.isDefault,
        sessionCount,
        messageCount,
        chatTokens: chat,
        backgroundTokens: background,
        totalTokens: chat + background,
        backgroundCalls: calls,
        contextWindowTokens: model.contextWindowTokens,
      });
    }
    rows.sort(byNumberDesc('totalTokens', 'messageCount'));
    return rows;
  }
}

function buildRange(endYmd: string, days: number): AnalyticsRange {
  const startYmd = addDaysYmd(endYmd, -(days - 1));
  return {
    days,
    startYmd,
    endYmd,
    startAt: `${startYmd} 00:00:00`,
    endAtExclusive: `${addDaysYmd(endYmd, 1)} 00:00:00`,
  };
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(Math.trunc(limit) || RANK_LIMIT, MAX_SCOPE_LIMIT));
}

function deltaPercent(current: number, previous: number | undefined): number | null {
  if (previous == null || previous === 0) return current > 0 ? null : 0;
  return Math.round(((current - previous) / previous) * 100);
}

/** 总览洞察只依赖窗口合计与环比，避免 overview 被维度排行拖慢。 */
function buildOverviewInsights(
  totals: Record<string, number>,
  previous: Record<string, number>,
): AnalyticsInsight[] {
  const insights: AnalyticsInsight[] = [];
  const sessions = toNumber(totals.sessions);
  const messages = toNumber(totals.messages);
  const totalTokens = toNumber(totals.totalTokens);
  const completed = toNumber(totals.completedSessions);
  const failed = toNumber(totals.failedSessions);
  const ended = completed + failed;

  if (sessions === 0 && messages === 0 && totalTokens === 0) {
    insights.push({
      level: 'info',
      text: '当前时间窗内没有会话与消息，可放宽到近 7 天观察。',
      path: '/analytics?tab=trends',
    });
  }

  if (ended > 0) {
    const failRate = Math.round((failed / ended) * 1000) / 10;
    if (failRate >= 20) {
      insights.push({
        level: 'warn',
        text: `窗口内会话失败率 ${failRate}%（失败 ${failed} / 已结局 ${ended}），建议查看会话结构。`,
        path: '/analytics?tab=sessions',
      });
    } else if (failed > 0) {
      insights.push({
        level: 'info',
        text: `窗口内失败会话 ${failed} 个（失败率 ${failRate}%）。`,
        path: '/sessions?phase=FAILED',
      });
    }
  }

  const tokenDelta = deltaPercent(totalTokens, previous.totalTokens);
  if (tokenDelta != null && Math.abs(tokenDelta) >= 30) {
    insights.push({
      level: tokenDelta > 0 ? 'warn' : 'info',
      text: `Token 消耗环比${tokenDelta > 0 ? '上升' : '下降'} ${Math.abs(tokenDelta)}%。`,
      path: '/analytics?tab=models',
    });
  }

  const userDelta = deltaPercent(toNumber(totals.activeUsers), previous.activeUsers);
  if (userDelta != null && userDelta <= -30) {
    insights.push({
      level: 'warn',
      text: `活跃用户环比下降 ${Math.abs(userDelta)}%。`,
      path: '/analytics?tab=users',
    });
  }

  return insights.slice(0, 3);
}

/** DATE() 在 dateStrings 模式下是 'YYYY-MM-DD'，这里统一截断以兼容 Date 兜底。 */
function dayMap<T>(rows: T[], key: (row: T) => unknown, value: (row: T) => unknown): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) {
    const k = key(row);
    if (k != null) {
      result.set(String(k).slice(0, 10), toNumber(value(row)));
    }
  }
  return result;
}

function phaseMap(rows: PhaseCountRow[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) {
    if (row.phase != null) {
      result.set(String(row.phase), toNumber(row.count));
    }
  }
  return result;
}

function idMap<T extends { id: number }>(rows: T[], value: (row: T) => unknown): Map<number, number> {
  const result = new Map<number, number>();
  for (const row of rows) {
    if (row.id != null) {
      result.set(toNumber(row.id), toNumber(value(row)));
    }
  }
  return result;
}

function sumTrends(trends: Array<Record<string, unknown>>): Record<string, number> {
  const totals = { sessions: 0, messages: 0, chatTokens: 0, backgroundTokens: 0, totalTokens: 0, backgroundCalls: 0 };
  for (const row of trends) {
    totals.sessions += toNumber(row.sessions);
    totals.messages += toNumber(row.messages);
    totals.chatTokens += toNumber(row.chatTokens);
    totals.backgroundTokens += toNumber(row.backgroundTokens);
    totals.totalTokens += toNumber(row.totalTokens);
    totals.backgroundCalls += toNumber(row.backgroundCalls);
  }
  return totals;
}

function unionKeys(...maps: Array<Map<number, number>>): number[] {
  const keys = new Set<number>();
  for (const map of maps) {
    for (const key of map.keys()) {
      keys.add(key);
    }
  }
  return [...keys];
}

function byNumberDesc(primary: string, secondary: string) {
  return (a: Record<string, unknown>, b: Record<string, unknown>): number =>
    toNumber(b[primary]) - toNumber(a[primary]) || toNumber(b[secondary]) - toNumber(a[secondary]);
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (value == null) {
    return 0;
  }
  return Number(value);
}
