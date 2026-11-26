import { createHash } from 'node:crypto';
import type { Db } from '../db/db.js';
import { CANCELLED_SQL, NOT_CANCELLED_SQL } from '../common/llm-cancel.js';
import type {
  LlmCallAgentAggRow,
  LlmCallModelAggRow,
  LlmCallSceneAggRow,
  LlmCallSummaryRow,
  LlmCallTrendRow,
  TrendGranularity,
} from '@mao/contracts';

/**
 * 轻列清单：除 system_prompt / system_prompt_sha / tools_json 外的全部业务列。
 * system_prompt 是 V172 请求构成原文（单行最坏 ~256K 字符）；V212 起新行改为只存
 * system_prompt_sha，正文在 llm_call_system_prompt。列表（list）与轨迹窗口查询
 * （selectBySessionWindow）只走轻列——原文只随记录详情的 selectById 按需读取
 * （技术方案 2026-10-25-run-trace-content-and-prompt §5.7 / 2026-10-22-run-trace-deep-dive
 * 决策 9 的防膨胀口径），否则每页列表与每次开轨迹面板都会把全会话提示词全文拉进内存。
 * sha 本身不大，但列表用不到，留在轻列外也避免 SQL 断言把 system_prompt_sha 误当成原文列。
 * db 层统一做 snake→camel 映射，无需逐列别名。
 */

/** 系统提示词正文的内容寻址键：UTF-8 字节的 SHA-256，小写 hex（64 字符）。 */
export function hashLlmCallSystemPrompt(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const LLM_CALL_LIGHT_COLUMNS = [
  'id', 'user_id', 'session_id', 'agent_id', 'model_id', 'model_name', 'provider', 'provider_model_id',
  'scene', 'stream', 'effort', 'protocol', 'prompt_tokens', 'completion_tokens', 'cached_tokens',
  'cache_creation_tokens', 'total_tokens', 'cost_micros', 'success', 'error_message',
  'first_token_ms', 'duration_ms', 'retry_count', 'created_at',
].join(', ');

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
  /**
   * 请求构成采集（V172）：系统提示词原文（截断带标记）。
   * V212 起新行此列为 NULL，原文在 llm_call_system_prompt，由 selectById 按 sha 填回。
   * 历史行仍直接带原文。无 system 消息时为 NULL。
   */
  systemPrompt?: string | null;
  /** 指向 llm_call_system_prompt.sha。NULL = 未走去重（历史行读 system_prompt / 无 system 消息）。 */
  systemPromptSha?: string | null;
  /** 请求的工具名清单（JSON 字符串数组）；历史行 / 无工具为 NULL。 */
  toolsJson?: string | null;
  createdAt?: string | null;
}

export interface LlmCallListFilter {
  userId?: number | null;
  sessionId?: number | null;
  agentId?: number | null;
  modelId?: number | null;
  scene?: string | null;
  success?: boolean | null;
  /**
   * 取消筛选（第三态，按 error_message 推导，无独立列）。
   * true = 只要取消；false = 排除取消。与 success=false 组合时取交集。
   */
  cancelled?: boolean | null;
  startAt?: string | null;
  /** 排他上界（次日 00:00:00），不是结束日 23:59:59；见 LlmCallAggFilter 注释。 */
  endAtExclusive?: string | null;
}

/** 聚合窗口：半开区间 [startAt, endAtExclusive)，两端均可缺省（缺省=不限）。 */
export interface LlmCallAggFilter {
  startAt?: string | null;
  endAtExclusive?: string | null;
}

/**
 * 聚合行 / 趋势横轴类型：契约下沉 @mao/contracts（2026-11-10 用户用量方案），
 * 这里 re-export 保持既有 import 路径不变；事实源见 shared/contracts/src/usage.ts。
 */
export type {
  TrendGranularity,
  LlmCallSummaryRow,
  LlmCallModelAggRow,
  LlmCallSceneAggRow,
  LlmCallAgentAggRow,
  LlmCallTrendRow,
} from '@mao/contracts';

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

