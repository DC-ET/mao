import { describe, expect, it, vi } from 'vitest';
import { LlmCallRepository } from './llm-call.repository.js';

describe('LlmCallRepository 用户维度聚合', () => {
  function build(rows: Record<string, unknown>[] = [], one: Record<string, unknown> | null = null) {
    const query = vi.fn(async () => rows);
    const queryOne = vi.fn(async () => one);
    const repo = new LlmCallRepository({ query, queryOne } as never);
    return { repo, query, queryOne };
  }

  const WINDOW = { startAt: '2026-10-04 00:00:00', endAtExclusive: '2026-10-11 00:00:00' };

  it('aggregateSummary：user_id = ? 在最前，窗口参数随后；字符串数值转 number', async () => {
    const { repo, queryOne } = build([], {
      callCount: '12',
      successCount: '10',
      failCount: '1',
      cancelledCount: '1',
      promptTokens: '9000',
      completionTokens: '1000',
      cachedTokens: '3000',
      totalTokens: '10000',
      cost: '1.5',
    });
    const row = await repo.aggregateSummary(7, WINDOW);
    expect(row).toEqual({
      callCount: 12,
      successCount: 10,
      failCount: 1,
      cancelledCount: 1,
      promptTokens: 9000,
      completionTokens: 1000,
      cachedTokens: 3000,
      totalTokens: 10000,
      cost: 1.5,
    });
    const [sql, params] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE user_id = ? AND');
    expect(params).toEqual([7, '2026-10-04 00:00:00', '2026-10-11 00:00:00']);
  });

  it('aggregateSummary：failCount 排除取消、cancelledCount 单列（取消不是失败）', async () => {
    const { repo, queryOne } = build([], null);
    await repo.aggregateSummary(7, WINDOW);
    const [sql] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("SUM(CASE WHEN success = 0 AND (error_message IS NULL OR error_message NOT LIKE '%Cancelled by user%') THEN 1 ELSE 0 END)");
    expect(sql).toContain("SUM(CASE WHEN error_message LIKE '%Cancelled by user%' THEN 1 ELSE 0 END), 0) AS cancelledCount");
  });

  it('aggregateSummary：空窗口/空结果归零，不发 NULL', async () => {
    const { repo } = build([], null);
    await expect(repo.aggregateSummary(7, {})).resolves.toEqual({
      callCount: 0,
      successCount: 0,
      failCount: 0,
      cancelledCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      cost: 0,
    });
  });

  it('aggregateByModel：GROUP BY model_id 且 userId 注入；model_id 为 NULL 保留 null', async () => {
    const { repo, query } = build([
      { modelId: 3, modelName: 'GPT', callCount: '5', failCount: '0', cancelledCount: '1', promptTokens: '10', completionTokens: '2', totalTokens: '12', cost: '0.25' },
      { modelId: null, modelName: 'OLD', callCount: '2', failCount: '0', cancelledCount: '0', promptTokens: '1', completionTokens: '1', totalTokens: '2', cost: null },
    ]);
    const rows = await repo.aggregateByModel(7, WINDOW);
    expect(rows[0]).toEqual({ modelId: 3, modelName: 'GPT', callCount: 5, failCount: 0, cancelledCount: 1, promptTokens: 10, completionTokens: 2, totalTokens: 12, cost: 0.25 });
    expect(rows[1].modelId).toBeNull();
    expect(rows[1].cost).toBe(0);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('GROUP BY model_id');
    expect(sql).toContain('ORDER BY totalTokens DESC');
    expect(params).toEqual([7, '2026-10-04 00:00:00', '2026-10-11 00:00:00']);
  });

  it('aggregateByScene：scene 空归 unknown 分组', async () => {
    const { repo, query } = build([{ scene: 'agent', callCount: '3', failCount: '0', cancelledCount: '2', totalTokens: '30' }]);
    const rows = await repo.aggregateByScene(7, WINDOW);
    expect(rows).toEqual([{ scene: 'agent', callCount: 3, failCount: 0, cancelledCount: 2, totalTokens: 30 }]);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("COALESCE(scene, 'unknown')");
    expect(params[0]).toBe(7);
  });

  it('aggregateByAgent：GROUP BY agent_id 且 userId 注入；agent_id 为 NULL 保留 null、名字留空待 service 补', async () => {
    const { repo, query } = build([
      { agentId: 9, callCount: '40', failCount: '2', cancelledCount: '1', totalTokens: '400', cost: '1.25' },
      { agentId: null, callCount: '14', failCount: '0', cancelledCount: '0', totalTokens: '30', cost: null },
    ]);
    const rows = await repo.aggregateByAgent(7, WINDOW);
    expect(rows[0]).toEqual({ agentId: 9, agentName: null, callCount: 40, failCount: 2, cancelledCount: 1, totalTokens: 400, cost: 1.25 });
    expect(rows[1]).toEqual({ agentId: null, agentName: null, callCount: 14, failCount: 0, cancelledCount: 0, totalTokens: 30, cost: 0 });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('GROUP BY agent_id');
    expect(sql).toContain('ORDER BY totalTokens DESC');
    expect(params).toEqual([7, '2026-10-04 00:00:00', '2026-10-11 00:00:00']);
  });

  it('aggregateTrend：day 用 DATE()，hour 用 DATE_FORMAT 整点，均按桶升序；带 prompt/cached token', async () => {
    const dayDb = build([{ bucket: '2026-10-10', callCount: '2', failCount: '0', cancelledCount: '1', promptTokens: '900', cachedTokens: '300', totalTokens: '20', cost: '0.1' }]);
    const dayRows = await dayDb.repo.aggregateTrend(7, WINDOW, 'day');
    expect(dayRows).toEqual([{ bucket: '2026-10-10', callCount: 2, failCount: 0, cancelledCount: 1, promptTokens: 900, cachedTokens: 300, totalTokens: 20, cost: 0.1 }]);
    const [daySql] = dayDb.query.mock.calls[0] as [string, unknown[]];
    expect(daySql).toContain('DATE(created_at)');
    expect(daySql).not.toContain('DATE_FORMAT');
    expect(daySql).toContain('SUM(prompt_tokens)');
    expect(daySql).toContain('SUM(cached_tokens)');

    const hourDb = build([]);
    await hourDb.repo.aggregateTrend(7, WINDOW, 'hour');
    const [hourSql] = hourDb.query.mock.calls[0] as [string, unknown[]];
    expect(hourSql).toContain("DATE_FORMAT(created_at, '%Y-%m-%d %H:00')");
  });

  it('聚合窗口缺省时 WHERE 退化为 1=1，不拼出悬空 AND', async () => {
    const { repo, queryOne } = build();
    await repo.aggregateSummary(7, {});
    const [sql, params] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE user_id = ? AND 1=1');
    expect(params).toEqual([7]);
  });
});

