import { describe, expect, it, vi } from 'vitest';
import { InboxService, INBOX_UPDATED_EVENT } from './inbox.service.js';
import type { InboxRepository, NotificationRow, UserInboxPreferenceRow } from './inbox.repository.js';

interface Recorded {
  userId: number;
  kind: string;
  title: string;
  content: string | null;
  sessionId: number | null;
  payloadJson: string | null;
  dedupKey: string;
}

interface Harness {
  service: InboxService;
  inserted: Recorded[];
  events: Array<{ type: string; sessionId: number | null; data: unknown }>;
  unreadByUser: Map<number, number>;
}

/**
 * 内存 fake：只实现「同 dedup_key 唯一」这一条真实约束（与 uk_notification_dedup 一致），
 * 其余按最简语义返回。偏好行可预置。
 */
function makeHarness(options: {
  preference?: UserInboxPreferenceRow | null;
  unread?: Map<number, number>;
} = {}) {
  const inserted: Recorded[] = [];
  const seen = new Set<string>();
  const unreadByUser = options.unread ?? new Map<number, number>();
  const events: Array<{ type: string; sessionId: number | null; data: unknown }> = [];
  const repo = {
    insertIgnore: vi.fn(async (row: Recorded) => {
      if (seen.has(row.dedupKey)) return;
      seen.add(row.dedupKey);
      inserted.push(row);
    }),
    countUnread: vi.fn(async (userId: number) => unreadByUser.get(userId) ?? 0),
    markReadByDedupKey: vi.fn(async () => true),
    markRead: vi.fn(async () => true),
    markAllRead: vi.fn(async () => 0),
    deleteById: vi.fn(async () => true),
    list: vi.fn(async () => ({ rows: [] as NotificationRow[], total: 0 })),
    deleteHistory: vi.fn(async () => 0),
    findPreference: vi.fn(async () => options.preference ?? null),
    savePreference: vi.fn(async () => undefined),
  } as unknown as InboxRepository;
  const registry = { send: vi.fn((userId: number, event: { type: string; sessionId: number | null; data: unknown }) => {
    events.push(event);
  }) };
  const sessionLookup = {
    userIdOf: vi.fn(async (sessionId: number) => sessionId === 11 ? 7 : null),
    titleOf: vi.fn(async (sessionId: number) => (sessionId === 12 ? '整理文档' : null)),
  };
  const service = new InboxService(repo, registry, sessionLookup);
  return { service, inserted, events, unreadByUser, repo, registry, sessionLookup };
}

describe('InboxService 偏好门控', () => {
  it('偏好关闭时该 kind 不写库、也不广播', async () => {
    const h = makeHarness({
      preference: {
        userId: 7,
        taskCompletedEnabled: 0,
        questionPendingEnabled: 1,
        approvalPendingEnabled: 1,
        subagentDoneEnabled: 0,
        systemNotifyEnabled: 1,
      },
    });
    await h.service.recordTaskTerminal({
      userId: 7, sessionId: 11, title: '任务', phase: 'COMPLETED', executionId: 'exec-1',
    });
    expect(h.inserted).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it('SUBAGENT_DONE 默认关（无偏好行按列默认值）→ 不写', async () => {
    const h = makeHarness();
    await h.service.recordSubagentDone({
      parentSessionId: 11, childSessionId: 12, executionId: 5,
      status: 'COMPLETED', result: 'ok', agentType: 'coder', taskDescription: '写个demo',
    });
    expect(h.inserted).toHaveLength(0);
  });

  it('开启后 SUBAGENT_DONE 写入且 payload 带 status/childSessionId/executionId', async () => {
    const h = makeHarness({
      preference: {
        userId: 7, taskCompletedEnabled: 1, questionPendingEnabled: 1,
        approvalPendingEnabled: 1, subagentDoneEnabled: 1, systemNotifyEnabled: 1,
      },
    });
    await h.service.recordSubagentDone({
      parentSessionId: 11, childSessionId: 12, executionId: 5,
      status: 'FAILED', result: 'boom', agentType: 'coder', taskDescription: '写个demo',
    });
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0].kind).toBe('SUBAGENT_DONE');
    expect(h.inserted[0].title).toContain('执行失败');
    // 标题取子会话 title（查询失败才降级 taskDescription）
    expect(h.inserted[0].title).toContain('整理文档');
    expect(JSON.parse(h.inserted[0].payloadJson!)).toMatchObject({
      status: 'FAILED', childSessionId: 12, executionId: 5, agentType: 'coder',
    });
  });

  it('TASK_FAILED 复用 taskCompletedEnabled 开关，并写入 phase/reason', async () => {
    const h = makeHarness();
    await h.service.recordTaskTerminal({
      userId: 7, sessionId: 11, title: '任务', phase: 'FAILED',
      executionId: 'exec-2', failureReason: '模型超时',
    });
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0].kind).toBe('TASK_FAILED');
    expect(h.inserted[0].title).toContain('任务执行失败');
    expect(JSON.parse(h.inserted[0].payloadJson!)).toMatchObject({
      phase: 'FAILED', reason: '模型超时', source: 'MANUAL',
    });
  });
});

