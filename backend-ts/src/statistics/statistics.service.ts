import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import type { LlmModel, UserRow } from '../domain/types.js';
import { shanghaiYmd } from '../common/json.js';
import type { OnlineDeviceConnection, OnlineDevicesVo, WsClientType } from '@mao/contracts';
import type { WsConnectionSnapshot } from '../session/ws/streaming-ws-registry.js';

/** 在线连接快照来源（结构化注入，statistics 不依赖 StreamingWsRegistry 实现，测试注假实例即可）。 */
export interface WsRegistrySnapshot {
  listConnections(): WsConnectionSnapshot[];
}

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
  constructor(private readonly store: StatisticsStore, private readonly wsRegistry?: WsRegistrySnapshot) {}

  /**
   * 全局累计概览。7 个计数互不依赖，并行发出：
   * 串行时一次约 130ms（其中 message 全表 COUNT 占 ~73ms），而它挂在总览请求的关键路径上。
   */
  async getOverview(): Promise<Record<string, unknown>> {
    const todayStart = `${shanghaiYmd()} 00:00:00`;
    const [totalAgents, totalModels, totalUsers, totalSessions, totalMessages, todaySessions, todayMessages] =
      await Promise.all([
        this.store.countAgents(),
        this.store.countModels(),
        this.store.countUsers(),
        this.store.countSessions(),
        this.store.countMessages(),
        this.store.countSessionsSince(todayStart),
        this.store.countMessagesSince(todayStart),
      ]);
    return { totalAgents, totalModels, totalUsers, totalSessions, totalMessages, todaySessions, todayMessages };
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

  /**
   * 当前在线设备（WS 连接）实时快照（技术方案 2026-11-10）。纯内存读 + 一次用户表查询；
   * wsRegistry 未注入（内部装配未传）时返回空快照，行为等同「无人在线」，不抛错。
   *
   * 去重设备数口径：electron / cli 连接按 (userId, deviceId) 去重（同机多窗口/桌面+CLI 共用
   * device.json 算一台）+ android 连接逐条计数（壳不自报 deviceId）；browser / embed 无设备
   * 标识不计入设备数——统计卡必须同时展示连接数与设备数，避免拿浏览器连接数当设备数。
   */
  async getOnlineDevices(): Promise<OnlineDevicesVo> {
    const connections = this.wsRegistry?.listConnections() ?? [];
    const users = await this.store.listUsers();
    const userById = new Map<number, UserRow>();
    for (const user of users) {
      if (user.id != null) userById.set(user.id, user);
    }

    // 字面量穷尽五类：WsClientType 联合扩张时这里因缺键编译期报错，与 admin 汉化表同机制
    const byClientType: Record<WsClientType, number> = { electron: 0, android: 0, cli: 0, browser: 0, embed: 0 };
    const deviceKeys = new Set<string>();
    const grouped = new Map<number, OnlineDeviceConnection[]>();
    for (const conn of connections) {
      byClientType[conn.clientType] += 1;
      if (conn.device != null) {
        deviceKeys.add(`${conn.userId}:${conn.device.id}`);
      } else if (conn.clientType === 'android') {
        deviceKeys.add(`${conn.userId}:android:${conn.wsSessionId}`);
      }
      let list = grouped.get(conn.userId);
      if (!list) {
        list = [];
        grouped.set(conn.userId, list);
      }
      list.push({
        wsSessionId: conn.wsSessionId,
        clientType: conn.clientType,
        connectedAt: conn.connectedAt,
        authExpiresAt: conn.authExpiresAt,
        authSource: conn.authSource,
        device: conn.device,
      });
    }

    const userEntries = [...grouped.entries()].map(([userId, conns]) => {
      const user = userById.get(userId);
      return {
        userId,
        username: user?.username ?? '(已删除用户)',
        displayName: user?.displayName ?? null,
        connections: conns,
      };
    });
    userEntries.sort((a, b) => a.userId - b.userId);

    return {
      total: { connections: connections.length, users: grouped.size, devices: deviceKeys.size },
      byClientType,
      users: userEntries,
    };
  }
}

function number(values: Record<string, unknown> | null | undefined, key: string): number {
  const value = values != null ? values[key] : null;
  return typeof value === 'number' ? value : 0;
}