describe('LlmCallRepository 列表筛选（成败 + 取消第三态）', () => {
  function build(rows: Record<string, unknown>[] = [], one: Record<string, unknown> | null = null) {
    const query = vi.fn(async () => rows);
    const queryOne = vi.fn(async () => one);
    const repo = new LlmCallRepository({ query, queryOne } as never);
    return { repo, query, queryOne };
  }

  it('success=true 仍是 success = 1；success=false 收窄为纯失败（排除取消）', async () => {
    const { repo, queryOne } = build();
    await repo.list(1, 20, { success: true });
    let [sql] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('success = 1');
    await repo.list(1, 20, { success: false });
    [sql] = queryOne.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('success = 0 AND (error_message IS NULL OR error_message NOT LIKE');
  });

  it('cancelled=true/false 分别按 LIKE / NOT LIKE 取消标记筛选', async () => {
    const { repo, queryOne } = build();
    await repo.list(1, 20, { cancelled: true });
    let [sql] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("error_message LIKE '%Cancelled by user%'");
    expect(sql).not.toContain('NOT LIKE');
    await repo.list(1, 20, { cancelled: false });
    [sql] = queryOne.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain("error_message IS NULL OR error_message NOT LIKE '%Cancelled by user%'");
  });
});

// 记录详情下钻（技术方案 2026-10-22-run-trace-deep-dive §5.3）：主键查询，
// 会话归属由调用方校验（row.sessionId 与路径 sessionId 不一致即视为不存在）。
describe('LlmCallRepository.selectById', () => {
  function build(one: Record<string, unknown> | null = null) {
    const query = vi.fn(async () => []);
    const queryOne = vi.fn(async () => one);
    const repo = new LlmCallRepository({ query, queryOne } as never);
    return { repo, queryOne };
  }

  it('按主键取整行；不存在返回 null', async () => {
    const { repo, queryOne } = build({ id: 42, sessionId: 1, provider: 'anthropic' });
    expect(await repo.selectById(42)).toEqual({ id: 42, sessionId: 1, provider: 'anthropic' });
    const [sql, params] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM llm_call WHERE id = ?');
    expect(params).toEqual([42]);

    const { repo: emptyRepo, queryOne: emptyOne } = build(null);
    expect(await emptyRepo.selectById(999)).toBeNull();
    expect(emptyOne.mock.calls[0]?.[1]).toEqual([999]);
  });
});
