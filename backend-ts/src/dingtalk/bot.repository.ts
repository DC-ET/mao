import { notDeleted, type Db } from '../db/db.js';
import type { DingtalkBot, DingtalkBotRepository } from './types.js';

export class MysqlDingtalkBotRepository implements DingtalkBotRepository {
  constructor(private readonly db: Db) {}

  list(): Promise<DingtalkBot[]> {
    return this.db.query<DingtalkBot>(`SELECT * FROM dingtalk_bot WHERE ${notDeleted()} ORDER BY created_at DESC`);
  }

  findById(id: number): Promise<DingtalkBot | null> {
    return this.db.queryOne<DingtalkBot>(`SELECT * FROM dingtalk_bot WHERE id = ? AND ${notDeleted()}`, [id]);
  }

  findByAppKey(appKey: string): Promise<DingtalkBot | null> {
    return this.db.queryOne<DingtalkBot>(`SELECT * FROM dingtalk_bot WHERE app_key = ? AND ${notDeleted()}`, [appKey]);
  }

  async create(bot: DingtalkBot): Promise<number> {
    const id = await this.db.insert('dingtalk_bot', {
      appKey: bot.appKey,
      name: bot.name,
      clientId: bot.clientId,
      clientSecret: bot.clientSecret,
      robotCode: bot.robotCode,
      agentId: bot.agentId ?? null,
      modelId: bot.modelId ?? null,
      progressCardTemplateId: bot.progressCardTemplateId ?? null,
      queueCardTemplateId: bot.queueCardTemplateId ?? null,
      enabled: bot.enabled ?? 1,
      deleted: 0,
    });
    bot.id = id;
    return id;
  }

  async update(bot: DingtalkBot): Promise<void> {
    if (bot.id == null) return;
    await this.db.updateById('dingtalk_bot', bot.id, {
      appKey: bot.appKey,
      name: bot.name,
      clientId: bot.clientId,
      clientSecret: bot.clientSecret,
      robotCode: bot.robotCode,
      agentId: bot.agentId ?? null,
      modelId: bot.modelId ?? null,
      progressCardTemplateId: bot.progressCardTemplateId ?? null,
      queueCardTemplateId: bot.queueCardTemplateId ?? null,
      enabled: bot.enabled ?? 1,
    });
  }

  async softDelete(id: number): Promise<void> {
    await this.db.updateById('dingtalk_bot', id, { deleted: 1, enabled: 0 });
  }
}
