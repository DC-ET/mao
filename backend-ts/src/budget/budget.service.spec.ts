import { describe, expect, it, vi } from 'vitest';
import { BudgetService, currentPeriodLabel, monthStartLocal } from './budget.service.js';
import type { BudgetListItem, BudgetRepository, BudgetListFilter, UsageBudgetRow } from './budget.repository.js';

interface HarnessOptions {
  rows?: UsageBudgetRow[];
  targetExists?: boolean;
}

function row(overrides: Partial<UsageBudgetRow> = {}): UsageBudgetRow {
  return {
    id: 1, scope: 'GLOBAL', scopeId: null, period: 'MONTHLY', limitType: 'COST',
    limitValue: 100_000_000, action: 'BLOCK', enabled: 1, createdBy: 1,
    createdAt: '2026-03-01 00:00:00', updatedAt: null,
    ...overrides,
  };
}

function makeHarness(options: HarnessOptions = {}) {
  const rows = options.rows ?? [];
  const repo = {
    list: vi.fn(async (filter: BudgetListFilter) => rows.filter((r) => {
      if (filter.scope != null && filter.scope.trim() !== '' && r.scope !== filter.scope) return false;
      if (filter.action != null && filter.action.trim() !== '' && r.action !== filter.action) return false;
      if (filter.enabledOnly && r.enabled !== 1) return false;
      return true;
    })),
    findById: vi.fn(async (id: number) => rows.find((r) => r.id === id) ?? null),
    insert: vi.fn(async (r: UsageBudgetRow) => { r.id = 42; return 42; }),
    updateById: vi.fn(async () => undefined),
    deleteById: vi.fn(async () => undefined),
  };
  const spendStore = {
    sumCostSince: vi.fn(async () => 0),
    sumTokensSince: vi.fn(async () => 0),
  };
  const exists = options.targetExists !== false;
  const targetLookup = {
    findUser: vi.fn(async (id: number) => (exists ? { id, name: `user-${id}` } : null)),
    findAgent: vi.fn(async (id: number) => (exists ? { id, name: `agent-${id}` } : null)),
  };
  const warnRecorder = { recordBudgetWarn: vi.fn(async () => undefined) };
  const service = new BudgetService(
    repo as unknown as BudgetRepository,
    spendStore,
    targetLookup,
    warnRecorder,
  );
  return { service, repo, spendStore, targetLookup, warnRecorder };
}

const TARGET = { userId: 7, agentId: 5 };