/**
 * 解码聚合（技术方案 2026-10-27-llm-output-speed §5.1）：吞吐量 = 输出 tokens ÷ 解码耗时，
 * 解码耗时 = duration_ms − first_token_ms。只统计「可解码行」——与 desktop utils/throughput.ts 的
 * throughput() 逐条同口径：流式（first_token_ms 非空）、解码 > 0（first_token_ms 严格早于结束：
 * 取等会把解码为 0 的行算成「瞬时出完」，其 tokens 进分子而耗时不进分母，单方面抬高均速）、
 * 输出 > 0（失败行 completion_tokens 通常为 0，自然不进分子）。非流式调用两列都不计，
 * 前端据此显示「—」，不用总耗时兜底（兜底会把 prefill 算进去，与流式行不可比）。
 */
const DECODE_AGGS = `COALESCE(SUM(CASE WHEN first_token_ms IS NOT NULL AND first_token_ms < duration_ms AND completion_tokens > 0
                  THEN completion_tokens ELSE 0 END), 0) AS decodeTokens,
       COALESCE(SUM(CASE WHEN first_token_ms IS NOT NULL AND first_token_ms < duration_ms AND completion_tokens > 0
                  THEN duration_ms - first_token_ms ELSE 0 END), 0) AS decodeMs`;

export class LlmCallRepository {
  constructor(private readonly db: Db) {}

