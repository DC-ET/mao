import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_REPORT_DETAIL_MAX_CHARS,
  AGENT_REPORT_MAX_PER_SESSION,
  AGENT_REPORT_TITLE_MAX_CHARS,
  AgentReportService,
} from './agent-report.service.js';
import { AgentReportRepository } from './agent-report.repository.js';
import { ErrorCode } from '../common/error-code.js';

function makeService(options: {
  duplicate?: boolean;
  sessionCount?: number;
} = {}) {
  const repository = {
    insert: vi.fn(async () => 1),
    findDuplicate: vi.fn(async () => options.duplicate ?? false),
    countBySession: vi.fn(async () => options.sessionCount ?? 0),
  };
  return {
    service: new AgentReportService(repository as unknown as AgentReportRepository),
    repository,
  };
}

const BASE = { sessionId: 11, userId: 7, agentId: 3, category: 'tool_defect', title: 'shell 工具循环失败' };

describe('AgentReportService.reportFromTool', () => {
  it('正常上报：severity 透传，insert 收到截断后的 title/detail', async () => {
    const { service, repository } = makeService();
    const result = await service.reportFromTool({ ...BASE, severity: 'high', detail: '证据' });
    expect(result).toEqual({ ok: true, duplicate: false });
    expect(repository.insert).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 11, userId: 7, agentId: 3,
      category: 'tool_defect', severity: 'high', title: 'shell 工具循环失败', detail: '证据',
    }));
  });

  it('category 非法：返回错误让模型修正，不插库（静默归 other 会掩盖模型漂移）', async () => {
    const { service, repository } = makeService();
    const result = await service.reportFromTool({ ...BASE, category: 'weird' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('无效的 category');
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('title 空：报错不插库', async () => {
    const { service, repository } = makeService();
    for (const title of ['', '   ']) {
      const result = await service.reportFromTool({ ...BASE, title });
      expect(result.ok).toBe(false);
    }
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('sessionId 为空：报错不插库（上报必须归属会话，归因防伪）', async () => {
    const { service, repository } = makeService();
    const result = await service.reportFromTool({ ...BASE, sessionId: null });
    expect(result.ok).toBe(false);
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('severity 非法回退 medium；缺省也是 medium', async () => {
    const { service, repository } = makeService();
    await service.reportFromTool({ ...BASE, severity: 'extreme' });
    await service.reportFromTool({ ...BASE, title: '另一个问题' });
    expect(repository.insert.mock.calls[0][0].severity).toBe('medium');
    expect(repository.insert.mock.calls[1][0].severity).toBe('medium');
  });

  it('title 超 200 字符截断（按码点，emoji 不切半），去重与落库同用截断值', async () => {
    const { service, repository } = makeService();
    // 构造第 200 码点恰为 🔥（202 码点）：UTF-16 slice 会切出孤立代理，码点截断必须保住完整 emoji
    const longTitle = 'a'.repeat(AGENT_REPORT_TITLE_MAX_CHARS - 1) + '🔥🔥🔥';
    await service.reportFromTool({ ...BASE, title: longTitle });
    const inserted = repository.insert.mock.calls[0][0].title as string;
    expect([...inserted].length).toBe(AGENT_REPORT_TITLE_MAX_CHARS);
    expect([...inserted].at(-1)).toBe('🔥');
    // 去重查询必须用截断后的 title（否则长尾变体绕过或误杀）
    expect(repository.findDuplicate).toHaveBeenCalledWith(11, 'tool_defect', inserted);
  });

  it('detail 超 8000 字符截断；空 detail 归一为 null', async () => {
    const { service, repository } = makeService();
    await service.reportFromTool({ ...BASE, detail: 'x'.repeat(AGENT_REPORT_DETAIL_MAX_CHARS + 100) });
    expect([...repository.insert.mock.calls[0][0].detail as string].length).toBe(AGENT_REPORT_DETAIL_MAX_CHARS);
    await service.reportFromTool({ ...BASE, title: '另一个', detail: '   ' });
    expect(repository.insert.mock.calls[1][0].detail).toBeNull();
  });

  it('会话内重复（category+title）：不插库，返回 duplicate=true', async () => {
    const { service, repository } = makeService({ duplicate: true });
    const result = await service.reportFromTool(BASE);
    expect(result).toEqual({ ok: true, duplicate: true });
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('限流触顶：静默接受（返回正常 ack）但不插库——不给模型可操纵的限流信号', async () => {
    const { service, repository } = makeService({ sessionCount: AGENT_REPORT_MAX_PER_SESSION });
    const result = await service.reportFromTool(BASE);
    expect(result).toEqual({ ok: true, duplicate: false });
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('限流边界：第 20 条（计数 19）仍落库', async () => {
    const { service, repository } = makeService({ sessionCount: AGENT_REPORT_MAX_PER_SESSION - 1 });
    const result = await service.reportFromTool(BASE);
    expect(result).toEqual({ ok: true, duplicate: false });
    expect(repository.insert).toHaveBeenCalledTimes(1);
  });
});

/**
 * 处置链路的 service↔repository 组合回归（评审 P0：两层各自单测正确、接线处把
 * 「合法目标态」当 CAS 源态传入导致全部流转失败）。这里用真实 Repository + 模拟
 * `status IN (...)` 求值的 capture db，覆盖完整 updateStatus 路径。
 */
describe('AgentReportService.updateStatus（组合真实 Repository）', () => {
  /**
   * 单行假表：queryOne 模拟 selectById 的 JOIN 读；execute 模拟 CAS 的 status IN 求值。
   * `statusAfterFirstRead`：首次 selectById 返回后即翻转行状态（确定性模拟并发抢先处置）。
   */
  function makeComboDb(initial: { id: number; status: string }, opts: { statusAfterFirstRead?: string } = {}) {
    const row = { ...initial };
    let reads = 0;
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      queryOne: vi.fn(async (sql: string, params: unknown[] = []) => {
        captured.push({ sql, params });
        if (/FROM agent_report r/.test(sql) && /WHERE r\.id = \?/.test(sql)) {
          const snapshot = {
            id: row.id, sessionId: 11, userId: 7, agentId: 3, category: 'other', severity: 'medium',
            title: 't', detail: null, status: row.status, resolutionNote: null,
            resolvedBy: null, resolvedByName: null, resolvedAt: null,
            username: 'alice', agentName: 'Coder',
            createdAt: '2026-11-27T00:00:00.000Z', updatedAt: '2026-11-27T00:00:00.000Z',
          };
          reads += 1;
          if (reads === 1 && opts.statusAfterFirstRead != null) row.status = opts.statusAfterFirstRead;
          return snapshot;
        }
        return null;
      }),
      execute: vi.fn(async (sql: string, params: unknown[] = []) => {
        captured.push({ sql, params });
        // 模拟 WHERE id = ? AND status IN (...)：参数序列里 id 之后即源态列表
        const idIndex = params.findIndex((p) => p === row.id);
        const sourceStatuses = params.slice(idIndex + 1).map(String);
        if (!sourceStatuses.includes(row.status)) return { affectedRows: 0 };
        row.status = String(params[0]);
        return { affectedRows: 1 };
      }),
    };
    const service = new AgentReportService(new AgentReportRepository(db as never));
    return { service, row, captured };
  }

  it('OPEN → ACKNOWLEDGED / RESOLVED / DISMISSED 全部可达（P0 回归）', async () => {
    for (const target of ['ACKNOWLEDGED', 'RESOLVED', 'DISMISSED']) {
      const { service, row } = makeComboDb({ id: 1, status: 'OPEN' });
      const updated = await service.updateStatus(99, 1, target, '备注');
      expect(updated.status).toBe(target);
      expect(row.status).toBe(target);
    }
  });

  it('ACKNOWLEDGED → RESOLVED 可达；落处置人与备注', async () => {
    const { service, row, captured } = makeComboDb({ id: 1, status: 'ACKNOWLEDGED' });
    const updated = await service.updateStatus(99, 1, 'RESOLVED', '已修复');
    expect(updated.status).toBe('RESOLVED');
    expect(row.status).toBe('RESOLVED');
    const update = captured.find((c) => c.sql.includes('UPDATE agent_report'));
    expect(update?.params.slice(0, 3)).toEqual(['RESOLVED', '已修复', 99]);
  });

  it('终态无出边：RESOLVED → DISMISSED 被状态机拒绝（不写库）', async () => {
    const { service, captured } = makeComboDb({ id: 1, status: 'RESOLVED' });
    await expect(service.updateStatus(99, 1, 'DISMISSED', null)).rejects.toMatchObject({
      code: ErrorCode.PARAM_INVALID.code,
    });
    expect(captured.some((c) => c.sql.includes('UPDATE agent_report'))).toBe(false);
  });

  it('并发处置：读到的源态被他人抢先流转 → CAS 落空抛「已被处置」（确定性模拟）', async () => {
    // detail 读到 OPEN 后行被翻转为 ACKNOWLEDGED：CAS 以 OPEN 为源态守卫，必然落空
    const { service } = makeComboDb({ id: 1, status: 'OPEN' }, { statusAfterFirstRead: 'ACKNOWLEDGED' });
    await expect(service.updateStatus(99, 1, 'RESOLVED', null)).rejects.toMatchObject({
      code: ErrorCode.AGENT_REPORT_ALREADY_RESOLVED.code,
    });
  });

  it('CAS 源态实参恰为当前态（评审 P0 的错位点：不是目标态列表）', async () => {
    const { service, captured } = makeComboDb({ id: 1, status: 'OPEN' });
    await service.updateStatus(99, 1, 'RESOLVED', null);
    const update = captured.find((c) => c.sql.includes('UPDATE agent_report'));
    // 参数序列：target, note, operatorId, id, ...sourceStatuses
    expect(update?.params).toEqual(['RESOLVED', null, 99, 1, 'OPEN']);
  });
});
