import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import type { Agent, LlmModel, Session, UserRow } from '../domain/types.js';
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
  countActiveUsers(range: AnalyticsRange): Promise<number>;
  countSessions(range: AnalyticsRange): Promise<number>;
  sumMessages(range: AnalyticsRange): Promise<{ count: number; tokens: number }>;
  sumUsageTokens(range: AnalyticsRange): Promise<number>;
  listAgents(): Promise<Agent[]>;
  listUsers(): Promise<UserRow[]>;
  listModelsOrderByCreatedDesc(): Promise<LlmModel[]>;
  listRecentFailedSessions(range: AnalyticsRange, limit: number): Promise<Session[]>;
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

  listRecentFailedSessions(range: AnalyticsRange, limit: number): Promise<Session[]> {
    return this.db.query(
      `SELECT * FROM session
       WHERE phase = 'FAILED' AND updated_at >= ? AND updated_at < ? AND ${notDeleted()}
       ORDER BY updated_at DESC LIMIT ?`,
      [range.startAt, range.endAtExclusive, limit],
    );
  }
}

const PHASES = ['IDLE', 'RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'];
const RANK_LIMIT = 20;

export class AdminAnalyticsService {
  constructor(
    private readonly statisticsService: StatisticsService,
    private readonly store: AdminAnalyticsStore,
  ) {}

  /** 汇总统计窗口内的趋势、结构与环比；overview 中的阶段数是实时快照而非窗口内数据。 */
  async summary(days: number): Promise<Record<string, unknown>> {
    const safeDays = Math.max(1, Math.min(Math.trunc(days) || 1, 90));
    const range = buildRange(shanghaiYmd(), safeDays);
    const previous = buildRange(addDaysYmd(range.startYmd, -1), safeDays);

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
      recentFailures,
    ] = await Promise.all([
      this.statisticsService.getOverview(),
      this.store.selectLivePhaseCounts(),
      this.store.selectPhaseCounts(range),
      this.trends(range),
      this.store.countActiveUsers(range),
      this.previousTotals(previous),
      this.agentStats(range),
      this.userActivity(range),
      this.modelStats(range),
      this.recentFailures(range),
    ]);

    const livePhases = phaseMap(livePhaseRows);
    const periodPhases = phaseMap(periodPhaseRows);

    return {
      period: {
        days: safeDays,
        start: range.startYmd,
        end: range.endYmd,
        previousStart: previous.startYmd,
        previousEnd: previous.endYmd,
      },
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
      recentFailures,
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

  private async agentStats(range: AnalyticsRange): Promise<Array<Record<string, unknown>>> {
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
    return rows.slice(0, RANK_LIMIT);
  }

  private async userActivity(range: AnalyticsRange): Promise<Array<Record<string, unknown>>> {
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
    return rows.slice(0, RANK_LIMIT);
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
      rows.push({
        modelId: model.id,
        modelName: model.name,
        provider: model.provider,
        status: model.status,
        isDefault: model.isDefault,
        sessionCount: sessionCounts.get(model.id!) ?? 0,
        messageCount: messageCounts.get(model.id!) ?? 0,
        chatTokens: chat,
        backgroundTokens: background,
        totalTokens: chat + background,
        backgroundCalls: backgroundCalls.get(model.id!) ?? 0,
        contextWindowTokens: model.contextWindowTokens,
      });
    }
    rows.sort(byNumberDesc('totalTokens', 'messageCount'));
    return rows;
  }

  private async recentFailures(range: AnalyticsRange): Promise<Array<Record<string, unknown>>> {
    const sessions = await this.store.listRecentFailedSessions(range, 10);
    return sessions.map((session) => ({
      id: session.id,
      title: session.title,
      agentId: session.agentId,
      userId: session.userId,
      executionMode: session.executionMode,
      updatedAt: session.updatedAt != null ? String(session.updatedAt) : null,
    }));
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
