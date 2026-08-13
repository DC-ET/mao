import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import type { Agent, Message, Session, UserRow } from '../domain/types.js';
import { addDaysYmd, shanghaiYmd } from '../common/json.js';

export interface AnalyticsStore {
  countSessionsBetween(start: string, end: string): Promise<number>;
  countMessagesBetween(start: string, end: string): Promise<number>;
  selectTokenStatsGroupByAgent(): Promise<Array<{ agentId: number; totalTokens: number; messageCount: number }>>;
  listAgents(): Promise<Agent[]>;
  getAgent(id: number): Promise<Agent | null>;
  listUsers(): Promise<UserRow[]>;
  countSessionsByUser(userId: number): Promise<number>;
  listSessionsByUser(userId: number): Promise<Session[]>;
  countMessagesBySessionIds(sessionIds: number[]): Promise<number>;
  listSessionsByAgent(agentId: number): Promise<Session[]>;
  listMessagesBySession(sessionId: number): Promise<Message[]>;
}

export class AnalyticsDbStore implements AnalyticsStore {
  constructor(private readonly db: Db) {}

  countSessionsBetween(start: string, end: string): Promise<number> {
    return this.count('session', 'created_at >= ? AND created_at <= ? AND deleted = 0', [start, end]);
  }

  countMessagesBetween(start: string, end: string): Promise<number> {
    return this.count('message', 'created_at >= ? AND created_at <= ? AND deleted = 0', [start, end]);
  }

  async selectTokenStatsGroupByAgent(): Promise<Array<{ agentId: number; totalTokens: number; messageCount: number }>> {
    return this.db.query(
      `SELECT s.agent_id AS agentId, COALESCE(SUM(m.token_count), 0) AS totalTokens, COUNT(*) AS messageCount
       FROM message m JOIN session s ON m.session_id = s.id
       WHERE m.deleted = 0 AND s.deleted = 0
       GROUP BY s.agent_id`,
    );
  }

  listAgents(): Promise<Agent[]> {
    return this.db.query(`SELECT * FROM agent WHERE ${notDeleted()}`);
  }

  getAgent(id: number): Promise<Agent | null> {
    return this.db.queryOne(`SELECT * FROM agent WHERE id = ? AND ${notDeleted()}`, [id]);
  }

  listUsers(): Promise<UserRow[]> {
    return this.db.query(`SELECT * FROM user WHERE ${notDeleted()}`);
  }

  countSessionsByUser(userId: number): Promise<number> {
    return this.count('session', 'user_id = ? AND deleted = 0', [userId]);
  }

  listSessionsByUser(userId: number): Promise<Session[]> {
    return this.db.query(`SELECT * FROM session WHERE user_id = ? AND ${notDeleted()}`, [userId]);
  }

  async countMessagesBySessionIds(sessionIds: number[]): Promise<number> {
    if (sessionIds.length === 0) {
      return 0;
    }
    const placeholders = sessionIds.map(() => '?').join(', ');
    return this.count('message', `session_id IN (${placeholders}) AND deleted = 0`, sessionIds);
  }

  listSessionsByAgent(agentId: number): Promise<Session[]> {
    return this.db.query(`SELECT * FROM session WHERE agent_id = ? AND ${notDeleted()}`, [agentId]);
  }

  listMessagesBySession(sessionId: number): Promise<Message[]> {
    return this.db.query(`SELECT * FROM message WHERE session_id = ? AND ${notDeleted()}`, [sessionId]);
  }

  private async count(table: string, where: string, params: unknown[]): Promise<number> {
    const row = await this.db.queryOne<{ c: number }>(`SELECT COUNT(*) AS c FROM \`${table}\` WHERE ${where}`, params);
    return Number(row?.c ?? 0);
  }
}

export class AnalyticsService {
  constructor(private readonly store: AnalyticsStore) {}

  async getUsageTrends(days: number): Promise<Record<string, unknown>> {
    const trends: Array<Record<string, unknown>> = [];
    const today = shanghaiYmd();
    for (let i = days - 1; i >= 0; i--) {
      const date = addDaysYmd(today, -i);
      const dayStart = `${date} 00:00:00`;
      const dayEnd = `${date} 23:59:59`;
      const sessions = await this.store.countSessionsBetween(dayStart, dayEnd);
      const messages = await this.store.countMessagesBetween(dayStart, dayEnd);
      trends.push({ date, sessions, messages });
    }
    return { trends };
  }

  async getTokenAnalysis(): Promise<Record<string, unknown>> {
    const stats = await this.store.selectTokenStatsGroupByAgent();
    const agents = await this.store.listAgents();
    const agentNames = new Map(agents.filter((a) => a.id != null).map((a) => [a.id!, a.name ?? '未知']));
    const agentTokens: Array<Record<string, unknown>> = [];
    for (const row of stats) {
      const agentId = Number(row.agentId);
      agentTokens.push({
        agentId,
        agentName: agentNames.get(agentId) ?? '未知',
        totalTokens: Number(row.totalTokens),
        messageCount: Number(row.messageCount),
      });
    }
    agentTokens.sort((a, b) => Number(b.totalTokens) - Number(a.totalTokens));
    return { agentTokens };
  }

  async getUserActivity(): Promise<Record<string, unknown>> {
    const users = await this.store.listUsers();
    const userActivity: Array<Record<string, unknown>> = [];
    for (const user of users) {
      const sessionCount = await this.store.countSessionsByUser(user.id!);
      const sessions = await this.store.listSessionsByUser(user.id!);
      let messageCount = 0;
      if (sessions.length > 0) {
        messageCount = await this.store.countMessagesBySessionIds(sessions.map((s) => s.id!));
      }
      userActivity.push({
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        sessionCount,
        messageCount,
        lastLoginAt: lastLoginToString(user.lastLoginAt),
      });
    }
    userActivity.sort((a, b) => Number(b.messageCount) - Number(a.messageCount));
    return { userActivity };
  }

  async getAgentEfficiency(agentId: number): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    const agent = await this.store.getAgent(agentId);
    if (!agent) {
      return result;
    }
    const sessions = await this.store.listSessionsByAgent(agentId);
    let totalMessages = 0;
    let toolCallCount = 0;
    for (const session of sessions) {
      const messages = await this.store.listMessagesBySession(session.id!);
      totalMessages += messages.length;
      toolCallCount += messages.filter((m) => m.toolCalls != null && m.toolCalls !== '').length;
    }
    const totalSessions = sessions.length;
    const avgMessagesPerSession = totalSessions > 0 ? totalMessages / totalSessions : 0;
    const toolCallRate = totalMessages > 0 ? toolCallCount / totalMessages : 0;
    result.agentId = agentId;
    result.agentName = agent.name;
    result.totalSessions = totalSessions;
    result.totalMessages = totalMessages;
    result.avgMessagesPerSession = Math.round(avgMessagesPerSession * 100) / 100;
    result.toolCallCount = toolCallCount;
    result.toolCallRate = Math.round(toolCallRate * 100) / 100;
    return result;
  }
}

function lastLoginToString(value: string | Date | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  return String(value);
}