describe('BudgetService.checkAdmission', () => {
  it('GLOBAL BLOCK 命中：返回预算行 + 展示口径（COST 微单位 → 成本单位）', async () => {
    const h = makeHarness({ rows: [row({ id: 3, limitValue: 100_000_000 })] });
    h.spendStore.sumCostSince.mockResolvedValue(150_000_000);
    const block = await h.service.checkAdmission(TARGET);
    expect(block).toEqual({
      budgetId: 3, scope: 'GLOBAL', scopeId: null,
      spend: 150, limitValue: 100, limitType: 'COST',
    });
    expect(h.spendStore.sumCostSince).toHaveBeenCalledWith('GLOBAL', null, expect.stringMatching(/^\d{4}-\d{2}-01 00:00:00$/));
  });

  it('消耗未达上限 → 放行', async () => {
    const h = makeHarness({ rows: [row({ limitValue: 100_000_000 })] });
    h.spendStore.sumCostSince.mockResolvedValue(99_999_999);
    expect(await h.service.checkAdmission(TARGET)).toBeNull();
  });

  it('消耗等于上限即命中（>= 语义）', async () => {
    const h = makeHarness({ rows: [row({ limitValue: 100_000_000 })] });
    h.spendStore.sumCostSince.mockResolvedValue(100_000_000);
    expect(await h.service.checkAdmission(TARGET)).not.toBeNull();
  });

  it('三 scope 命中矩阵：USER / AGENT 行只对匹配目标生效', async () => {
    const h = makeHarness({ rows: [row({ id: 1, scope: 'USER', scopeId: 7, action: 'WARN' }), row({ id: 2, scope: 'AGENT', scopeId: 5, limitType: 'TOKENS', limitValue: 500 })] });
    h.spendStore.sumTokensSince.mockResolvedValue(600);
    // WARN 行不参与 BLOCK 检查；AGENT 行命中
    const block = await h.service.checkAdmission(TARGET);
    expect(block).toMatchObject({ budgetId: 2, scope: 'AGENT', limitType: 'TOKENS', spend: 600, limitValue: 500 });

    // 目标换成别的 agent → 不命中
    expect(await h.service.checkAdmission({ userId: 7, agentId: 9 })).toBeNull();
    // 目标 agent 缺失（userId 维度无行）→ 不命中
    expect(await h.service.checkAdmission({ userId: 7, agentId: null })).toBeNull();
  });

  it('USER 行 target.userId 不匹配时跳过', async () => {
    const h = makeHarness({ rows: [row({ id: 1, scope: 'USER', scopeId: 8, limitValue: 500 })] });
    h.spendStore.sumTokensSince.mockResolvedValue(9999);
    expect(await h.service.checkAdmission(TARGET)).toBeNull();
    expect(h.spendStore.sumTokensSince).not.toHaveBeenCalled();
  });

  it('TOKENS 口径走 total_tokens 求和，消耗原样比对', async () => {
    const h = makeHarness({ rows: [row({ id: 1, limitType: 'TOKENS', limitValue: 1_000_000 })] });
    h.spendStore.sumTokensSince.mockResolvedValue(1_200_000);
    const block = await h.service.checkAdmission(TARGET);
    expect(block).toMatchObject({ limitType: 'TOKENS', spend: 1_200_000, limitValue: 1_000_000 });
    expect(h.spendStore.sumCostSince).not.toHaveBeenCalled();
  });

  it('enabled=0 的行立即失效（不进检查集合）', async () => {
    const h = makeHarness({ rows: [row({ enabled: 0 })] });
    h.spendStore.sumCostSince.mockResolvedValue(999_999_999);
    expect(await h.service.checkAdmission(TARGET)).toBeNull();
    expect(h.spendStore.sumCostSince).not.toHaveBeenCalled();
  });

  it('目标已删除的行跳过（usage_budget 无外键）', async () => {
    const h = makeHarness({ rows: [row({ id: 1, scope: 'USER', scopeId: 7, limitValue: 1 })], targetExists: false });
    h.spendStore.sumCostSince.mockResolvedValue(999_999_999);
    expect(await h.service.checkAdmission(TARGET)).toBeNull();
    expect(h.spendStore.sumCostSince).not.toHaveBeenCalled();
  });

  it('多行命中时按 GLOBAL → USER → AGENT 顺序返回首个命中（§5.7）', async () => {
    const h = makeHarness({ rows: [
      row({ id: 10, scope: 'AGENT', scopeId: 5, limitValue: 100_000_000 }),
      row({ id: 20, scope: 'GLOBAL', limitValue: 100_000_000 }),
      row({ id: 30, scope: 'USER', scopeId: 7, limitValue: 100_000_000 }),
    ] });
    h.spendStore.sumCostSince.mockResolvedValue(999_999_999);
    const block = await h.service.checkAdmission(TARGET);
    expect(block).toMatchObject({ budgetId: 20, scope: 'GLOBAL' });
  });
});

