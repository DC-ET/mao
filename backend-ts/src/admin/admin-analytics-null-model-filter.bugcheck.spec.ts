import { describe, expect, it, vi } from 'vitest';
import { AdminAnalyticsDbStore, type AnalyticsRange } from './admin-analytics.service.js';
import { LlmCallRepository } from '../usage/llm-call.repository.js';

/**
 * 模型维度聚合把 model_id IS NULL 归并为 id=0（「未关联模型」），
 * 但筛选（分析页场景下钻 / llm-calls 明细列表）却写 `model_id = 0` —— NULL 永不命中，
 * 点进去恒为空列表。正确口径：筛选 0 时必须落 `model_id IS NULL`。
 */
const range: AnalyticsRange = {
  days: 1,
  startYmd: '2026-01-01',
  endYmd: '2026-01-01',
  startAt: '2026-01-01 00:00:00',
  endAtExclusive: '2026-01-02 00:00:00',
};

function captureDb() {
  return {
    query: vi.fn(async () => []),
    queryOne: vi.fn(async () => null),
  };
}

describe('modelId=0（未关联模型）筛选必须命中 NULL 行', () => {
  it('分析页场景分布：模型 0 下钻应生成 model_id IS NULL', async () => {
    const db = captureDb();
    const store = new AdminAnalyticsDbStore(db as never);
    await store.selectLlmCallSceneStats(range, { modelId: 0 });

    const [sql, params] = db.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('model_id IS NULL');
    expect(sql).not.toMatch(/model_id\s*=\s*\?/);
    expect(params).not.toContain(0);
  });

  it('调用明细列表：modelId=0 时应生成 model_id IS NULL（列表与计数同条件）', async () => {
    const db = captureDb();
    const repo = new LlmCallRepository(db as never);
    await repo.list(1, 20, { modelId: 0 });

    const countSql = (db.queryOne.mock.calls[0] as unknown as [string])[0];
    const listSql = (db.query.mock.calls[0] as unknown as [string])[0];
    for (const sql of [countSql, listSql]) {
      expect(sql).toContain('model_id IS NULL');
      expect(sql).not.toMatch(/model_id\s*=\s*\?/);
    }
  });

  it('对照：具体模型 id 仍按等值筛选', async () => {
    const db = captureDb();
    const repo = new LlmCallRepository(db as never);
    await repo.list(1, 20, { modelId: 7 });
    const [sql, params] = db.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/model_id\s*=\s*\?/);
    expect(params).toContain(7);
  });
});
