import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import { hasText } from '../common/case.js';
import type { LlmModel, LlmModelRepository, ModelListFilter, SessionModelRepository } from './types.js';

export class MysqlLlmModelRepository implements LlmModelRepository {
  constructor(private readonly db: Db) {}

  async selectPage(
    page: number,
    size: number,
    filter: ModelListFilter,
  ): Promise<{ records: LlmModel[]; total: number }> {
    const where: string[] = [notDeleted()];
    const params: unknown[] = [];
    if (hasText(filter.keyword ?? undefined)) {
      const value = `%${filter.keyword!.trim()}%`;
      where.push('(name LIKE ? OR model_id LIKE ? OR provider LIKE ?)');
      params.push(value, value, value);
    }
    if (hasText(filter.provider ?? undefined)) {
      where.push('provider = ?');
      params.push(filter.provider!.trim());
    }
    if (filter.status != null) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.supportsVision != null) {
      where.push('supports_vision = ?');
      params.push(filter.supportsVision);
    }
    if (filter.isDefault != null) {
      where.push('is_default = ?');
      params.push(filter.isDefault);
    }
    if (hasText(filter.modelType ?? undefined)) {
      where.push('model_type = ?');
      params.push(filter.modelType!.trim());
    }
    const whereSql = where.join(' AND ');
    const countRow = await this.db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM llm_model WHERE ${whereSql}`,
      params,
    );
    const total = Number(countRow?.cnt ?? 0);
    const current = Math.max(page, 1);
    const offset = (current - 1) * size;
    const records = await this.db.query<LlmModel>(
      `SELECT * FROM llm_model WHERE ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, size, offset],
    );
    return { records, total };
  }

  async listProviders(): Promise<string[]> {
    const rows = await this.db.query<{ provider: string | null }>(
      `SELECT DISTINCT provider FROM llm_model WHERE provider IS NOT NULL AND ${notDeleted()} ORDER BY provider ASC`,
    );
    return rows.map((row) => row.provider).filter((provider): provider is string => provider != null);
  }

  listActiveText(): Promise<LlmModel[]> {
    return this.db.query<LlmModel>(
      `SELECT * FROM llm_model WHERE status = 1 AND model_type = 'text' AND ${notDeleted()} ORDER BY model_id ASC`,
    );
  }

  findFirstActiveByType(modelType: string): Promise<LlmModel | null> {
    return this.db.queryOne<LlmModel>(
      `SELECT * FROM llm_model WHERE status = 1 AND model_type = ? AND ${notDeleted()} ORDER BY id ASC LIMIT 1`,
      [modelType],
    );
  }

  findDefault(): Promise<LlmModel | null> {
    return this.db.queryOne<LlmModel>(
      `SELECT * FROM llm_model WHERE is_default = 1 AND status = 1 AND model_type = 'text' AND ${notDeleted()} LIMIT 1`,
    );
  }

  findById(id: number): Promise<LlmModel | null> {
    return this.db.queryOne<LlmModel>(`SELECT * FROM llm_model WHERE id = ? AND ${notDeleted()}`, [id]);
  }

  selectById(id: number): Promise<LlmModel | null> {
    return this.findById(id);
  }

  selectDefault(): Promise<LlmModel | null> {
    return this.findDefault();
  }

  async findByIds(ids: number[]): Promise<LlmModel[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db.query<LlmModel>(
      `SELECT * FROM llm_model WHERE id IN (${placeholders}) AND ${notDeleted()}`,
      ids,
    );
  }

  async insert(model: LlmModel): Promise<number> {
    const id = await this.db.insert('llm_model', {
      name: model.name,
      provider: model.provider,
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      modelId: model.modelId,
      modelType: model.modelType ?? 'text',
      contextWindowTokens: model.contextWindowTokens,
      status: model.status ?? 1,
      supportsVision: model.supportsVision ?? 0,
      isDefault: model.isDefault ?? 0,
      deleted: 0,
    });
    model.id = id;
    return id;
  }

  async updateById(model: LlmModel): Promise<void> {
    if (model.id == null) {
      return;
    }
    await this.db.updateById('llm_model', model.id, {
      name: model.name,
      provider: model.provider,
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      modelId: model.modelId,
      modelType: model.modelType,
      contextWindowTokens: model.contextWindowTokens,
      status: model.status,
      supportsVision: model.supportsVision,
      isDefault: model.isDefault,
    });
  }

  async deleteById(id: number): Promise<void> {
    await this.db.updateById('llm_model', id, { deleted: 1 });
  }

  async clearDefaultFlag(): Promise<void> {
    await this.db.execute(`UPDATE llm_model SET is_default = 0 WHERE is_default = 1 AND ${notDeleted()}`);
  }

  async countActiveExcept(id: number): Promise<number> {
    const row = await this.db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM llm_model WHERE status = 1 AND id <> ? AND ${notDeleted()}`,
      [id],
    );
    return Number(row?.cnt ?? 0);
  }
}

export class MysqlSessionModelRepository implements SessionModelRepository {
  constructor(private readonly db: Db) {}

  /** 模型迁移不属于会话活动，保留 updated_at 以免扰乱会话列表排序。 */
  async reassignModelId(fromId: number, toId: number | null): Promise<void> {
    await this.db.execute(
      `UPDATE session SET model_id = ?, updated_at = updated_at WHERE model_id = ? AND ${notDeleted()}`,
      [toId, fromId],
    );
  }
}
