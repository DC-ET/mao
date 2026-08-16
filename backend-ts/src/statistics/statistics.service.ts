import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import type { LlmModel, UserRow } from '../domain/types.js';
import { shanghaiYmd } from '../common/json.js';

export interface StatisticsStore {
  countAgents(): Promise<number>;
  countModels(): Promise<number>;
  countUsers(): Promise<number>;
  countSessions(): Promise<number>;
  countMessages(): Promise<number>;
  countSessionsSince(start: string): Promise<number>;
  countMessagesSince(start: string): Promise<number>;
  selectAgentUsageStats(): Promise<Array<Record<string, unknown>>>;
  listModels(): Promise<LlmModel[]>;
  countMessagesByModel(modelId: number): Promise<number>;
  selectTokenCountByModel(modelId: number): Promise<number>;
  sumUsageByModelId(modelId: number): Promise<Record<string, unknown> | null>;
  listUsers(): Promise<UserRow[]>;
  countSessionsByUser(userId: number): Promise<number>;
}

export class StatisticsDbStore implements StatisticsStore {
  constructor(private readonly db: Db) {}

  countAgents(): Promise<number> {
    return this.count('agent', 'deleted = 0', []);
  }

  countModels(): Promise<number> {
    return this.count('llm_model', 'deleted = 0', []);
  }

  countUsers(): Promise<number> {
    return this.count('user', 'deleted = 0', []);
  }

  countSessions(): Promise<number> {
    return this.count('session', 'deleted = 0', []);
  }

  countMessages(): Promise<number> {
    return this.count('message', 'deleted = 0', []);
  }

  countSessionsSince(start: string): Promise<number> {
    return this.count('session', 'created_at >= ? AND deleted = 0', [start]);
  }

  countMessagesSince(start: string): Promise<number> {
    return this.count('message', 'created_at >= ? AND deleted = 0', [start]);
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

  listModels(): Promise<LlmModel[]> {
    return this.db.query(`SELECT * FROM llm_model WHERE ${notDeleted()}`);
  }

  countMessagesByModel(modelId: number): Promise<number> {
    return this.count('message', 'model_id = ? AND deleted = 0', [modelId]);
  }

  async selectTokenCountByModel(modelId: number): Promise<number> {
    const row = await this.db.queryOne<{ c: number }>(
      'SELECT COALESCE(SUM(token_count), 0) AS c FROM message WHERE model_id = ? AND deleted = 0',
      [modelId],
    );
    return Number(row?.c ?? 0);
  }

  sumUsageByModelId(modelId: number): Promise<Record<string, unknown> | null> {
    return this.db.queryOne(
      `SELECT COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
              COALESCE(SUM(completion_tokens), 0) AS completionTokens,
              COALESCE(SUM(total_tokens), 0) AS totalTokens, COUNT(*) AS callCount
       FROM llm_usage WHERE model_id = ?`,
      [modelId],
    );
  }

  listUsers(): Promise<UserRow[]> {
    return this.db.query(`SELECT * FROM user WHERE ${notDeleted()}`);
  }

  countSessionsByUser(userId: number): Promise<number> {
    return this.count('session', 'user_id = ? AND deleted = 0', [userId]);
  }

  private async count(table: string, where: string, params: unknown[]): Promise<number> {
    const row = await this.db.queryOne<{ c: number }>(`SELECT COUNT(*) AS c FROM \`${table}\` WHERE ${where}`, params);
    return Number(row?.c ?? 0);
  }
}

export class StatisticsService {
  constructor(private readonly store: StatisticsStore) {}

  async getOverview(): Promise<Record<string, unknown>> {
    const todayStart = `${shanghaiYmd()} 00:00:00`;
    return {
      totalAgents: await this.store.countAgents(),
      totalModels: await this.store.countModels(),
      totalUsers: await this.store.countUsers(),
      totalSessions: await this.store.countSessions(),
      totalMessages: await this.store.countMessages(),
      todaySessions: await this.store.countSessionsSince(todayStart),
      todayMessages: await this.store.countMessagesSince(todayStart),
    };
  }

  getAgentStats(): Promise<Array<Record<string, unknown>>> {
    return this.store.selectAgentUsageStats();
  }

  async getModelStats(): Promise<Array<Record<string, unknown>>> {
    const stats: Array<Record<string, unknown>> = [];
    const models = await this.store.listModels();
    for (const model of models) {
      const messageCount = await this.store.countMessagesByModel(model.id!);
      const background = await this.store.sumUsageByModelId(model.id!);
      const messageTokens = (await this.store.selectTokenCountByModel(model.id!)) ?? 0;
      const backgroundTokens = number(background, 'totalTokens');
      stats.push({
        modelId: model.id,
        modelName: model.name,
        messageCount,
        backgroundCallCount: number(background, 'callCount'),
        backgroundPromptTokens: number(background, 'promptTokens'),
        backgroundCompletionTokens: number(background, 'completionTokens'),
        messageTokens,
        backgroundTotalTokens: backgroundTokens,
        totalTokens: messageTokens + backgroundTokens,
      });
    }
    return stats;
  }

  async getUserStats(): Promise<Array<Record<string, unknown>>> {
    const stats: Array<Record<string, unknown>> = [];
    const users = await this.store.listUsers();
    for (const user of users) {
      stats.push({
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        sessionCount: await this.store.countSessionsByUser(user.id!),
        lastLoginAt: user.lastLoginAt != null ? String(user.lastLoginAt) : null,
      });
    }
    return stats;
  }
}

function number(values: Record<string, unknown> | null | undefined, key: string): number {
  const value = values != null ? values[key] : null;
  return typeof value === 'number' ? value : 0;
}
