import { describe, expect, it, vi } from 'vitest';
import { AgentReportRepository } from './agent-report.repository.js';

/**
 * 不 mock SQL 生成逻辑的回归测试（capture 风格，仿 feedback.repository.spec.ts）：
 * 捕获传给 Db 的 SQL 与参数，防 where 条件与表别名错位、updateStatus CAS 参数顺序漂移。
 */
function makeCaptureDb(options: { duplicate?: boolean; count?: number; affectedRows?: number } = {}) {
  const captured: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
      captured.push({ sql: `INSERT ${table}`, params: [row] });
      return 1;
    }),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      captured.push({ sql, params });
      return [];
    }),
    queryOne: vi.fn(async (sql: string, params: unknown[] = []) => {
      captured.push({ sql, params });
      if (/SELECT id FROM agent_report WHERE session_id/s.test(sql)) return options.duplicate ? { id: 1 } : null;
      if (/COUNT\(\*\)/s.test(sql)) return { c: options.count ?? 0 };
      return null;
    }),
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      captured.push({ sql, params });
      return { affectedRows: options.affectedRows ?? 1 };
    }),
  };
  return { repo: new AgentReportRepository(db as never), captured, db };
}

describe('AgentReportRepository', () => {
  it('insert 参数映射：camelCase 行 → snake_case 列由 db 层完成，status 固定 OPEN', async () => {
    const { repo, db } = makeCaptureDb();
    await repo.insert({
      sessionId: 11, userId: 7, agentId: 3,
      category: 'system_vulnerability', severity: 'critical', title: '沙箱逃逸', detail: '证据',
    });
    expect(db.insert).toHaveBeenCalledWith('agent_report', {
      sessionId: 11, userId: 7, agentId: 3,
      category: 'system_vulnerability', severity: 'critical', title: '沙箱逃逸', detail: '证据',
      status: 'OPEN',
    });
  });

  it('findDuplicate 按 session+category+title 查询；countBySession 按会话计数', async () => {
    const { repo, captured } = makeCaptureDb({ duplicate: true, count: 7 });
    expect(await repo.findDuplicate(11, 'other', 't')).toBe(true);
    expect(captured[0].params).toEqual([11, 'other', 't']);
    expect(await repo.countBySession(11)).toBe(7);
    expect(captured[1].sql).toContain('FROM agent_report WHERE session_id = ?');
  });

  it('pageList 拼装筛选条件与分页（状态/类别/级别/时间区间），JOIN 取名字', async () => {
    const { repo, captured } = makeCaptureDb();
    await repo.pageList({
      status: 'OPEN', category: 'tool_defect', severity: 'high',
      startDate: '2026-11-01', endDate: '2026-11-27', offset: 40, limit: 20,
    });
    const { sql, params } = captured[0];
    expect(sql).toContain('FROM agent_report r');
    expect(sql).toContain('LEFT JOIN agent a ON a.id = r.agent_id');
    expect(sql).toContain('r.status = ?');
    expect(sql).toContain('r.category = ?');
    expect(sql).toContain('r.severity = ?');
    expect(sql).toContain('r.created_at >= ?');
    expect(sql).toContain('r.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
    expect(sql).toContain('ORDER BY r.created_at DESC, r.id DESC');
    expect(params).toEqual(['OPEN', 'tool_defect', 'high', '2026-11-01', '2026-11-27', 20, 40]);
  });

  it('updateStatus 终态（RESOLVED）：落 resolved_* 三列，CAS 限定合法源态', async () => {
    const { repo, captured } = makeCaptureDb();
    const updated = await repo.updateStatus(5, 'RESOLVED', ['OPEN', 'ACKNOWLEDGED'], 99, '已修复');
    expect(updated).toBe(1);
    const { sql, params } = captured[0];
    expect(sql).toContain('resolved_by = ?');
    expect(sql).toContain('resolved_at = NOW()');
    expect(sql).toContain('WHERE id = ? AND status IN (?, ?)');
    expect(params).toEqual(['RESOLVED', '已修复', 99, 5, 'OPEN', 'ACKNOWLEDGED']);
  });

  it('updateStatus 非终态（ACKNOWLEDGED）：不动 resolved_* 列；并发处置返回 0', async () => {
    const { repo, captured } = makeCaptureDb({ affectedRows: 0 });
    const updated = await repo.updateStatus(5, 'ACKNOWLEDGED', ['OPEN'], 99, null);
    expect(updated).toBe(0);
    const { sql, params } = captured[0];
    expect(sql).not.toContain('resolved_by = ?');
    expect(sql).not.toContain('resolved_at = NOW()');
    expect(params).toEqual(['ACKNOWLEDGED', 5, 'OPEN']);
  });
});
