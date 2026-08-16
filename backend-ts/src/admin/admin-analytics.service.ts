import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import type { Agent, LlmModel, Session, UserRow } from '../domain/types.js';
import { addDaysYmd, shanghaiYmd } from '../common/json.js';
import type { StatisticsService } from '../statistics/statistics.service.js';

export interface AdminAnalyticsStore {
  selectSessionCountsByDay(start: string): Promise<Array<{ day: string; count: number }>>;
  selectMessageCountsByDay(start: string): Promise<Array<{ day: string; count: number }>>;
  selectPhaseCounts(): Promise<Array<{ phase: string; count: number }>>;
  selectTokenStatsGroupByAgent(): Promise<Array<{ agentId: number; totalTokens: number; messageCount: number }>>;
  selectAgentUsageStats(): Promise<Array<Record<string, unknown>>>;
  selectSessionCountsByUser(): Promise<Array<{ userId: number; sessionCount: number }>>;
  selectMessageCountsByUser(): Promise<Array<{ userId: number; messageCount: number }>>;
  selectSessionCountsByModel(): Promise<Array<{ modelId: number; sessionCount: number }>>;
  selectMessageCountsByModel(): Promise<Array<{ modelId: number; messageCount: number }>>;
  listAgents(): Promise<Agent[]>;
  listUsers(): Promise<UserRow[]>;
  listModelsOrderByCreatedDesc(): Promise<LlmModel[]>;
  listRecentFailedSessions(since: string, limit: number): Promise<Session[]>;
}

export class AdminAnalyticsDbStore implements AdminAnalyticsStore {
  constructor(private readonly db: Db) {}

  selectSessionCountsByDay(start: string): Promise<Array<{ day: string; count: number }>> {
    return this.db.query(
      'SELECT DATE(created_at) AS day, COUNT(*) AS count FROM session WHERE created_at >= ? AND deleted = 0 GROUP BY DATE(created_at)',
      [start],
    );
  }

  selectMessageCountsByDay(start: string): Promise<Array<{ day: string; count: number }>> {
    return this.db.query(
      'SELECT DATE(created_at) AS day, COUNT(*) AS count FROM message WHERE created_at >= ? AND deleted = 0 GROUP BY DATE(created_at)',
      [start],
    );
  }

  selectPhaseCounts(): Promise<Array<{ phase: string; count: number }>> {
    return this.db.query(
      `SELECT COALESCE(phase, 'IDLE') AS phase, COUNT(*) AS count FROM session WHERE deleted = 0 GROUP BY COALESCE(phase, 'IDLE')`,
    );
  }

  selectTokenStatsGroupByAgent(): Promise<Array<{ agentId: number; totalTokens: number; messageCount: number }>> {
    return this.db.query(
      `SELECT s.agent_id AS agentId, COALESCE(SUM(m.token_count), 0) AS totalTokens, COUNT(*) AS messageCount
       FROM message m JOIN session s ON m.session_id = s.id
       WHERE m.deleted = 0 AND s.deleted = 0
       GROUP BY s.agent_id`,
    );
  }

  selectAgentUsageStats(): Promise<Array<Record<string, unknown>>> {
    return this.db.query(
      `SELECT a.id AS agentId, a.name AS agentName,
              COUNT(DISTINCT s.id) AS sessionCount, COUNT(m.id) AS messageCount,
              COALESCE(SUM(m.token_count), 0) AS totalTokens
       FROM agent a
       LEFT JOIN session s ON s.agent_id = a.id AND s.deleted = 0
       LEFT JOIN message m ON m.session_id = s.id AND m.deleted = 0
       WHERE a.deleted = 0
       GROUP BY a.id, a.name
       ORDER BY sessionCount DESC, messageCount DESC
       LIMIT 20`,
    );
  }

  selectSessionCountsByUser(): Promise<Array<{ userId: number; sessionCount: number }>> {
    return this.db.query(
      'SELECT user_id AS userId, COUNT(*) AS sessionCount FROM session WHERE deleted = 0 GROUP BY user_id',
    );
  }

  selectMessageCountsByUser(): Promise<Array<{ userId: number; messageCount: number }>> {
    return this.db.query(
      `SELECT s.user_id AS userId, COUNT(m.id) AS messageCount
       FROM message m JOIN session s ON m.session_id = s.id
       WHERE m.deleted = 0 AND s.deleted = 0
       GROUP BY s.user_id`,
    );
  }

  selectSessionCountsByModel(): Promise<Array<{ modelId: number; sessionCount: number }>> {
    return this.db.query(
      'SELECT model_id AS modelId, COUNT(*) AS sessionCount FROM session WHERE model_id IS NOT NULL AND deleted = 0 GROUP BY model_id',
    );
  }

  selectMessageCountsByModel(): Promise<Array<{ modelId: number; messageCount: number }>> {
    return this.db.query(
      `SELECT model_id AS modelId, COUNT(*) AS messageCount, COALESCE(SUM(token_count), 0) AS totalTokens
       FROM message WHERE model_id IS NOT NULL AND deleted = 0 GROUP BY model_id`,
    );
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

  listRecentFailedSessions(since: string, limit: number): Promise<Session[]> {
    return this.db.query(
      `SELECT * FROM session WHERE phase = 'FAILED' AND updated_at >= ? AND ${notDeleted()} ORDER BY updated_at DESC LIMIT ?`,
      [since, limit],
    );
  }
}

export class AdminAnalyticsService {
  constructor(
    private readonly statisticsService: StatisticsService,
    private readonly store: AdminAnalyticsStore,
  ) {}