describe('BudgetService.settleWarn', () => {
  const NOW = new Date(2026, 2, 15, 10, 0, 0); // 2026-03-15 本地

  it('notifyUserId 缺失（无主会话）→ 不提醒', async () => {
    const h = makeHarness({ rows: [row({ id: 1, action: 'WARN', limitValue: 1 })] });
    h.spendStore.sumCostSince.mockResolvedValue(999);
    await h.service.settleWarn(TARGET, null, NOW);
    expect(h.warnRecorder.recordBudgetWarn).not.toHaveBeenCalled();
  });

  it('无 WARN 行 → 不查询消耗', async () => {
    const h = makeHarness({ rows: [] });
    await h.service.settleWarn(TARGET, 7, NOW);
    expect(h.spendStore.sumCostSince).not.toHaveBeenCalled();
    expect(h.warnRecorder.recordBudgetWarn).not.toHaveBeenCalled();
  });

  it('WARN 行越线 → 写 BUDGET_WARN，周期标签为服务器本地 yyyy-MM', async () => {
    const h = makeHarness({ rows: [row({ id: 5, action: 'WARN', limitValue: 100_000_000 })] });
    h.spendStore.sumCostSince.mockResolvedValue(260_000_000);
    await h.service.settleWarn(TARGET, 7, NOW);
    expect(h.warnRecorder.recordBudgetWarn).toHaveBeenCalledWith({
      userId: 7,
      budgetId: 5,
      scope: 'GLOBAL',
      spend: 260,
      limitValue: 100,
      limitType: 'COST',
      period: '2026-03',
    });
    expect(h.spendStore.sumCostSince).toHaveBeenCalledWith('GLOBAL', null, '2026-03-01 00:00:00');
  });

  it('WARN 未越线 → 不提醒', async () => {
    const h = makeHarness({ rows: [row({ id: 5, action: 'WARN', limitValue: 100_000_000 })] });
    h.spendStore.sumCostSince.mockResolvedValue(99_999_999);
    await h.service.settleWarn(TARGET, 7, NOW);
    expect(h.warnRecorder.recordBudgetWarn).not.toHaveBeenCalled();
  });

  it('BLOCK 行不参与 WARN 结算', async () => {
    const h = makeHarness({ rows: [row({ id: 5, action: 'BLOCK', limitValue: 1 })] });
    h.spendStore.sumCostSince.mockResolvedValue(999);
    await h.service.settleWarn(TARGET, 7, NOW);
    expect(h.warnRecorder.recordBudgetWarn).not.toHaveBeenCalled();
  });

  it('同 limitType+scope+scopeId 的消耗在单次结算内只查一次', async () => {
    const h = makeHarness({ rows: [
      row({ id: 6, scope: 'USER', scopeId: 7, action: 'WARN', limitValue: 100_000_000 }),
      row({ id: 7, scope: 'USER', scopeId: 7, action: 'WARN', limitValue: 200_000_000 }),
    ] });
    h.spendStore.sumCostSince.mockResolvedValue(250_000_000);
    await h.service.settleWarn(TARGET, 7, NOW);
    expect(h.warnRecorder.recordBudgetWarn).toHaveBeenCalledTimes(2);
    expect(h.spendStore.sumCostSince).toHaveBeenCalledTimes(1);
  });

  it('不同口径分别查询（COST 与 TOKENS 不共用缓存）', async () => {
    const h = makeHarness({ rows: [
      row({ id: 6, scope: 'USER', scopeId: 7, action: 'WARN', limitType: 'COST', limitValue: 100_000_000 }),
      row({ id: 7, scope: 'USER', scopeId: 7, action: 'WARN', limitType: 'TOKENS', limitValue: 1000 }),
    ] });
    h.spendStore.sumCostSince.mockResolvedValue(150_000_000);
    h.spendStore.sumTokensSince.mockResolvedValue(2000);
    await h.service.settleWarn(TARGET, 7, NOW);
    expect(h.spendStore.sumCostSince).toHaveBeenCalledTimes(1);
    expect(h.spendStore.sumTokensSince).toHaveBeenCalledTimes(1);
    expect(h.warnRecorder.recordBudgetWarn).toHaveBeenCalledTimes(2);
  });

  it('未注入 warnRecorder（budget 域未装配收件箱）→ 静默跳过不抛错', async () => {
    const repo = { list: vi.fn(async () => [row({ action: 'WARN', limitValue: 1 })]), findById: vi.fn(), insert: vi.fn(), updateById: vi.fn(), deleteById: vi.fn() };
    const service = new BudgetService(
      repo as unknown as BudgetRepository,
      { sumCostSince: vi.fn(async () => 999), sumTokensSince: vi.fn(async () => 999) },
      { findUser: vi.fn(), findAgent: vi.fn() },
      null,
    );
    await expect(service.settleWarn(TARGET, 7, NOW)).resolves.toBeUndefined();
    expect(repo.list).toHaveBeenCalledTimes(1);
  });

  it('行加载异常 → 吞掉并按 warn 记录，不影响任务终态', async () => {
    const repo = { list: vi.fn(async () => { throw new Error('db down'); }), findById: vi.fn(), insert: vi.fn(), updateById: vi.fn(), deleteById: vi.fn() };
    const service = new BudgetService(repo as unknown as BudgetRepository, { sumCostSince: vi.fn(), sumTokensSince: vi.fn() }, { findUser: vi.fn(), findAgent: vi.fn() }, { recordBudgetWarn: vi.fn() });
    await expect(service.settleWarn(TARGET, 7, NOW)).resolves.toBeUndefined();
  });

  it('单行提醒写入失败不影响其他行', async () => {
    const h = makeHarness({ rows: [
      row({ id: 6, scope: 'USER', scopeId: 7, action: 'WARN', limitValue: 100_000_000 }),
      row({ id: 7, scope: 'AGENT', scopeId: 5, action: 'WARN', limitValue: 100_000_000 }),
    ] });
    h.spendStore.sumCostSince.mockResolvedValue(150_000_000);
    h.warnRecorder.recordBudgetWarn
      .mockRejectedValueOnce(new Error('inbox down'))
      .mockResolvedValueOnce(undefined);
    await expect(h.service.settleWarn(TARGET, 7, NOW)).resolves.toBeUndefined();
    expect(h.warnRecorder.recordBudgetWarn).toHaveBeenCalledTimes(2);
  });
});

