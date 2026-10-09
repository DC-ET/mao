import type { Db } from '../db/db.js';

export interface LlmCallRow {
  id?: number;
  userId?: number | null;
  sessionId?: number | null;
  agentId?: number | null;
  modelId?: number | null;
  modelName?: string | null;
  provider?: string | null;
  providerModelId?: string | null;
  scene?: string | null;
  stream?: number | null;
  effort?: string | null;
  protocol?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  cachedTokens?: number | null;
  /** 缓存写入 token 数（Anthropic cache_creation_input_tokens）；其他协议为 0。 */
  cacheCreationTokens?: number | null;
  totalTokens?: number | null;
  /** 成本快照（成本单位×1e6 整数）；价格未配置的历史/新行为 NULL。 */
  costMicros?: number | null;
  success?: number | null;
  errorMessage?: string | null;
  firstTokenMs?: number | null;
  durationMs?: number | null;
  retryCount?: number | null;
  createdAt?: string | null;
}

export interface LlmCallListFilter {
  userId?: number | null;
  sessionId?: number | null;
  agentId?: number | null;
  modelId?: number | null;
  scene?: string | null;
  success?: boolean | null;
  startAt?: string | null;
  endAt?: string | null;
}

export class LlmCallRepository {
  constructor(private readonly db: Db) {}

  async insert(row: LlmCallRow): Promise<number> {
    return this.db.insert('llm_call', {
      userId: row.userId ?? null,
      sessionId: row.sessionId ?? null,
      agentId: row.agentId ?? null,
      modelId: row.modelId ?? null,
      modelName: row.modelName ?? null,
      provider: row.provider ?? null,
      providerModelId: row.providerModelId ?? null,
      scene: row.scene ?? 'unknown',
      stream: row.stream ?? 0,
      effort: row.effort ?? null,
      protocol: row.protocol ?? null,
      promptTokens: row.promptTokens ?? 0,
      completionTokens: row.completionTokens ?? 0,
      cachedTokens: row.cachedTokens ?? 0,
      cacheCreationTokens: row.cacheCreationTokens ?? 0,
      totalTokens: row.totalTokens ?? 0,
      costMicros: row.costMicros ?? null,
      success: row.success ?? 0,
      errorMessage: row.errorMessage ?? null,
      firstTokenMs: row.firstTokenMs ?? null,
      durationMs: row.durationMs ?? 0,
      retryCount: row.retryCount ?? 0,
    });
  }

  async list(
    page: number,
    size: number,
    filter: LlmCallListFilter,
  ): Promise<{ records: LlmCallRow[]; total: number }> {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (filter.userId != null) {
      where.push('user_id = ?');
      params.push(filter.userId);
    }
    if (filter.sessionId != null) {
      where.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.agentId != null) {
      where.push('agent_id = ?');
      params.push(filter.agentId);
    }
    if (filter.modelId != null) {
      where.push('model_id = ?');
      params.push(filter.modelId);
    }
    if (filter.scene != null && filter.scene.trim() !== '') {
      where.push('scene = ?');
      params.push(filter.scene.trim());
    }
    if (filter.success != null) {
      where.push('success = ?');
      params.push(filter.success ? 1 : 0);
    }
    if (filter.startAt != null) {
      where.push('created_at >= ?');
      params.push(filter.startAt);
    }
    if (filter.endAt != null) {
      where.push('created_at <= ?');
      params.push(filter.endAt);
    }
    const whereSql = where.join(' AND ');
    const offset = Math.max(0, (page - 1) * size);
    const totalRow = await this.db.queryOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM llm_call WHERE ${whereSql}`,
      params,
    );
    const records = await this.db.query<LlmCallRow>(
      `SELECT * FROM llm_call WHERE ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, size, offset],
    );
    return { records, total: Number(totalRow?.c ?? 0) };
  }

  /**
   * run 轨迹的会话时间窗查询（走 idx_llm_call_session_created）。
   * created_at 是调用结束时刻（秒）。上界开放（endAtExclusive = null）时取到最新一条；
   * 下界开放（startAt = null）时从最早一条取（会话无用户消息时的未归属查询）。
   * 同秒内按 id 升序，保证空响应重试的连续多行顺序稳定。
   */
  selectBySessionWindow(sessionId: number, startAt: string | null, endAtExclusive: string | null): Promise<LlmCallRow[]> {
    const conditions = ['session_id = ?'];
    const params: unknown[] = [sessionId];
    if (startAt != null) {
      conditions.push('created_at >= ?');
      params.push(startAt);
    }
    if (endAtExclusive != null) {
      conditions.push('created_at < ?');
      params.push(endAtExclusive);
    }
    return this.db.query<LlmCallRow>(
      `SELECT * FROM llm_call WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC, id ASC`,
      params,
    );
  }
}