  async summary(days: number): Promise<Record<string, unknown>> {
    const overview: Record<string, unknown> = { ...(await this.statisticsService.getOverview()) };
    const phaseCounts = await this.phaseCountMap();
    overview.runningSessions = phaseCounts.get('RUNNING') ?? 0;
    overview.waitingSessions = phaseCounts.get('WAITING_APPROVAL') ?? 0;
    overview.failedSessions = phaseCounts.get('FAILED') ?? 0;
    overview.cancelledSessions = phaseCounts.get('CANCELLED') ?? 0;
    return {
      overview,
      trends: await this.trends(days),
      phaseDistribution: this.phaseDistribution(phaseCounts),
      tokenStats: await this.tokenStats(),
      agentStats: await this.store.selectAgentUsageStats(),
      userActivity: await this.userActivity(),
      modelStats: await this.modelStats(),
      recentFailures: await this.recentFailures(),
    };
  }

  private async trends(days: number): Promise<Array<Record<string, unknown>>> {
    const safeDays = Math.max(1, Math.min(days, 90));
    const today = shanghaiYmd();
    const firstDay = addDaysYmd(today, -(safeDays - 1));
    const start = `${firstDay} 00:00:00`;
    const sessionsByDay = countMap(await this.store.selectSessionCountsByDay(start) as Array<Record<string, unknown>>, 'day', 'count');
    const messagesByDay = countMap(await this.store.selectMessageCountsByDay(start) as Array<Record<string, unknown>>, 'day', 'count');
    const rows: Array<Record<string, unknown>> = [];
    for (let i = safeDays - 1; i >= 0; i--) {
      const day = addDaysYmd(today, -i);
      rows.push({
        date: day,
        sessions: sessionsByDay.get(day) ?? 0,
        messages: messagesByDay.get(day) ?? 0,
      });
    }
    return rows;
  }

  private async phaseCountMap(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const row of await this.store.selectPhaseCounts()) {
      counts.set(String(row.phase), toNumber(row.count));
    }
    return counts;
  }

  private phaseDistribution(phaseCounts: Map<string, number>): Array<Record<string, unknown>> {
    const phases = ['IDLE', 'RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'];
    return phases.map((phase) => ({ phase, count: phaseCounts.get(phase) ?? 0 }));
  }

  private async tokenStats(): Promise<Array<Record<string, unknown>>> {
    const agents = await this.store.listAgents();
    const agentNames = new Map(agents.filter((a) => a.id != null).map((a) => [a.id!, a.name ?? '未知']));
    const rows: Array<Record<string, unknown>> = [];
    for (const row of await this.store.selectTokenStatsGroupByAgent()) {
      const agentId = toNumber(row.agentId);
      rows.push({
        agentId,
        agentName: agentNames.get(agentId) ?? '未知',
        totalTokens: toNumber(row.totalTokens),
        messageCount: toNumber(row.messageCount),
      });
    }
    rows.sort((a, b) => toNumber(b.totalTokens) - toNumber(a.totalTokens));
    return rows;
  }

  private async userActivity(): Promise<Array<Record<string, unknown>>> {
    const sessionCounts = idCountMap(await this.store.selectSessionCountsByUser() as Array<Record<string, unknown>>, 'userId', 'sessionCount');
    const messageCounts = idCountMap(await this.store.selectMessageCountsByUser() as Array<Record<string, unknown>>, 'userId', 'messageCount');
    const rows: Array<Record<string, unknown>> = [];
    for (const user of await this.store.listUsers()) {
      rows.push({
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        sessionCount: sessionCounts.get(user.id!) ?? 0,
        messageCount: messageCounts.get(user.id!) ?? 0,
        lastLoginAt: user.lastLoginAt != null ? String(user.lastLoginAt) : null,
      });
    }
    rows.sort((a, b) => toNumber(b.messageCount) - toNumber(a.messageCount));
    return rows;
  }

  private async modelStats(): Promise<Array<Record<string, unknown>>> {
    const sessionCounts = idCountMap(await this.store.selectSessionCountsByModel() as Array<Record<string, unknown>>, 'modelId', 'sessionCount');
    const messageCounts = idCountMap(await this.store.selectMessageCountsByModel() as Array<Record<string, unknown>>, 'modelId', 'messageCount');
    const rows: Array<Record<string, unknown>> = [];
    for (const model of await this.store.listModelsOrderByCreatedDesc()) {
      rows.push({
        modelId: model.id,
        modelName: model.name,
        provider: model.provider,
        status: model.status,
        isDefault: model.isDefault,
        messageCount: messageCounts.get(model.id!) ?? 0,
        sessionCount: sessionCounts.get(model.id!) ?? 0,
        contextWindowTokens: model.contextWindowTokens,
      });
    }
    return rows;
  }

  private async recentFailures(): Promise<Array<Record<string, unknown>>> {
    const sinceDate = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const since = `${shanghaiYmd(sinceDate)} 00:00:00`;
    const sessions = await this.store.listRecentFailedSessions(since, 10);
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

function countMap(rows: Array<Record<string, unknown>>, keyName: string, valueName: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) {
    const key = row[keyName];
    if (key != null) {
      result.set(String(key), toNumber(row[valueName]));
    }
  }
  return result;
}

function idCountMap(rows: Array<Record<string, unknown>>, keyName: string, valueName: string): Map<number, number> {
  const result = new Map<number, number>();
  for (const row of rows) {
    const key = row[keyName];
    if (key != null) {
      result.set(toNumber(key), toNumber(row[valueName]));
    }
  }
  return result;
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
