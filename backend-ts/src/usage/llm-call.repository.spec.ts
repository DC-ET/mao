import { describe, expect, it, vi } from 'vitest';
import { LlmCallRepository } from './llm-call.repository.js';

describe('LlmCallRepository 用户维度聚合', () => {
  function build(rows: Record<string, unknown>[] = [], one: Record<string, unknown> | null = null) {
    const query = vi.fn(async () => rows);
    const queryOne = vi.fn(async () => one);
    const repo = new LlmCallRepository({ query, queryOne } as never);
    return { repo, query, queryOne };
  }

  const WINDOW = { startAt: '2026-10-04 00:00:00', endAt: '2026-10-10 23:59:59' };

  it('aggregateSummary：user_id = ? 在最前，窗口参数随后；字符串数值转 number', async () => {
    const { repo, queryOne } = build([], {
      callCount: '12',
      successCount: '10',
      failCount: '2',
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
      failCount: 2,
      promptTokens: 9000,
      completionTokens: 1000,
      cachedTokens: 3000,
      totalTokens: 10000,
      cost: 1.5,
    });
    const [sql, params] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE user_id = ? AND');
    expect(params).toEqual([7, '2026-10-04 00:00:00', '2026-10-10 23:59:59']);
  });

  it('aggregateSummary：空窗口/空结果归零，不发 NULL', async () => {
    const { repo } = build([], null);
    await expect(repo.aggregateSummary(7, {})).resolves.toEqual({
      callCount: 0,
      successCount: 0,
      failCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      cost: 0,
    });
  });

  it('aggregateByModel：GROUP BY model_id 且 userId 注入；model_id 为 NULL 保留 null', async () => {
    const { repo, query } = build([
      { modelId: 3, modelName: 'GPT', callCount: '5', failCount: '1', promptTokens: '10', completionTokens: '2', totalTokens: '12', cost: '0.25' },
      { modelId: null, modelName: 'OLD', callCount: '2', failCount: '0', promptTokens: '1', completionTokens: '1', totalTokens: '2', cost: null },
    ]);
    const rows = await repo.aggregateByModel(7, WINDOW);
    expect(rows[0]).toEqual({ modelId: 3, modelName: 'GPT', callCount: 5, failCount: 1, promptTokens: 10, completionTokens: 2, totalTokens: 12, cost: 0.25 });
    expect(rows[1].modelId).toBeNull();
    expect(rows[1].cost).toBe(0);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('GROUP BY model_id');
    expect(sql).toContain('ORDER BY totalTokens DESC');
    expect(params).toEqual([7, '2026-10-04 00:00:00', '2026-10-10 23:59:59']);
  });

  it('aggregateByScene：scene 空归 unknown 分组', async () => {
    const { repo, query } = build([{ scene: 'agent', callCount: '3', failCount: '0', totalTokens: '30' }]);
    const rows = await repo.aggregateByScene(7, WINDOW);
    expect(rows).toEqual([{ scene: 'agent', callCount: 3, failCount: 0, totalTokens: 30 }]);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("COALESCE(scene, 'unknown')");
    expect(params[0]).toBe(7);
  });

  it('aggregateTrend：day 用 DATE()，hour 用 DATE_FORMAT 整点，均按桶升序', async () => {
    const dayDb = build([{ bucket: '2026-10-10', callCount: '2', failCount: '0', totalTokens: '20', cost: '0.1' }]);
    const dayRows = await dayDb.repo.aggregateTrend(7, WINDOW, 'day');
    expect(dayRows).toEqual([{ bucket: '2026-10-10', callCount: 2, failCount: 0, totalTokens: 20, cost: 0.1 }]);
    const [daySql] = dayDb.query.mock.calls[0] as [string, unknown[]];
    expect(daySql).toContain('DATE(created_at)');
    expect(daySql).not.toContain('DATE_FORMAT');

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