describe('InboxService BUDGET_WARN（§5.8）', () => {
  it('越线提醒：kind/title/content/payload/dedupKey（userId:kind:null:budgetId:period）', async () => {
    const h = makeHarness();
    await h.service.recordBudgetWarn({
      userId: 7, budgetId: 9, scope: 'GLOBAL', spend: 12.5, limitValue: 10, limitType: 'COST', period: '2026-03',
    });
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0].kind).toBe('BUDGET_WARN');
    expect(h.inserted[0].title).toBe('预算提醒：本月全局预算已越线');
    expect(h.inserted[0].content).toContain('12.5');
    expect(h.inserted[0].content).toContain('10');
    expect(h.inserted[0].sessionId).toBeNull();
    expect(h.inserted[0].dedupKey).toBe('7:BUDGET_WARN:null:9:2026-03');
    expect(JSON.parse(h.inserted[0].payloadJson!)).toEqual({
      budgetId: 9, scope: 'GLOBAL', spend: 12.5, limitValue: 10, limitType: 'COST',
    });
    expect(h.events).toHaveLength(1); // 广播未读数刷新
  });

  it('同周期同预算只落一行；跨周期重置', async () => {
    const h = makeHarness();
    const warn = { userId: 7, budgetId: 9, scope: 'USER' as const, spend: 1, limitValue: 1, limitType: 'COST' as const };
    await h.service.recordBudgetWarn({ ...warn, period: '2026-03' });
    await h.service.recordBudgetWarn({ ...warn, period: '2026-03' });
    expect(h.inserted).toHaveLength(1);
    await h.service.recordBudgetWarn({ ...warn, period: '2026-04' });
    expect(h.inserted).toHaveLength(2);
    expect(h.inserted[1].dedupKey).toBe('7:BUDGET_WARN:null:9:2026-04');
  });

  it('不同预算各自成条（budgetId 参与去重）', async () => {
    const h = makeHarness();
    await h.service.recordBudgetWarn({ userId: 7, budgetId: 9, scope: 'GLOBAL', spend: 1, limitValue: 1, limitType: 'COST', period: '2026-03' });
    await h.service.recordBudgetWarn({ userId: 7, budgetId: 10, scope: 'GLOBAL', spend: 1, limitValue: 1, limitType: 'COST', period: '2026-03' });
    expect(h.inserted).toHaveLength(2);
  });

  it('偏好关闭 budgetWarnEnabled → 不写不广播', async () => {
    const h = makeHarness({
      preference: {
        userId: 7,
        taskCompletedEnabled: 1,
        questionPendingEnabled: 1,
        approvalPendingEnabled: 1,
        subagentDoneEnabled: 1,
        systemNotifyEnabled: 1,
        budgetWarnEnabled: 0,
      },
    });
    await h.service.recordBudgetWarn({ userId: 7, budgetId: 9, scope: 'GLOBAL', spend: 1, limitValue: 1, limitType: 'COST', period: '2026-03' });
    expect(h.inserted).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it('预算行已删除后同 id 再次提醒仍按 dedup 幂等（不重复打扰）', async () => {
    const h = makeHarness();
    await h.service.recordBudgetWarn({ userId: 7, budgetId: 12, scope: 'AGENT', spend: 3, limitValue: 2, limitType: 'TOKENS', period: '2026-05' });
    await h.service.recordBudgetWarn({ userId: 7, budgetId: 12, scope: 'AGENT', spend: 4, limitValue: 2, limitType: 'TOKENS', period: '2026-05' });
    expect(h.inserted).toHaveLength(1);
  });
});

describe('InboxService 终态过滤', () => {
  it('CANCELLED 不写入（取消多由用户自己发起）', async () => {
    const h = makeHarness();
    await h.service.recordTaskTerminal({
      userId: 7, sessionId: 11, title: '任务', phase: 'CANCELLED', executionId: 'exec-3',
    });
    expect(h.inserted).toHaveLength(0);
  });

  it('未知 kind 一律忽略并 warn，不写库', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = makeHarness();
    await h.service.recordTaskTerminal({
      userId: 7, sessionId: 11, title: '任务', phase: 'RUNNING', executionId: 'exec-4',
    });
    expect(h.inserted).toHaveLength(0);
    warn.mockRestore();
  });
});