describe('BudgetService.noticeQueueBlocked', () => {
  it('队列消费 BLOCK 留队提醒：透传 block 与通知目标', async () => {
    const h = makeHarness();
    await h.service.noticeQueueBlocked(
      { budgetId: 9, scope: 'USER', scopeId: 7, spend: 12.5, limitValue: 10, limitType: 'COST' },
      7,
    );
    expect(h.warnRecorder.recordBudgetWarn).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7, budgetId: 9, scope: 'USER', spend: 12.5, limitValue: 10, limitType: 'COST',
    }));
    // 周期标签为当前本地月
    expect(h.warnRecorder.recordBudgetWarn.mock.calls[0][0].period).toMatch(/^\d{4}-\d{2}$/);
  });

  it('通知目标缺失 → 不写', async () => {
    const h = makeHarness();
    await h.service.noticeQueueBlocked({ budgetId: 9, scope: 'GLOBAL', scopeId: null, spend: 1, limitValue: 1, limitType: 'TOKENS' }, null);
    expect(h.warnRecorder.recordBudgetWarn).not.toHaveBeenCalled();
  });
});

describe('周期标签', () => {
  it('monthStartLocal 取本地时区当月 1 日 00:00', () => {
    expect(monthStartLocal(new Date(2026, 2, 15, 23, 30))).toBe('2026-03-01 00:00:00');
    expect(monthStartLocal(new Date(2026, 11, 1, 0, 0, 1))).toBe('2026-12-01 00:00:00');
  });

  it('currentPeriodLabel 为 yyyy-MM（跨周期重置去重维度）', () => {
    expect(currentPeriodLabel(new Date(2026, 0, 31, 23, 59))).toBe('2026-01');
    expect(currentPeriodLabel(new Date(2026, 11, 31, 12, 0))).toBe('2026-12');
  });
});

describe('BudgetService.list', () => {
  it('USER/AGENT 行附目标名；目标已删标记 targetDeleted', async () => {
    const h = makeHarness({ rows: [
      row({ id: 1, scope: 'GLOBAL' }),
      row({ id: 2, scope: 'USER', scopeId: 7 }),
      row({ id: 3, scope: 'AGENT', scopeId: 5 }),
    ] });
    const items = await h.service.list({});
    expect(items[0].targetDeleted).toBeUndefined(); // GLOBAL 不做目标查询
    expect(items[1]).toMatchObject({ targetName: 'user-7', targetDeleted: false });
    expect(items[2]).toMatchObject({ targetName: 'agent-5', targetDeleted: false });
    expect(h.targetLookup.findUser).toHaveBeenCalledWith(7);
    expect(h.targetLookup.findAgent).toHaveBeenCalledWith(5);

    const gone = makeHarness({ rows: [row({ id: 2, scope: 'USER', scopeId: 7 })], targetExists: false });
    const goneItems = await gone.service.list({});
    expect(goneItems[0]).toMatchObject({ targetName: null, targetDeleted: true });
  });

  it('当期消耗：COST 换算为成本单位，TOKENS 原值；停用行不查询', async () => {
    const h = makeHarness({ rows: [
      row({ id: 1, limitType: 'COST' }),
      row({ id: 2, scope: 'USER', scopeId: 7, limitType: 'TOKENS' }),
      row({ id: 3, limitType: 'COST', enabled: 0 }),
    ] });
    h.spendStore.sumCostSince.mockResolvedValue(3_500_000);
    h.spendStore.sumTokensSince.mockResolvedValue(12_345);
    const items = await h.service.list({});
    expect(items[0].periodSpend).toBe(3.5);
    expect(items[1].periodSpend).toBe(12_345);
    expect(items[2].periodSpend).toBeUndefined();
    expect(h.spendStore.sumCostSince).toHaveBeenCalledTimes(1); // 停用行跳过
  });

  it('消耗查询异常 → periodSpend 为 null，列表仍可用', async () => {
    const h = makeHarness({ rows: [row({ id: 1 })] });
    h.spendStore.sumCostSince.mockRejectedValue(new Error('db down'));
    const items = await h.service.list({});
    expect(items[0].periodSpend).toBeNull();
  });

  it('周期起点按本地当月 1 日', async () => {
    const h = makeHarness({ rows: [row({ id: 1 })] });
    await h.service.list({});
    expect(h.spendStore.sumCostSince).toHaveBeenCalledWith('GLOBAL', null, monthStartLocal());
  });
});

