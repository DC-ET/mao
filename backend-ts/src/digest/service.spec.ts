import { describe, expect, it, vi } from 'vitest';
import {
  DigestService,
  digestTitle,
  formatCostMicros,
  renderDigestLine,
  renderDigestMarkdown,
} from './service.js';
import type { DigestRepository } from './repository.js';
import type { DigestData, DigestInboxPort, DigestOutboundPort, DigestPreferenceRow } from './types.js';

/** 固定“现在”：2026-10-12 10:00（Asia/Shanghai）→ 昨天 = 2026-10-11。 */
const NOW = new Date('2026-10-12T10:00:00+08:00');
const YESTERDAY = '2026-10-11';
const TODAY = '2026-10-12';

function emptyRepo(overrides: Partial<Record<string, unknown>> = {}): DigestRepository {
  const base = {
    findPreference: vi.fn(async () => null),
    listEnabledUsers: vi.fn(async () => []),
    upsertPreference: vi.fn(async () => undefined),
    markProcessed: vi.fn(async () => undefined),
    countTaskTerminal: vi.fn(async () => ({ completed: 0, failed: 0 })),
    listFailedTasks: vi.fn(async () => []),
    countScheduledRuns: vi.fn(async () => ({ total: 0, completed: 0, failed: 0 })),
    listPausedTasks: vi.fn(async () => []),
    countWatcherTriggers: vi.fn(async () => 0),
    listDisabledWatchers: vi.fn(async () => []),
    countPendingApprovals: vi.fn(async () => 0),
    listPendingApprovals: vi.fn(async () => []),
    sumCostByAgent: vi.fn(async () => []),
    findAgentNames: vi.fn(async () => new Map()),
    countOpenApiCalls: vi.fn(async () => ({ total: 0, rejected: 0 })),
    ...overrides,
  };
  return base as unknown as DigestRepository;
}

function prefRow(overrides: Partial<DigestPreferenceRow> = {}): DigestPreferenceRow {
  return {
    userId: 1,
    enabled: 1,
    pushTime: '09:30',
    outboundEnabled: 1,
    lastDigestDate: null,
    ...overrides,
  };
}

function makeService(repo: DigestRepository, opts: {
  inbox?: Partial<DigestInboxPort>;
  outbound?: DigestOutboundPort;
} = {}) {
  const inbox: DigestInboxPort = {
    writeDigestEntry: vi.fn(async () => undefined),
    hasDigestEntry: vi.fn(async () => false),
    ...opts.inbox,
  };
  const outbound: DigestOutboundPort = opts.outbound
    ?? ({ dispatchDigest: vi.fn() } as unknown as DigestOutboundPort);
  const service = new DigestService({ repo, inbox, outbound, now: () => NOW });
  return { service, inbox, outbound };
}

/** 全板块有数据的仓库（除 approvals 外都有事件）。 */
function busyRepo(overrides: Partial<Record<string, unknown>> = {}): DigestRepository {
  return emptyRepo({
    countTaskTerminal: vi.fn(async () => ({ completed: 3, failed: 2 })),
    listFailedTasks: vi.fn(async () => [
      { sessionId: 10, title: '任务甲', reason: '模型超时' },
      { sessionId: 11, title: '任务乙', reason: '工具失败' },
    ]),
    countScheduledRuns: vi.fn(async () => ({ total: 4, completed: 3, failed: 1 })),
    listPausedTasks: vi.fn(async () => [{ taskId: 7, name: '日报' }]),
    countWatcherTriggers: vi.fn(async () => 2),
    listDisabledWatchers: vi.fn(async () => [{ watcherId: 5, name: '汇率' }]),
    sumCostByAgent: vi.fn(async () => [
      { agentId: 1, micros: 3_420_000, calls: 5, unpriced: 0 },
      { agentId: 2, micros: 1_000_000, calls: 2, unpriced: 1 },
      { agentId: null, micros: null, calls: 1, unpriced: 1 },
    ]),
    findAgentNames: vi.fn(async () => new Map([[1, '助手A'], [2, '助手B']])),
    countOpenApiCalls: vi.fn(async () => ({ total: 12, rejected: 3 })),
    ...overrides,
  });
}