describe('InboxService 未读数广播', () => {
  it('每次写路径后广播 inbox_updated 并带权威 unreadCount', async () => {
    const h = makeHarness();
    h.unreadByUser.set(7, 3);
    await h.service.recordQuestionPending({ userId: 7, sessionId: 11, requestId: 'req-1' });
    expect(h.events).toHaveLength(1);
    expect(h.events[0].type).toBe(INBOX_UPDATED_EVENT);
    expect(h.events[0].data).toEqual({ unreadCount: 3 });
    expect(h.events[0].sessionId).toBeNull();
  });

  it('single / all / remove 等写路径也各自广播', async () => {
    const h = makeHarness();
    await h.service.markRead(7, 1);
    await h.service.markAllRead(7);
    await h.service.remove(7, 1);
    await h.service.resolvePending(7, 'QUESTION_PENDING', 11, 'req-1');
    expect(h.events).toHaveLength(4);
    expect(h.events.every((e) => e.type === INBOX_UPDATED_EVENT)).toBe(true);
  });
});

describe('InboxService 幂等键一致性', () => {
  it('写入键 === 联动置已读读取键（inboxDedupKey 单一导出的核心断言）', async () => {
    const h = makeHarness();
    await h.service.recordQuestionPending({ userId: 7, sessionId: 11, requestId: 'req-9' });
    const writeKey = h.inserted[0].dedupKey;

    await h.service.resolvePending(7, 'QUESTION_PENDING', 11, 'req-9');
    expect(h.repo.markReadByDedupKey).toHaveBeenCalledWith(7, writeKey);
  });

  it('APPROVAL_PENDING 的 userId 由内部按 session 解析后拼同一把键', async () => {
    const h = makeHarness();
    await h.service.recordApprovalPending(11, 'req-a');
    expect(h.inserted[0].dedupKey).toBe(h.service.inboxDedupKey(7, 'APPROVAL_PENDING', 11, 'req-a'));

    await h.service.resolveApprovalPending(11, 'req-a');
    expect(h.repo.markReadByDedupKey).toHaveBeenCalledWith(
      7, h.service.inboxDedupKey(7, 'APPROVAL_PENDING', 11, 'req-a'),
    );
  });

  it('executionId 缺省时按 sessionId 兜底，保证同一 session 只落一条', async () => {
    const h = makeHarness();
    await h.service.recordTaskTerminal({
      userId: 7, sessionId: 11, title: '任务', phase: 'COMPLETED', executionId: null,
    });
    expect(h.inserted[0].dedupKey).toBe(h.service.inboxDedupKey(7, 'TASK_COMPLETED', 11, '11'));
  });
});

describe('InboxService 列表与偏好读写', () => {
  it('list 返回分页结构（total/page/size 透传）', async () => {
    const h = makeHarness();
    const result = await h.service.list(7, 2, 10, true);
    expect(h.repo.list).toHaveBeenCalledWith({ userId: 7, page: 2, size: 10, unreadOnly: true });
    expect(result).toEqual({ records: [], total: 0, page: 2, size: 10 });
  });

  it('getPreferences 无行时返回列默认值（前三类开、子代理关、预算提醒开）', async () => {
    const h = makeHarness();
    await expect(h.service.getPreferences(7)).resolves.toEqual({
      taskCompletedEnabled: true,
      questionPendingEnabled: true,
      approvalPendingEnabled: true,
      subagentDoneEnabled: false,
      systemNotifyEnabled: true,
      budgetWarnEnabled: true,
      openApiCallFailedEnabled: false,
    });
  });

  it('getPreferences 读取 systemNotifyEnabled：0 → false（前端据此决定是否弹系统通知）', async () => {
    const h = makeHarness({
      preference: {
        userId: 7, taskCompletedEnabled: 1, questionPendingEnabled: 1,
        approvalPendingEnabled: 1, subagentDoneEnabled: 0, systemNotifyEnabled: 0,
      },
    });
    await expect(h.service.getPreferences(7)).resolves.toMatchObject({
      systemNotifyEnabled: false,
      taskCompletedEnabled: true,
    });
  });

  it('savePreferences 原样回写（last-write-wins，无乐观锁）', async () => {
    const h = makeHarness();
    const saved = await h.service.savePreferences(7, {
      taskCompletedEnabled: false,
      questionPendingEnabled: false,
      approvalPendingEnabled: true,
      subagentDoneEnabled: true,
      budgetWarnEnabled: true,
      openApiCallFailedEnabled: false,
      systemNotifyEnabled: false,
    });
    expect(saved.subagentDoneEnabled).toBe(true);
    expect(h.repo.savePreference).toHaveBeenCalledWith(7, {
      taskCompletedEnabled: false,
      questionPendingEnabled: false,
      approvalPendingEnabled: true,
      subagentDoneEnabled: true,
      budgetWarnEnabled: true,
      openApiCallFailedEnabled: false,
      systemNotifyEnabled: false,
    });
  });
});
