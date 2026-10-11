import { describe, expect, it, vi } from 'vitest';
import { AnalyticsService, AnalyticsDbStore, type AnalyticsStore } from './analytics.service.js';
import type { Db } from '../db/db.js';

/**
 * 回归（BUG-4）：analytics 日窗口曾用 `23:59:59` 闭区间上界统计 session / message 的
 * created_at。V142 已把这两列提升为 DATETIME(3)，字典序上 '...59.000' > '...59'，
 * 每天最后一秒（23:59:59.001 ~ .999）的全部行恒不计数。
 *
 * 修复改为半开区间 [当日 00:00:00, 次日 00:00:00)，与 admin-analytics 的
 * endAtExclusive、message-search 的 createdToExclusive 同口径。
 */

/** 记录 analytics 实际下发的窗口边界。 */
function storeCapturing(captured: Array<{ start: string; end: string }>): AnalyticsStore {
  const push = async (start: string, end: string) => { captured.push({ start, end }); return 0; };
  return {
    countSessionsBetween: vi.fn(push),
    countMessagesBetween: vi.fn(push),
    selectTokenStatsGroupByAgent: vi.fn(),
    listAgents: vi.fn(),
    getAgent: vi.fn(),
    listUsers: vi.fn(),
    countSessionsByUser: vi.fn(),
    listSessionsByUser: vi.fn(),
    countMessagesBySessionIds: vi.fn(),
    listSessionsByAgent: vi.fn(),
    listMessagesBySession: vi.fn(),
  } as unknown as AnalyticsStore;
}

describe('BUG-4 回归：DATETIME(3) 下 analytics 日窗口必须覆盖最后一秒', () => {
  it('G1 日窗口上界是次日 00:00:00（半开区间），覆盖 23:59:59.999', async () => {
    const captured: Array<{ start: string; end: string }> = [];
    await new AnalyticsService(storeCapturing(captured)).getUsageTrends(1);
    const { start, end } = captured[0]!;
    const day = start.slice(0, 10);
    console.log('G1 start =', start, '；end =', end);
    // 上界必须是 start 当日次日的 00:00:00，且 > 当日 23:59:59.999
    expect(end).toBe(`${addDay(day)} 00:00:00`);
    expect(end > `${day} 23:59:59.999`).toBe(true);
  });

  it('G2 AnalyticsDbStore 的 SQL 用半开区间 < 比较 DATETIME(3) 列', async () => {
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      queryOne: vi.fn(async (sql: string, params: unknown[]) => {
        executed.push({ sql, params });
        return { c: 0 };
      }),
    } as unknown as Db;
    const store = new AnalyticsDbStore(db);
    await store.countMessagesBetween('2026-10-01 00:00:00', '2026-10-02 00:00:00');
    const { sql, params } = executed[0]!;
    console.log('G2 SQL =', sql.replace(/\s+/g, ' '));
    expect(sql).toContain('created_at < ?');
    expect(sql).not.toContain('created_at <= ?');
    expect(params).toEqual(['2026-10-01 00:00:00', '2026-10-02 00:00:00']);
  });

  it('G3 多日窗口逐日半开，相邻两天的窗口首尾相接', async () => {
    const captured: Array<{ start: string; end: string }> = [];
    await new AnalyticsService(storeCapturing(captured)).getUsageTrends(3);
    // 每天两次调用（session + message），成对且参数一致
    expect(captured).toHaveLength(6);
    const days: string[] = [];
    for (let i = 0; i < captured.length; i += 2) {
      const [sessions, messages] = [captured[i]!, captured[i + 1]!];
      expect(sessions).toEqual(messages);
      days.push(sessions.start.slice(0, 10));
      expect(sessions.end).toBe(`${addDay(sessions.start.slice(0, 10))} 00:00:00`);
    }
    expect(days).toHaveLength(3);
    expect(new Set(days).size).toBe(3);
    // 相邻两天首尾相接：昨天的上界 = 今天的下界（既不重叠也不漏边界）
    for (let i = 1; i < days.length; i++) {
      expect(`${addDay(days[i - 1]!)} 00:00:00`).toBe(captured[i * 2]!.start);
    }
  });
});

function addDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