describe('BudgetService CRUD 校验', () => {
  it('create 落库并回填 id', async () => {
    const h = makeHarness();
    const created = await h.service.create({
      scope: 'USER', scopeId: 7, limitType: 'COST', limitValue: 100_000_000, action: 'BLOCK', createdBy: 1,
    });
    expect(created.id).toBe(42);
    expect(h.repo.insert).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'USER', scopeId: 7, period: 'MONTHLY', limitType: 'COST', limitValue: 100_000_000, action: 'BLOCK', enabled: 1, createdBy: 1,
    }));
  });

  it('GLOBAL 行 scopeId 强制为 null', async () => {
    const h = makeHarness();
    await h.service.create({ scope: 'GLOBAL', scopeId: 7, limitType: 'TOKENS', limitValue: 10, action: 'WARN' });
    expect(h.repo.insert).toHaveBeenCalledWith(expect.objectContaining({ scope: 'GLOBAL', scopeId: null }));
  });

  it('enabled 语义：缺省 1；false/0 → 0', async () => {
    const h = makeHarness();
    await h.service.create({ scope: 'GLOBAL', limitType: 'COST', limitValue: 1, action: 'WARN', enabled: false });
    expect(h.repo.insert).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: 0 }));
    await h.service.create({ scope: 'GLOBAL', limitType: 'COST', limitValue: 1, action: 'WARN', enabled: 0 });
    expect(h.repo.insert).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: 0 }));
    await h.service.create({ scope: 'GLOBAL', limitType: 'COST', limitValue: 1, action: 'WARN' });
    expect(h.repo.insert).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: 1 }));
  });

  it('字段校验：scope / scopeId / limitType / limitValue / action', async () => {
    const h = makeHarness();
    const base = { scope: 'GLOBAL', limitType: 'COST', limitValue: 100, action: 'WARN' };
    await expect(h.service.create({ ...base, scope: 'TENANT' })).rejects.toMatchObject({ code: 2001 });
    await expect(h.service.create({ ...base, scope: 'USER' })).rejects.toMatchObject({ code: 2001 }); // 缺 scopeId
    await expect(h.service.create({ ...base, scope: 'USER', scopeId: 0 })).rejects.toMatchObject({ code: 2001 });
    await expect(h.service.create({ ...base, scope: 'USER', scopeId: -1 })).rejects.toMatchObject({ code: 2001 });
    await expect(h.service.create({ ...base, scope: 'USER', scopeId: 1.5 })).rejects.toMatchObject({ code: 2001 });
    await expect(h.service.create({ ...base, limitType: 'BYTES' })).rejects.toMatchObject({ code: 2001 });
    await expect(h.service.create({ ...base, limitValue: 0 })).rejects.toMatchObject({ code: 2001 });
    await expect(h.service.create({ ...base, limitValue: -5 })).rejects.toMatchObject({ code: 2001 });
    await expect(h.service.create({ ...base, limitValue: 1.5 })).rejects.toMatchObject({ code: 2001 });
    await expect(h.service.create({ ...base, action: 'NOTIFY' })).rejects.toMatchObject({ code: 2001 });
    expect(h.repo.insert).not.toHaveBeenCalled();
  });

  it('GLOBAL 至多一条：重复创建 / 改动他行成 GLOBAL 均拒绝', async () => {
    const h = makeHarness({ rows: [row({ id: 1, scope: 'GLOBAL' })] });
    await expect(h.service.create({ scope: 'GLOBAL', limitType: 'COST', limitValue: 100, action: 'WARN' }))
      .rejects.toMatchObject({ code: 2001 });
    // 停用的 GLOBAL 行也占位（避免复活冲突）
    const disabled = makeHarness({ rows: [row({ id: 1, scope: 'GLOBAL', enabled: 0 })] });
    await expect(disabled.service.create({ scope: 'GLOBAL', limitType: 'COST', limitValue: 100, action: 'WARN' }))
      .rejects.toMatchObject({ code: 2001 });
    // 更新自身 GLOBAL 行放行（excludeId）
    await expect(h.service.update(1, { scope: 'GLOBAL', limitType: 'COST', limitValue: 200, action: 'WARN' }))
      .resolves.toMatchObject({ id: 1, limitValue: 200 });
    // 把 USER 行改成 GLOBAL 被拒
    await expect(h.service.update(99, { scope: 'GLOBAL', limitType: 'COST', limitValue: 200, action: 'WARN' }))
      .rejects.toMatchObject({ code: 2001 });
  });

  it('update / remove 目标不存在 → 拒绝', async () => {
    const h = makeHarness({ rows: [] });
    await expect(h.service.update(404, { scope: 'GLOBAL', limitType: 'COST', limitValue: 1, action: 'WARN' }))
      .rejects.toMatchObject({ code: 2001 });
    await expect(h.service.remove(404)).rejects.toMatchObject({ code: 2001 });
  });

  it('update 保留 createdBy / createdAt 并落库', async () => {
    const h = makeHarness({ rows: [row({ id: 4, scope: 'USER', scopeId: 7, createdBy: 9, createdAt: '2026-03-02 00:00:00' })] });
    const updated = await h.service.update(4, { scope: 'USER', scopeId: 7, limitType: 'TOKENS', limitValue: 500, action: 'BLOCK', enabled: 0 });
    expect(h.repo.updateById).toHaveBeenCalledWith(expect.objectContaining({ id: 4, limitType: 'TOKENS', limitValue: 500, enabled: 0 }));
    expect(updated).toMatchObject({ id: 4, createdBy: 9, createdAt: '2026-03-02 00:00:00' });
  });

  it('remove 物理删除', async () => {
    const h = makeHarness({ rows: [row({ id: 4 })] });
    await h.service.remove(4);
    expect(h.repo.deleteById).toHaveBeenCalledWith(4);
  });
});