describe('DigestService.aggregate', () => {
  it('六板块有数据时全部填充，空板块置 null', async () => {
    const { service } = makeService(busyRepo());
    const data = await service.aggregate(1, YESTERDAY);
    expect(data.coveredDate).toBe(YESTERDAY);
    expect(data.tasks).toEqual({
      completed: 3,
      failed: 2,
      failedTop: [
        { sessionId: 10, title: '任务甲', reason: '模型超时' },
        { sessionId: 11, title: '任务乙', reason: '工具失败' },
      ],
    });
    expect(data.scheduled).toEqual({ total: 4, completed: 3, failed: 1, paused: [{ taskId: 7, name: '日报' }] });
    expect(data.watchers).toEqual({ triggered: 2, disabled: [{ watcherId: 5, name: '汇率' }] });
    expect(data.approvals).toBeNull();
    // 未配价行（agentId=null, micros=null）不计合计、只进 unpriced
    expect(data.cost).toEqual({
      totalMicros: 4_420_000,
      unpricedCalls: 2,
      calls: 8,
      top: [
        { agentId: 1, name: '助手A', micros: 3_420_000 },
        { agentId: 2, name: '助手B', micros: 1_000_000 },
      ],
    });
    expect(data.openApi).toEqual({ total: 12, rejected: 3 });
  });

  it('全空数据 → 六板块全 null 且 isEmpty 为真', async () => {
    const { service } = makeService(emptyRepo());
    const data = await service.aggregate(1, YESTERDAY);
    expect(service.isEmpty(data)).toBe(true);
    expect(data.tasks).toBeNull();
    expect(data.cost).toBeNull();
  });

  it('成本 Top 超过 3 个时只取前 3，且 micros 为 0 的行不进 Top', async () => {
    const repo = emptyRepo({
      sumCostByAgent: vi.fn(async () => [
        { agentId: 1, micros: 500_000, calls: 1, unpriced: 0 },
        { agentId: 2, micros: 400_000, calls: 1, unpriced: 0 },
        { agentId: 3, micros: 300_000, calls: 1, unpriced: 0 },
        { agentId: 4, micros: 200_000, calls: 1, unpriced: 0 },
        { agentId: 5, micros: 0, calls: 1, unpriced: 0 },
      ]),
      findAgentNames: vi.fn(async () => new Map()),
    });
    const { service } = makeService(repo);
    const data = await service.aggregate(1, YESTERDAY);
    expect(data.cost?.top.map((t) => t.agentId)).toEqual([1, 2, 3]);
    expect(data.cost?.totalMicros).toBe(1_400_000);
  });

  it('Agent 名查不到时回落「未关联 Agent」', async () => {
    const repo = emptyRepo({
      sumCostByAgent: vi.fn(async () => [{ agentId: 99, micros: 100_000, calls: 1, unpriced: 0 }]),
      findAgentNames: vi.fn(async () => new Map()),
    });
    const { service } = makeService(repo);
    const data = await service.aggregate(1, YESTERDAY);
    expect(data.cost?.top[0]).toEqual({ agentId: 99, name: '未关联 Agent', micros: 100_000 });
  });

  it('全 0 价调用（免费模型）：板块非空，合计 0、未配价 0、calls 保留调用数', async () => {
    // 回归（第 2 轮审查 Bug 2）：micros=0 非 NULL，不进 pricedRows 也不算 unpriced，
    // 只有 calls 字段能让「昨天只用免费模型」这件事在摘要里可见。
    const repo = emptyRepo({
      sumCostByAgent: vi.fn(async () => [
        { agentId: 1, micros: 0, calls: 3, unpriced: 0 },
        { agentId: 2, micros: 0, calls: 2, unpriced: 0 },
      ]),
      findAgentNames: vi.fn(async () => new Map()),
    });
    const { service } = makeService(repo);
    const data = await service.aggregate(1, YESTERDAY);
    expect(data.cost).toEqual({ totalMicros: 0, unpricedCalls: 0, calls: 5, top: [] });
    expect(service.isEmpty(data)).toBe(false);
  });

  it('审批挂起不限窗口：无任何事件但有挂起时 approvals 非空', async () => {
    const repo = emptyRepo({
      countPendingApprovals: vi.fn(async () => 2),
      listPendingApprovals: vi.fn(async () => [{ sessionId: 8, title: '有待处理的审批' }]),
    });
    const { service } = makeService(repo);
    const data = await service.aggregate(1, YESTERDAY);
    expect(data.approvals).toEqual({
      pending: 2,
      items: [{ sessionId: 8, title: '有待处理的审批' }],
    });
    expect(service.isEmpty(data)).toBe(false);
  });
});