  /**
   * 聚合 WHERE：半开窗口 + 场景 + 成败（userId 由各聚合方法强制注入，不走这里）。
   *
   * `qualifier` 给需要 JOIN 的聚合用（如 aggregateByModel 的 LEFT JOIN llm_model）：
   * llm_model 也有 `model_id` / `created_at` 列，裸列名会撞 MySQL 的 1052
   * "Column ... is ambiguous"。其余聚合不 JOIN，传空串即维持原样。
   */
  private aggWhere(
    filter: LlmCallAggFilter & { scene?: string | null; success?: boolean | null },
    qualifier = '',
  ): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.startAt != null) {
      clauses.push(`${qualifier}created_at >= ?`);
      params.push(filter.startAt);
    }
    if (filter.endAtExclusive != null) {
      clauses.push(`${qualifier}created_at < ?`);
      params.push(filter.endAtExclusive);
    }
    if (filter.scene != null && filter.scene.trim() !== '') {
      clauses.push(`${qualifier}scene = ?`);
      params.push(filter.scene.trim());
    }
    if (filter.success != null) {
      clauses.push(`${qualifier}success = ?`);
      params.push(filter.success ? 1 : 0);
    }
    return { sql: clauses.length > 0 ? clauses.join(' AND ') : '1=1', params };
  }

  async insert(row: LlmCallRow): Promise<number> {
    // 新行不写 system_prompt 全文。相同原文 INSERT IGNORE 只留一行；哈希冲突在 SHA-256 下忽略。
    // 调用行插入失败时可能留下无人引用的正文，体积是一份原文，下次相同内容会命中已有行。
    const systemPrompt = row.systemPrompt ?? null;
    const systemPromptSha = systemPrompt != null ? hashLlmCallSystemPrompt(systemPrompt) : null;
    if (systemPrompt != null && systemPromptSha != null) {
      await this.db.execute(
        'INSERT IGNORE INTO `llm_call_system_prompt` (`sha`, `body`) VALUES (?, ?)',
        [systemPromptSha, systemPrompt],
      );
    }
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
      systemPrompt: null,
      systemPromptSha,
      toolsJson: row.toolsJson ?? null,
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
      // 与模型维度聚合的 COALESCE(model_id, 0) 同口径：0 代表「未关联模型」= NULL 行。
      if (filter.modelId === 0) {
        where.push('model_id IS NULL');
      } else {
        where.push('model_id = ?');
        params.push(filter.modelId);
      }
    }
    if (filter.scene != null && filter.scene.trim() !== '') {
      where.push('scene = ?');
      params.push(filter.scene.trim());
    }
    if (filter.success != null) {
      // success=false 是「纯失败」：取消单列一档，不混在失败里（历史口径取消也计失败，见 CHANGELOG）
      where.push(filter.success ? 'success = 1' : `success = 0 AND ${NOT_CANCELLED_SQL}`);
    }
    if (filter.cancelled != null) {
      where.push(filter.cancelled ? CANCELLED_SQL : NOT_CANCELLED_SQL);
    }
    if (filter.startAt != null) {
      where.push('created_at >= ?');
      params.push(filter.startAt);
    }
    if (filter.endAtExclusive != null) {
      where.push('created_at < ?');
      params.push(filter.endAtExclusive);
    }
    const whereSql = where.join(' AND ');
    const offset = Math.max(0, (page - 1) * size);
    const totalRow = await this.db.queryOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM llm_call WHERE ${whereSql}`,
      params,
    );
    // created_at 倒序、id 打破同一毫秒的并列。InnoDB 二级索引隐式带主键，
    // idx_llm_call_created 能按这个顺序倒扫，时间窗里读满一页就停。
    const records = await this.db.query<LlmCallRow>(
      `SELECT ${LLM_CALL_LIGHT_COLUMNS} FROM llm_call WHERE ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
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
      `SELECT ${LLM_CALL_LIGHT_COLUMNS} FROM llm_call WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC, id ASC`,
      params,
    );
  }

  /**
   * 主键查询（运行轨迹记录详情下钻用）：llm_call 行按 id 取，会话归属由调用方校验
   * （row.sessionId 与路径 sessionId 不一致即视为不存在，防越权读他人会话的调用行）。
   */
  async selectById(id: number): Promise<LlmCallRow | null> {
    const row = await this.db.queryOne<LlmCallRow>(`SELECT * FROM llm_call WHERE id = ?`, [id]);
    if (row == null) return null;
    // 新行：按哈希取去重正文，填回 systemPrompt，调用方（轨迹详情）不用知道存储拆分。
    // 正文缺失时留着原列——新行原列是 NULL，历史行哈希为空、不会进这个分支。
    const sha = row.systemPromptSha;
    if (sha != null && sha !== '') {
      const blob = await this.db.queryOne<{ body?: string | null }>(
        'SELECT `body` FROM `llm_call_system_prompt` WHERE `sha` = ?',
        [sha],
      );
      if (blob?.body != null) row.systemPrompt = blob.body;
    }
    return row;
  }

  /** 用户维度窗口总览：一次取调用数/成败/token 四项/成本（走 user_created 索引）。 */
  async aggregateSummary(userId: number, filter: LlmCallAggFilter): Promise<LlmCallSummaryRow> {
    const { sql, params } = this.aggWhere(filter);
    const row = await this.db.queryOne<Record<string, unknown>>(
      `SELECT COUNT(*) AS callCount,
              COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) AS successCount,
              COALESCE(SUM(CASE WHEN success = 0 AND ${NOT_CANCELLED_SQL} THEN 1 ELSE 0 END), 0) AS failCount,
              COALESCE(SUM(CASE WHEN ${CANCELLED_SQL} THEN 1 ELSE 0 END), 0) AS cancelledCount,
              COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
              COALESCE(SUM(completion_tokens), 0) AS completionTokens,
              COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
              COALESCE(SUM(total_tokens), 0) AS totalTokens,
              COALESCE(SUM(cost_micros), 0) / 1000000 AS cost,
              ${DECODE_AGGS}
       FROM llm_call
       WHERE user_id = ? AND ${sql}`,
      [userId, ...params],
    );
    return {
      callCount: toNumber(row?.callCount),
      successCount: toNumber(row?.successCount),
      failCount: toNumber(row?.failCount),
      cancelledCount: toNumber(row?.cancelledCount),
      promptTokens: toNumber(row?.promptTokens),
      completionTokens: toNumber(row?.completionTokens),
      cachedTokens: toNumber(row?.cachedTokens),
      totalTokens: toNumber(row?.totalTokens),
      cost: toNumber(row?.cost),
      decodeTokens: toNumber(row?.decodeTokens),
      decodeMs: toNumber(row?.decodeMs),
    };
  }

  /**
   * 按模型汇总（model_id 为 NULL 的历史行归并为 id=null 一组，按 token 降序）。
   *
   * LEFT JOIN llm_model 取 model_type（技术方案 2026-11-24 §7.2）后，**所有 llm_call 的
   * 列引用都必须带 `llm_call.` 前缀**：llm_model 同样有 `model_id` 与 `created_at` 列，
   * 裸列名会撞 MySQL 1052 "Column ... is ambiguous"——已对真实 MySQL 复现，
   * 单测 mock 了 db.query 所以抓不到（故新增下面的 SQL 形态断言 + 集成校验）。
   */
  async aggregateByModel(userId: number, filter: LlmCallAggFilter): Promise<LlmCallModelAggRow[]> {
    const { sql, params } = this.aggWhere(filter, 'llm_call.');
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT llm_call.model_id AS modelId,
              MAX(llm_call.model_name) AS modelName,
              MAX(m.model_type) AS modelType,
              COUNT(*) AS callCount,
              COALESCE(SUM(CASE WHEN llm_call.success = 0 AND ${NOT_CANCELLED_SQL} THEN 1 ELSE 0 END), 0) AS failCount,
              COALESCE(SUM(CASE WHEN ${CANCELLED_SQL} THEN 1 ELSE 0 END), 0) AS cancelledCount,
              COALESCE(SUM(llm_call.prompt_tokens), 0) AS promptTokens,
              COALESCE(SUM(llm_call.completion_tokens), 0) AS completionTokens,
              COALESCE(SUM(llm_call.total_tokens), 0) AS totalTokens,
              COALESCE(SUM(llm_call.cost_micros), 0) / 1000000 AS cost
       FROM llm_call
       LEFT JOIN llm_model m ON m.id = llm_call.model_id
       WHERE llm_call.user_id = ? AND ${sql}
       GROUP BY llm_call.model_id
       ORDER BY totalTokens DESC`,
      [userId, ...params],
    );
    return rows.map((r) => ({
      modelId: r.modelId == null ? null : toNumber(r.modelId),
      modelName: (r.modelName as string | null) ?? null,
      // 模型类型（技术方案 2026-11-24 §7.2）：LEFT JOIN 取不到为 null，前端归「未知」。
      // 取不到只发生在物理删行 / 历史行——本 JOIN 刻意不过滤 `m.deleted`，所以软删的模型
      // 仍会带出历史 model_type（展示历史类型比显示「未知」更有用）。
      // 用 MAX 聚合而非裸选：GROUP BY model_id 下裸选 join 列会撞
      // ONLY_FULL_GROUP_BY（MySQL8 默认），model_id 相同则 model_type 必然相同，MAX 无损。
      modelType: r.modelType == null ? null : String(r.modelType),
      callCount: toNumber(r.callCount),
      failCount: toNumber(r.failCount),
      cancelledCount: toNumber(r.cancelledCount),
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
              COALESCE(SUM(CASE WHEN success = 0 AND ${NOT_CANCELLED_SQL} THEN 1 ELSE 0 END), 0) AS failCount,
              COALESCE(SUM(CASE WHEN ${CANCELLED_SQL} THEN 1 ELSE 0 END), 0) AS cancelledCount,
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
      cancelledCount: toNumber(r.cancelledCount),
      totalTokens: toNumber(r.totalTokens),
    }));
  }

  /** 按 Agent 汇总（agent_id 为 NULL 的调用保留为 id=null 一组，按 token 降序）。 */
  async aggregateByAgent(userId: number, filter: LlmCallAggFilter): Promise<LlmCallAgentAggRow[]> {
    const { sql, params } = this.aggWhere(filter);
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT agent_id AS agentId,
              COUNT(*) AS callCount,
              COALESCE(SUM(CASE WHEN success = 0 AND ${NOT_CANCELLED_SQL} THEN 1 ELSE 0 END), 0) AS failCount,
              COALESCE(SUM(CASE WHEN ${CANCELLED_SQL} THEN 1 ELSE 0 END), 0) AS cancelledCount,
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
      cancelledCount: toNumber(r.cancelledCount),
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
              COALESCE(SUM(CASE WHEN success = 0 AND ${NOT_CANCELLED_SQL} THEN 1 ELSE 0 END), 0) AS failCount,
              COALESCE(SUM(CASE WHEN ${CANCELLED_SQL} THEN 1 ELSE 0 END), 0) AS cancelledCount,
              COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
              COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
              COALESCE(SUM(total_tokens), 0) AS totalTokens,
              COALESCE(SUM(cost_micros), 0) / 1000000 AS cost,
              ${DECODE_AGGS}
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
      cancelledCount: toNumber(r.cancelledCount),
      promptTokens: toNumber(r.promptTokens),
      cachedTokens: toNumber(r.cachedTokens),
      totalTokens: toNumber(r.totalTokens),
      cost: toNumber(r.cost),
      decodeTokens: toNumber(r.decodeTokens),
      decodeMs: toNumber(r.decodeMs),
    }));
  }
}
