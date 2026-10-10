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

/** 聚合窗口：闭区间 [startAt, endAt]，两端均可缺省（缺省=不限）。 */
export interface LlmCallAggFilter {
  startAt?: string | null;
  endAt?: string | null;
}

/** 趋势横轴：day 为日历日，hour 为整点（口径同管理后台 admin-analytics）。 */
export type TrendGranularity = 'day' | 'hour';

export interface LlmCallSummaryRow {
  callCount: number;
  successCount: number;
  failCount: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  /** 窗口内成本合计（成本单位 = 模型价格填写口径；未配价行 cost_micros 为 NULL，SUM 自动忽略）。 */
  cost: number;
}

export interface LlmCallModelAggRow {
  modelId: number | null;
  modelName: string | null;
  callCount: number;
  failCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}

export interface LlmCallSceneAggRow {
  scene: string;
  callCount: number;
  failCount: number;
  totalTokens: number;
}

/** 按 Agent 汇总（agent_id 为 NULL 的调用——压缩/标题等无归属场景——保留为 id=null 一组）。 */
export interface LlmCallAgentAggRow {
  agentId: number | null;
  agentName: string | null;
  callCount: number;
  failCount: number;
  totalTokens: number;
  cost: number;
}

export interface LlmCallTrendRow {
  bucket: string;
  callCount: number;
  failCount: number;
  promptTokens: number;
  cachedTokens: number;
  totalTokens: number;
  cost: number;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value == null) return 0;
  return Number(value);
}

function trendBucketExpr(granularity: TrendGranularity): string {
  return granularity === 'hour'
    ? `DATE_FORMAT(created_at, '%Y-%m-%d %H:00')`
    : `DATE(created_at)`;
}

export class LlmCallRepository {
  constructor(private readonly db: Db) {}