describe('DigestService.processUser', () => {
  it('安静日：只标记已处理，不写收件箱、不派出站', async () => {
    const repo = emptyRepo();
    const { service, inbox, outbound } = makeService(repo);
    const result = await service.processUser(1);
    expect(result).toEqual({ sent: false, reason: 'QUIET', coveredDate: YESTERDAY });
    expect(repo.markProcessed).toHaveBeenCalledWith(1, YESTERDAY);
    expect(inbox.writeDigestEntry).not.toHaveBeenCalled();
    expect(outbound.dispatchDigest).not.toHaveBeenCalled();
  });

  it('有数据：写收件箱（payload 带完整 digest）+ 派出站 + 标记已处理', async () => {
    const repo = busyRepo({ findPreference: vi.fn(async () => prefRow()) });
    const { service, inbox, outbound } = makeService(repo);
    const result = await service.processUser(1);
    expect(result.sent).toBe(true);
    expect(result.coveredDate).toBe(YESTERDAY);
    expect(inbox.writeDigestEntry).toHaveBeenCalledTimes(1);
    const entry = (inbox.writeDigestEntry as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      title: string; content: string; dedupTail: string; payload: Record<string, unknown>;
    };
    expect(entry.title).toBe(digestTitle(YESTERDAY));
    expect(entry.dedupTail).toBe(YESTERDAY);
    expect(entry.payload.coveredDate).toBe(YESTERDAY);
    expect(entry.payload.digest).toBeTruthy();
    expect(outbound.dispatchDigest).toHaveBeenCalledTimes(1);
    const dispatch = (outbound.dispatchDigest as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      coveredDate: string; text: string;
    };
    expect(dispatch.coveredDate).toBe(YESTERDAY);
    expect(dispatch.text).toContain('昨日运营摘要');
    expect(repo.markProcessed).toHaveBeenCalledWith(1, YESTERDAY);
  });

  it('outboundEnabled=0 时不派出站，收件箱照写', async () => {
    const repo = busyRepo({ findPreference: vi.fn(async () => prefRow({ outboundEnabled: 0 })) });
    const { service, outbound } = makeService(repo);
    await service.processUser(1);
    expect(outbound.dispatchDigest).not.toHaveBeenCalled();
  });

  it('唯一事实是哨兵停用：非安静日照常投递，且收件箱 content 非空（回归空行 bug）', async () => {
    const repo = busyRepo({
      countTaskTerminal: vi.fn(async () => ({ completed: 0, failed: 0 })),
      listFailedTasks: vi.fn(async () => []),
      countScheduledRuns: vi.fn(async () => ({ total: 0, completed: 0, failed: 0 })),
      listPausedTasks: vi.fn(async () => []),
      countWatcherTriggers: vi.fn(async () => 0),
      listDisabledWatchers: vi.fn(async () => [{ watcherId: 5, name: '汇率哨兵' }]),
      sumCostByAgent: vi.fn(async () => []),
      countOpenApiCalls: vi.fn(async () => ({ total: 0, rejected: 0 })),
      findPreference: vi.fn(async () => prefRow()),
    });
    const { service, inbox } = makeService(repo);
    const result = await service.processUser(1);
    expect(result.sent).toBe(true);
    // 浓缩一行是收件箱条目的 content：为空则列表层只剩标题，运维信号被隐藏
    expect(result.line).toBe('哨兵停用 1 个');
    const entry = (inbox.writeDigestEntry as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as { content: string | null };
    expect(entry.content).toBe('哨兵停用 1 个');
  });

  it('唯一事实是全 0 价调用（免费模型）：非安静日照常投递，content 非空（回归空行 bug）', async () => {
    const repo = busyRepo({
      countTaskTerminal: vi.fn(async () => ({ completed: 0, failed: 0 })),
      listFailedTasks: vi.fn(async () => []),
      countScheduledRuns: vi.fn(async () => ({ total: 0, completed: 0, failed: 0 })),
      listPausedTasks: vi.fn(async () => []),
      countWatcherTriggers: vi.fn(async () => 0),
      listDisabledWatchers: vi.fn(async () => []),
      countPendingApprovals: vi.fn(async () => 0),
      listPendingApprovals: vi.fn(async () => []),
      // 免费模型：micros=0（非 NULL）→ 合计 0、未配价 0，只有 calls>0
      sumCostByAgent: vi.fn(async () => [{ agentId: 1, micros: 0, calls: 3, unpriced: 0 }]),
      findAgentNames: vi.fn(async () => new Map([[1, '免费模型']])),
      countOpenApiCalls: vi.fn(async () => ({ total: 0, rejected: 0 })),
      findPreference: vi.fn(async () => prefRow()),
    });
    const { service, inbox } = makeService(repo);
    const result = await service.processUser(1);
    expect(result.sent).toBe(true);
    expect(result.line).toBe('免费调用 3 次');
    const entry = (inbox.writeDigestEntry as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as { content: string | null };
    expect(entry.content).toBe('免费调用 3 次');
  });

  it('试发（force）：跳过 enabled 门控、不写 last_digest_date', async () => {
    const repo = busyRepo({ findPreference: vi.fn(async () => prefRow({ enabled: 0 })) });
    const { service, inbox } = makeService(repo);
    const result = await service.processUser(1, { force: true });
    expect(result.sent).toBe(true);
    expect(inbox.writeDigestEntry).toHaveBeenCalledTimes(1);
    expect(repo.markProcessed).not.toHaveBeenCalled();
  });

  it('总开关关闭且非试发：DISABLED，不聚合不投递', async () => {
    const repo = busyRepo({ findPreference: vi.fn(async () => prefRow({ enabled: 0 })) });
    const { service, inbox } = makeService(repo);
    const result = await service.processUser(1);
    expect(result).toEqual({ sent: false, reason: 'DISABLED', coveredDate: YESTERDAY });
    expect(inbox.writeDigestEntry).not.toHaveBeenCalled();
    expect(repo.markProcessed).not.toHaveBeenCalled();
  });

  it('试发安静日：QUIET 且不写标记', async () => {
    const repo = emptyRepo();
    const { service } = makeService(repo);
    const result = await service.processUser(1, { force: true });
    expect(result).toEqual({ sent: false, reason: 'QUIET', coveredDate: YESTERDAY });
    expect(repo.markProcessed).not.toHaveBeenCalled();
  });

  it('无偏好行时按默认偏好处理（默认开 + 默认派出站）', async () => {
    const repo = busyRepo();
    const { service, outbound } = makeService(repo);
    const result = await service.processUser(1);
    expect(result.sent).toBe(true);
    expect(outbound.dispatchDigest).toHaveBeenCalledTimes(1);
  });
});

describe('DigestService 偏好', () => {
  it('getPreferencesView：未处理 → PENDING', async () => {
    const { service } = makeService(emptyRepo());
    const view = await service.getPreferencesView(1);
    expect(view.yesterdayStatus).toBe('PENDING');
    expect(view.yesterdayCoveredDate).toBe(YESTERDAY);
    expect(view.pushTime).toBe('09:30');
    expect(view.enabled).toBe(true);
  });

  it('getPreferencesView：已处理且有条目 → SENT', async () => {
    const repo = emptyRepo({ findPreference: vi.fn(async () => prefRow({ lastDigestDate: YESTERDAY })) });
    const { service } = makeService(repo, { inbox: { hasDigestEntry: vi.fn(async () => true) } });
    const view = await service.getPreferencesView(1);
    expect(view.yesterdayStatus).toBe('SENT');
  });

  it('getPreferencesView：已处理但无条目（安静日）→ QUIET', async () => {
    const repo = emptyRepo({ findPreference: vi.fn(async () => prefRow({ lastDigestDate: YESTERDAY })) });
    const { service } = makeService(repo, { inbox: { hasDigestEntry: vi.fn(async () => false) } });
    const view = await service.getPreferencesView(1);
    expect(view.yesterdayStatus).toBe('QUIET');
  });

  it('getPreferencesView：处理的是更早日期 → PENDING', async () => {
    const repo = emptyRepo({ findPreference: vi.fn(async () => prefRow({ lastDigestDate: '2026-10-10' })) });
    const { service } = makeService(repo);
    const view = await service.getPreferencesView(1);
    expect(view.yesterdayStatus).toBe('PENDING');
  });

  it('savePreferences：增量合并且懒建行', async () => {
    const repo = emptyRepo();
    const { service } = makeService(repo);
    const saved = await service.savePreferences(1, { pushTime: '21:05' });
    expect(saved).toEqual({ enabled: true, pushTime: '21:05', outboundEnabled: true, lastDigestDate: null });
    expect(repo.upsertPreference).toHaveBeenCalledWith({
      userId: 1, enabled: true, pushTime: '21:05', outboundEnabled: true,
    });
  });

  it('savePreferences：在已有行上只改一个字段', async () => {
    const repo = emptyRepo({ findPreference: vi.fn(async () => prefRow({ enabled: 0, pushTime: '08:00', outboundEnabled: 0, lastDigestDate: '2026-10-01' })) });
    const { service } = makeService(repo);
    const saved = await service.savePreferences(1, { enabled: true });
    expect(saved).toEqual({ enabled: true, pushTime: '08:00', outboundEnabled: false, lastDigestDate: '2026-10-01' });
  });

  it('savePreferences：非法 pushTime 抛错且不落库', async () => {
    const repo = emptyRepo();
    const { service } = makeService(repo);
    await expect(service.savePreferences(1, { pushTime: '25:00' })).rejects.toThrow('HH:MM');
    await expect(service.savePreferences(1, { pushTime: '9:30' })).rejects.toThrow('HH:MM');
    expect(repo.upsertPreference).not.toHaveBeenCalled();
  });
});

describe('渲染', () => {
  const data: DigestData = {
    coveredDate: YESTERDAY,
    tasks: { completed: 5, failed: 1, failedTop: [{ sessionId: 1, title: '甲', reason: '超时' }] },
    scheduled: { total: 3, completed: 2, failed: 1, paused: [{ taskId: 2, name: '日报' }] },
    watchers: { triggered: 4, disabled: [{ watcherId: 3, name: '汇率哨兵' }] },
    approvals: { pending: 2, items: [{ sessionId: 4, title: '有待处理的审批' }] },
    cost: { totalMicros: 3_420_000, unpricedCalls: 1, calls: 6, top: [{ agentId: 1, name: '助手A', micros: 3_420_000 }] },
    openApi: { total: 12, rejected: 3 },
  };

  it('renderDigestLine：只含有数据板块的浓缩统计', () => {
    expect(renderDigestLine(data)).toBe('完成 5 · 失败 1 · 定时任务 3 次 · 哨兵触发 4 · 审批挂起 2 · 成本 3.42 · 开放接口 12 次');
  });

  it('renderDigestLine：全空数据返回空串', () => {
    const empty: DigestData = {
      coveredDate: YESTERDAY, tasks: null, scheduled: null, watchers: null,
      approvals: null, cost: null, openApi: null,
    };
    expect(renderDigestLine(empty)).toBe('');
  });

  it('renderDigestLine：每个非空板块都产出片段（回归：disabled-only 哨兵导致整行为空）', () => {
    // 昨天唯一事实是哨兵被自动停用：watchers 非空（非安静日会投递），浓缩行必须非空
    const disabledOnly: DigestData = {
      coveredDate: YESTERDAY, tasks: null, scheduled: null,
      watchers: { triggered: 0, disabled: [{ watcherId: 5, name: '汇率' }] },
      approvals: null, cost: null, openApi: null,
    };
    expect(renderDigestLine(disabledOnly)).toBe('哨兵停用 1 个');
  });

  it('renderDigestLine：零值不产生噪声片段（完成 0 / 定时 0 次 / 成本 0）', () => {
    expect(renderDigestLine({
      coveredDate: YESTERDAY,
      tasks: { completed: 0, failed: 2, failedTop: [] },
      scheduled: null, watchers: null, approvals: null, cost: null, openApi: null,
    })).toBe('失败 2');
    expect(renderDigestLine({
      coveredDate: YESTERDAY, tasks: null,
      scheduled: { total: 0, completed: 0, failed: 0, paused: [{ taskId: 7, name: '日报' }] },
      watchers: null, approvals: null, cost: null, openApi: null,
    })).toBe('定时任务暂停 1 个');
    // 窗口内有调用但全部未配价：合计 0 不能说「成本 0」，改报未配价次数
    expect(renderDigestLine({
      coveredDate: YESTERDAY, tasks: null, scheduled: null, watchers: null, approvals: null,
      cost: { totalMicros: 0, unpricedCalls: 5, calls: 5, top: [] }, openApi: null,
    })).toBe('未配价 5 次');
  });

  it('renderDigestLine：全 0 价调用（免费模型）产出免费片段（回归：cost 门控不对称空行）', () => {
    // 昨天只用了免费模型：合计 0、未配价 0，唯一能让这次调用可见的只有 calls
    expect(renderDigestLine({
      coveredDate: YESTERDAY, tasks: null, scheduled: null, watchers: null, approvals: null,
      cost: { totalMicros: 0, unpricedCalls: 0, calls: 3, top: [] }, openApi: null,
    })).toBe('免费调用 3 次');
  });

  it('renderDigestMarkdown：六板块小节 + 未配价附注', () => {
    const md = renderDigestMarkdown(data);
    expect(md).toContain('## 任务');
    expect(md).toContain('失败：甲 —— 超时');
    expect(md).toContain('## 定时任务');
    expect(md).toContain('已自动暂停：日报');
    expect(md).toContain('## 信号哨兵');
    expect(md).toContain('已自动停用：汇率哨兵');
    expect(md).toContain('## 审批待办');
    expect(md).toContain('## 成本');
    expect(md).toContain('- 共 6 次调用');
    expect(md).toContain('另有 1 次调用未配价格，未计入合计');
    expect(md).toContain('## 开放接口');
    expect(md).toContain('其中拒绝 3 次');
  });

  it('digestTitle 与 formatCostMicros', () => {
    expect(digestTitle(YESTERDAY)).toBe('昨日运营摘要（10-11）');
    expect(formatCostMicros(3_420_000)).toBe('3.42');
    expect(formatCostMicros(0)).toBe('0');
    expect(formatCostMicros(12_345_000)).toBe('12.345');
  });
});
