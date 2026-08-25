import { notDeleted, type Db } from '../db/db.js';
import type { FeishuBot, FeishuBotRepository } from './types.js';

export class MysqlFeishuBotRepository implements FeishuBotRepository {
  constructor(private readonly db: Db) {}

  list(): Promise<FeishuBot[]> {
    return this.db.query<FeishuBot>(
      `SELECT * FROM feishu_bot WHERE ${notDeleted()} ORDER BY created_at DESC`,
    );
  }

  findById(id: number): Promise<FeishuBot | null> {
    return this.db.queryOne<FeishuBot>(
      `SELECT * FROM feishu_bot WHERE id = ? AND ${notDeleted()}`,
      [id],
    );
  }

  findByAppKey(appKey: string): Promise<FeishuBot | null> {
    return this.db.queryOne<FeishuBot>(
      `SELECT * FROM feishu_bot WHERE app_key = ? AND ${notDeleted()}`,
      [appKey],
    );
  }

  async create(bot: FeishuBot): Promise<number> {
    const id = await this.db.insert('feishu_bot', {
      appKey: bot.appKey,
      name: bot.name,
      appId: bot.appId,
      appSecret: bot.appSecret,
      agentId: bot.agentId ?? null,
      modelId: bot.modelId ?? null,
      enabled: bot.enabled ?? 1,
      deleted: 0,
    });
    bot.id = id;
    return id;
  }

  async update(bot: FeishuBot): Promise<void> {
    if (bot.id == null) return;
    await this.db.updateById('feishu_bot', bot.id, {
      appKey: bot.appKey,
      name: bot.name,
      appId: bot.appId,
      appSecret: bot.appSecret,
      agentId: bot.agentId ?? null,
      modelId: bot.modelId ?? null,
      enabled: bot.enabled ?? 1,
    });
  }

  async softDelete(id: number): Promise<void> {
    await this.db.updateById('feishu_bot', id, { deleted: 1, enabled: 0 });
  }
}