describe('BudgetSpendStore', () => {
  it('GLOBAL 全表范围扫描；USER / AGENT 带目标列过滤', async () => {
    // 直接验证 SQL 形状：列名与 since/scopeId 参数顺序（§5.6）
    const db = {
      queryOne: vi.fn(async () => ({ v: 12 })),
      query: vi.fn(),
      execute: vi.fn(),
    };
    const { BudgetSpendStore } = await import('./budget.repository.js');
    const store = new BudgetSpendStore(db as never);
    expect(await store.sumCostSince('GLOBAL', null, '2026-03-01 00:00:00')).toBe(12);
    expect(db.queryOne.mock.calls[0][0]).toContain('SUM(cost_micros)');
    expect(db.queryOne.mock.calls[0][1]).toEqual(['2026-03-01 00:00:00']);

    await store.sumTokensSince('USER', 7, '2026-03-01 00:00:00');
    expect(db.queryOne.mock.calls[1][0]).toContain('AND user_id = ?');
    expect(db.queryOne.mock.calls[1][1]).toEqual(['2026-03-01 00:00:00', 7]);

    await store.sumCostSince('AGENT', 5, '2026-03-01 00:00:00');
    expect(db.queryOne.mock.calls[2][0]).toContain('AND agent_id = ?');
    expect(db.queryOne.mock.calls[2][1]).toEqual(['2026-03-01 00:00:00', 5]);
  });

  it('SUM 结果为 NULL（无行）→ 0', async () => {
    const db = { queryOne: vi.fn(async () => ({ v: null })), query: vi.fn(), execute: vi.fn() };
    const { BudgetSpendStore } = await import('./budget.repository.js');
    expect(await new BudgetSpendStore(db as never).sumCostSince('GLOBAL', null, 'x')).toBe(0);
  });
});