  /** 聚合 WHERE：窗口 + 场景 + 成败（userId 由各聚合方法强制注入，不走这里）。 */
  private aggWhere(filter: LlmCallAggFilter & { scene?: string | null; success?: boolean | null }): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.startAt != null) {
      clauses.push('created_at >= ?');
      params.push(filter.startAt);
    }
    if (filter.endAt != null) {
      clauses.push('created_at <= ?');
      params.push(filter.endAt);
    }
    if (filter.scene != null && filter.scene.trim() !== '') {
      clauses.push('scene = ?');
      params.push(filter.scene.trim());
    }
    if (filter.success != null) {
      clauses.push('success = ?');
      params.push(filter.success ? 1 : 0);
    }
    return { sql: clauses.length > 0 ? clauses.join(' AND ') : '1=1', params };
  }

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

  /** 用户维度窗口总览：一次取调用数/成败/token 四项/成本（走 user_created 索引）。 */
  async aggregateSummary(userId: number, filter: LlmCallAggFilter): Promise<LlmCallSummaryRow> {
    const { sql, params } = this.aggWhere(filter);
    const row = await this.db.queryOne<Record<string, unknown>>(
      `SELECT COUNT(*) AS callCount,
              COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) AS successCount,
              COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS failCount,
              COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
              COALESCE(SUM(completion_tokens), 0) AS completionTokens,
              COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
              COALESCE(SUM(total_tokens), 0) AS totalTokens,
              COALESCE(SUM(cost_micros), 0) / 1000000 AS cost
       FROM llm_call
       WHERE user_id = ? AND ${sql}`,
      [userId, ...params],
    );
    return {
      callCount: toNumber(row?.callCount),
      successCount: toNumber(row?.successCount),
      failCount: toNumber(row?.failCount),
      promptTokens: toNumber(row?.promptTokens),
      completionTokens: toNumber(row?.completionTokens),
      cachedTokens: toNumber(row?.cachedTokens),
      totalTokens: toNumber(row?.totalTokens),
      cost: toNumber(row?.cost),
    };
  }

  /** 按模型汇总（model_id 为 NULL 的历史行归并为 id=null 一组，按 token 降序）。 */
  async aggregateByModel(userId: number, filter: LlmCallAggFilter): Promise<LlmCallModelAggRow[]> {
    const { sql, params } = this.aggWhere(filter);
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT model_id AS modelId,
              MAX(model_name) AS modelName,
              COUNT(*) AS callCount,
              COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS failCount,
              COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
              COALESCE(SUM(completion_tokens), 0) AS completionTokens,
              COALESCE(SUM(total_tokens), 0) AS totalTokens,
              COALESCE(SUM(cost_micros), 0) / 1000000 AS cost
       FROM llm_call
       WHERE user_id = ? AND ${sql}
       GROUP BY model_id
       ORDER BY totalTokens DESC`,
      [userId, ...params],
    );
    return rows.map((r) => ({
      modelId: r.modelId == null ? null : toNumber(r.modelId),
      modelName: (r.modelName as string | null) ?? null,
      callCount: toNumber(r.callCount),
      failCount: toNumber(r.failCount),
      promptTokens: toNumber(r.promptTokens),
      completionTokens: toNumber(r.completionTokens),
      totalTokens: toNumber(r.totalTokens),
      cost: toNumber(r.cost),
    }));
  }

  /** 按场景汇总（scene 为空归入 unknown，按 token 降序）。 */
  async aggregateByScene(userId: number, filter: LlmCallAggFilter): Promise<LlmCallSceneAggRow[]> {
    const { sql, params } = this.aggWhere(filter);
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT COALESCE(scene, 'unknown') AS scene,
              COUNT(*) AS callCount,
              COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS failCount,
              COALESCE(SUM(total_tokens), 0) AS totalTokens
       FROM llm_call
       WHERE user_id = ? AND ${sql}
       GROUP BY COALESCE(scene, 'unknown')
       ORDER BY totalTokens DESC`,
      [userId, ...params],
    );
    return rows.map((r) => ({
      scene: String(r.scene ?? 'unknown'),
      callCount: toNumber(r.callCount),
      failCount: toNumber(r.failCount),
      totalTokens: toNumber(r.totalTokens),
    }));
  }

  /** 按 Agent 汇总（agent_id 为 NULL 的调用保留为 id=null 一组，按 token 降序）。 */
  async aggregateByAgent(userId: number, filter: LlmCallAggFilter): Promise<LlmCallAgentAggRow[]> {
    const { sql, params } = this.aggWhere(filter);
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT agent_id AS agentId,
              COUNT(*) AS callCount,
              COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS failCount,
              COALESCE(SUM(total_tokens), 0) AS totalTokens,
              COALESCE(SUM(cost_micros), 0) / 1000000 AS cost
       FROM llm_call
       WHERE user_id = ? AND ${sql}
       GROUP BY agent_id
       ORDER BY totalTokens DESC`,
      [userId, ...params],
    );
    return rows.map((r) => ({
      agentId: r.agentId == null ? null : toNumber(r.agentId),
      agentName: null,
      callCount: toNumber(r.callCount),
      failCount: toNumber(r.failCount),
      totalTokens: toNumber(r.totalTokens),
      cost: toNumber(r.cost),
    }));
  }

  /** 按天/小时分桶的趋势序列（只有有数据的桶；缺失日期由前端按序列补零）。 */
  async aggregateTrend(
    userId: number,
    filter: LlmCallAggFilter,
    granularity: TrendGranularity = 'day',
  ): Promise<LlmCallTrendRow[]> {
    const { sql, params } = this.aggWhere(filter);
    const bucket = trendBucketExpr(granularity);
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${bucket} AS bucket,
              COUNT(*) AS callCount,
              COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS failCount,
              COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
              COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
              COALESCE(SUM(total_tokens), 0) AS totalTokens,
              COALESCE(SUM(cost_micros), 0) / 1000000 AS cost
       FROM llm_call
       WHERE user_id = ? AND ${sql}
       GROUP BY ${bucket}
       ORDER BY ${bucket} ASC`,
      [userId, ...params],
    );
    return rows.map((r) => ({
      bucket: String(r.bucket ?? ''),
      callCount: toNumber(r.callCount),
      failCount: toNumber(r.failCount),
      promptTokens: toNumber(r.promptTokens),
      cachedTokens: toNumber(r.cachedTokens),
      totalTokens: toNumber(r.totalTokens),
      cost: toNumber(r.cost),
    }));
  }
}
