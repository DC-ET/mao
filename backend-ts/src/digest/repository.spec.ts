import { describe, expect, it, vi } from 'vitest';
import { DigestRepository } from './repository.js';

/**
 * 仓储 SQL 语义回归（技术方案 §5.2 / §8 测试要点）。
 *
 * 不连库，只断言真实执行时求值的 SQL 与参数，外加行映射的健壮性：
 * - 窗口一律半开区间 [start, end)：created_at >= ? AND created_at < ?，参数序 (userId, start, end)。
 *   错写成 <= 或把 end 传成 start 会把「昨天 23:59」漏计或把今天凌晨算进昨天。
 * - 审批挂起是状态量：两条审批语句不得带任何时间条件（挂起 3 天前仍要计数）。
 * - markProcessed 单调不回退：WHERE 必须带 last_digest_date < ?，否则试发后的并发 tick
 *   会把状态覆盖回更早日期，导致同一天重复生成。
 * - mysql2 的 COUNT/SUM 返回字符串：映射处必须 Number() 强转，否则前端拿到 '3' 参与运算。
 * - payload_json 是历史坏数据高发区：解析失败/缺字段/非数字一律 null，不得抛。
 */

const START = '2026-10-11 00:00:00';
const END = '2026-10-12 00:00:00';

interface Captured {
  sql: string;
  params: unknown[];
}

/** query 行可由用例按 SQL 关键字定制；execute 只记录。 */
function capture(rowsBySql: Array<{ match: RegExp; rows: unknown[] }> = []) {
  const calls: Captured[] = [];
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const hit = rowsBySql.find((r) => r.match.test(sql));
      return (hit?.rows ?? []) as never[];
    }),
    queryOne: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const hit = rowsBySql.find((r) => r.match.test(sql));
      return (hit?.rows?.[0] ?? null) as never;
    }),
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { affectedRows: 1, insertId: 0 };
    }),
  };
  const repo = new DigestRepository(db as never);
  return { repo, calls, db };
}

function sqlOf(calls: Captured[], fragment: string): Captured {
  const hit = calls.find((c) => c.sql.includes(fragment));
  if (!hit) throw new Error(`未找到包含 ${fragment} 的 SQL，实际：${calls.map((c) => c.sql).join(' | ')}`);
  return hit;
}

describe('DigestRepository 窗口与归属', () => {
  it('任务成败统计：半开区间 + GROUP BY kind，参数序 (userId, start, end)', async () => {
    const h = capture([{ match: /FROM notification/, rows: [{ kind: 'TASK_COMPLETED', c: '5' }, { kind: 'TASK_FAILED', c: '2' }] }]);
    const result = await h.repo.countTaskTerminal(7, START, END);
    const call = sqlOf(h.calls, 'GROUP BY kind');
    expect(call.sql).toContain('created_at >= ?');
    expect(call.sql).toContain('created_at < ?');
    expect(call.sql).not.toContain('created_at <=');
    expect(call.params).toEqual([7, START, END]);
    // mysql2 COUNT(*) 返回字符串：必须转成数字，否则前端运算出 '52'
    expect(result).toEqual({ completed: 5, failed: 2 });
  });

  it('失败任务 Top N：窗口内 kind=TASK_FAILED，limit 进参数', async () => {
    const h = capture([{ match: /FROM notification/, rows: [{ sessionId: 10, title: '任务甲', reason: '模型超时' }] }]);
    const rows = await h.repo.listFailedTasks(7, START, END, 3);
    const call = sqlOf(h.calls, "kind = 'TASK_FAILED'");
    expect(call.sql).toContain('ORDER BY id DESC LIMIT ?');
    expect(call.params).toEqual([7, START, END, 3]);
    expect(rows).toEqual([{ sessionId: 10, title: '任务甲', reason: '模型超时' }]);
  });

  it('定时任务执行：JOIN 归属表取 user_id（不得按 run 表过滤用户）', async () => {
    const h = capture([{ match: /FROM scheduled_task_run/, rows: [{ status: 'COMPLETED', c: 3 }, { status: 'FAILED', c: 1 }, { status: 'RUNNING', c: 2 }] }]);
    const result = await h.repo.countScheduledRuns(7, START, END);
    const call = sqlOf(h.calls, 'FROM scheduled_task_run');
    expect(call.sql).toContain('JOIN scheduled_task t ON r.task_id = t.id');
    expect(call.sql).toContain('t.user_id = ?');
    expect(call.params).toEqual([7, START, END]);
    // total 含 RUNNING 等中间态：只按 completed/failed 拆分会漏计
    expect(result).toEqual({ total: 6, completed: 3, failed: 1 });
  });

  it('哨兵触发：changed = 1 且 JOIN 归属表；无行时回落 0', async () => {
    const h = capture([{ match: /FROM signal_watcher_check/, rows: [{ c: 4 }] }]);
    expect(await h.repo.countWatcherTriggers(7, START, END)).toBe(4);
    const call = sqlOf(h.calls, 'FROM signal_watcher_check');
    expect(call.sql).toContain('ch.changed = 1');
    expect(call.sql).toContain('w.user_id = ?');
    expect(call.params).toEqual([7, START, END]);

    const empty = capture();
    expect(await empty.repo.countWatcherTriggers(7, START, END)).toBe(0);
  });

  it('成本聚合：micros NULL 行保留 null（不得转 0 混入合计），agentId NULL 同样保留', async () => {
    const h = capture([{
      match: /FROM llm_call/,
      rows: [
        { agentId: '1', micros: '3420000', calls: '5', unpriced: '0' },
        { agentId: null, micros: null, calls: '1', unpriced: '1' },
      ],
    }]);
    const rows = await h.repo.sumCostByAgent(7, START, END);
    const call = sqlOf(h.calls, 'FROM llm_call');
    expect(call.sql).toContain('SUM(cost_micros)');
    expect(call.sql).toContain('CASE WHEN cost_micros IS NULL');
    expect(call.params).toEqual([7, START, END]);
    // BIGINT SUM 在 mysql2 下是字符串：Number() 强转；NULL 不得变 0
    expect(rows).toEqual([
      { agentId: 1, micros: 3420000, calls: 5, unpriced: 0 },
      { agentId: null, micros: null, calls: 1, unpriced: 1 },
    ]);
  });

  it('Agent 名回填：空集合不发 SQL；占位符数量与入参一致', async () => {
    const empty = capture();
    expect(await empty.repo.findAgentNames([])).toEqual(new Map());
    expect(empty.calls).toHaveLength(0);

    const h = capture([{ match: /FROM agent/, rows: [{ id: '1', name: '助手A' }, { id: '2', name: '助手B' }] }]);
    const names = await h.repo.findAgentNames([1, 2]);
    const call = sqlOf(h.calls, 'FROM agent');
    expect(call.sql).toContain('id IN (?, ?)');
    expect(call.params).toEqual([1, 2]);
    expect(names.get(1)).toBe('助手A');
    expect(names.size).toBe(2);
  });

  it('开放接口：total 含全部 outcome，rejected 只取 rejected 组', async () => {
    const h = capture([{ match: /FROM open_api_call_log/, rows: [{ outcome: 'success', c: 9 }, { outcome: 'rejected', c: 3 }] }]);
    const result = await h.repo.countOpenApiCalls(7, START, END);
    expect(result).toEqual({ total: 12, rejected: 3 });
    expect(sqlOf(h.calls, 'FROM open_api_call_log').params).toEqual([7, START, END]);
  });
});

describe('DigestRepository 审批挂起（状态量，无窗口）', () => {
  it('计数与列表语句都不带 created_at 条件，参数只有 userId（列表再加 limit）', async () => {
    const h = capture([{ match: /FROM notification/, rows: [{ c: 2 }] }]);
    expect(await h.repo.countPendingApprovals(7)).toBe(2);
    const countSql = sqlOf(h.calls, 'COUNT(*)');
    expect(countSql.sql).not.toContain('created_at');
    expect(countSql.sql).toContain('is_read = 0');
    expect(countSql.params).toEqual([7]);

    const list = capture([{ match: /FROM notification/, rows: [{ sessionId: 8, title: '有待处理的审批' }] }]);
    const rows = await list.repo.listPendingApprovals(7, 5);
    const listCall = sqlOf(list.calls, 'FROM notification');
    expect(listCall.sql).not.toContain('created_at');
    expect(listCall.params).toEqual([7, 5]);
    expect(rows).toEqual([{ sessionId: 8, title: '有待处理的审批' }]);
  });
});

describe('DigestRepository 偏好读写', () => {
  it('upsert：布尔转 1/0，且不得碰 last_digest_date（试发与调度共用同一行）', async () => {
    const h = capture();
    await h.repo.upsertPreference({ userId: 7, enabled: true, pushTime: '08:15', outboundEnabled: false });
    const call = sqlOf(h.calls, 'INSERT INTO user_digest_preference');
    expect(call.sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(call.sql).not.toContain('last_digest_date');
    expect(call.params).toEqual([7, 1, '08:15', 0]);
  });

  it('markProcessed：懒建行 upsert + 单调 guard，coveredDate 既做值又做比较界', async () => {
    const h = capture();
    await h.repo.markProcessed(7, '2026-10-11');
    const call = sqlOf(h.calls, 'INSERT INTO user_digest_preference');
    expect(call.sql).toContain('ON DUPLICATE KEY UPDATE');
    // 单调：仅当库里为空或更早才推进，否则保持原值（防并发 tick 覆盖回旧日期）
    expect(call.sql).toContain('IF(last_digest_date IS NULL OR last_digest_date < VALUES(last_digest_date)');
    // 只写 user_id + last_digest_date：其余列走 DDL 默认（enabled=1 / 09:30 / 1），不动已有偏好
    expect(call.params).toEqual([7, '2026-10-11']);
  });

  it('listEnabledUsers：LEFT JOIN 全部未删除用户，无行按默认偏好且默认开', async () => {
    const h = capture([{
      match: /FROM user u LEFT JOIN user_digest_preference/,
      rows: [
        // 无偏好行：五列全 null → 默认开 + 09:30 + 同步出站
        { userId: 7, enabled: null, pushTime: null, outboundEnabled: null, lastDigestDate: null },
        // 显式关掉：即使有行也不进调度
        { userId: 8, enabled: 0, pushTime: '08:00', outboundEnabled: 1, lastDigestDate: '2026-10-10' },
        // 正常开启行：值原样带回
        { userId: 9, enabled: 1, pushTime: '07:15', outboundEnabled: 0, lastDigestDate: '2026-10-11' },
      ],
    }]);
    const rows = await h.repo.listEnabledUsers();
    const call = sqlOf(h.calls, 'FROM user u LEFT JOIN user_digest_preference');
    expect(call.sql).toContain('u.deleted = 0');
    // 无行用户必须出现（决策 11 默认开落地的关键），关掉的必须被排除
    expect(rows).toEqual([
      { userId: 7, enabled: 1, pushTime: '09:30', outboundEnabled: 1, lastDigestDate: null },
      { userId: 9, enabled: 1, pushTime: '07:15', outboundEnabled: 0, lastDigestDate: '2026-10-11' },
    ]);
  });
});

describe('DigestRepository payload / 标题映射', () => {
  it('暂停任务：payload.taskId 取出，标题剥掉「定时任务已自动暂停：」前缀', async () => {
    const h = capture([{
      match: /FROM notification/,
      rows: [
        { title: '定时任务已自动暂停：每日日报', payloadJson: '{"taskId":7}' },
        { title: '定时任务已自动暂停：坏数据', payloadJson: 'not-json' },
        { title: '定时任务已自动暂停：缺字段', payloadJson: '{"other":1}' },
        { title: '定时任务已自动暂停：非数字', payloadJson: '{"taskId":"7"}' },
        { title: '定时任务已自动暂停：空串', payloadJson: null },
        { title: '没有前缀的标题', payloadJson: '{"taskId":9}' },
      ],
    }]);
    const rows = await h.repo.listPausedTasks(7, START, END);
    expect(rows).toEqual([
      { taskId: 7, name: '每日日报' },
      { taskId: null, name: '坏数据' },
      { taskId: null, name: '缺字段' },
      { taskId: null, name: '非数字' },
      { taskId: null, name: '空串' },
      { taskId: 9, name: '没有前缀的标题' },
    ]);
  });

  it('停用哨兵：payload.watcherId 取出，标题剥掉「信号哨兵已自动停用：」前缀', async () => {
    const h = capture([{
      match: /FROM notification/,
      rows: [
        { title: '信号哨兵已自动停用：汇率监控', payloadJson: '{"watcherId":5}' },
        { title: '信号哨兵已自动停用：无 payload', payloadJson: null },
      ],
    }]);
    const rows = await h.repo.listDisabledWatchers(7, START, END);
    expect(rows).toEqual([
      { watcherId: 5, name: '汇率监控' },
      { watcherId: null, name: '无 payload' },
    ]);
  });
});
