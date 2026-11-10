import { describe, expect, it, vi } from 'vitest';
import {
  FAILED_RECOVERY_MAX_BATCH,
  FailedSessionRecoveryService,
  type FailedRecoveryKernel,
  type FailedRecoveryStore,
} from './failed-session-recovery.service.js';
import type { FailedSessionCandidateRow } from './session.repository.js';
import type { Session } from './types.js';

const QUOTA_ERROR_403 =
  'LLM API returned 403: {"error":{"message":"预扣费额度失败, 用户剩余额度: $0.0078","type":"new_api_error","code":"insufficient_user_quota"}}';
const PERM_ERROR_403 = 'LLM API returned 403: {"error":{"message":"无权访问该模型"}}';
const TOOL_ERROR = 'tool bash failed: exit 1';

function candidateRow(overrides: Partial<FailedSessionCandidateRow> = {}): FailedSessionCandidateRow {
  return {
    sessionId: 431,
    userId: 24,
    agentId: 9,
    title: '采购入库品牌查询',
    executionMode: 'CLOUD',
    sessionType: 'NORMAL',
    lastActivityAt: '2026-11-06 18:15:53',
    runtimeStatusJson: JSON.stringify({ executionError: QUOTA_ERROR_403 }),
    llmErrorMessage: QUOTA_ERROR_403,
    llmSuccess: 0,
    llmCalledAt: '2026-11-06 18:15:52',
    ...overrides,
  };
}

interface Harness {
  service: FailedSessionRecoveryService;
  store: Record<string, ReturnType<typeof vi.fn>>;
  deps: Record<string, ReturnType<typeof vi.fn> | ((id: number) => boolean)>;
  kernel: { recoverFailedSessions: ReturnType<typeof vi.fn> };
}

function makeHarness(rows: FailedSessionCandidateRow[] = [], overrides: Record<string, unknown> = {}): Harness {
  const sessionsById = new Map<number, Session>(
    rows.map((row) => [row.sessionId, { id: row.sessionId, phase: 'FAILED' } as Session]),
  );
  const store = {
    listFailedSessionsForRecovery: vi.fn(async (opts: { ids?: number[] }) =>
      opts.ids == null ? rows : rows.filter((row) => opts.ids!.includes(row.sessionId))),
    listSessionIdsWithPendingTaskRetry: vi.fn(async () => new Set<number>()),
    listScheduledTaskRefsBySessionIds: vi.fn(async () => new Map<number, Array<{ id: number; name: string }>>()),
    findById: vi.fn(async (id: number) => sessionsById.get(id) ?? null),
  };
  const kernel = {
    recoverFailedSessions: vi.fn(async (ids: number[]) => ({ accepted: ids, skipped: [] })),
  };
  const deps = {
    store: store as unknown as FailedRecoveryStore,
    userLookup: {
      findByIds: vi.fn(async (ids: number[]) => ids.map((id) => ({ id, username: `u${id}`, displayName: `用户${id}` }))),
    },
    agentLookup: {
      findByIds: vi.fn(async (ids: number[]) => ids.map((id) => ({ id, name: `Agent${id}` }))),
    },
    messageLookup: { getLastUserMessage: vi.fn(async () => ({ content: '可以根据主体（寰明）在宁波大贸仓查询库存' })) },
    progressCardLookup: {
      findBySessionIds: vi.fn(async (ids: number[]) => new Map(ids.map((id) => [id, { sessionId: id }]))),
    },
    isSessionClaimed: vi.fn(() => false),
    pushFinalReply: vi.fn(async () => undefined),
    now: () => new Date('2026-11-07T18:15:53'),
    ...overrides,
  };
  const service = new FailedSessionRecoveryService(deps as never);
  service.attachKernel(kernel as unknown as FailedRecoveryKernel);
  return { service, store, deps, kernel };
}

describe('FailedSessionRecoveryService.preview', () => {
  it('passesWindowStartOf24hAndEnrichesItems', async () => {
    const { service, store } = makeHarness([candidateRow()]);
    const preview = await service.preview(24);
    // 窗口起点 = now - 24h，格式与 nowSql 同构（本地时区 'YYYY-MM-DD HH:mm:ss'）
    const windowStart = (store.listFailedSessionsForRecovery.mock.calls[0][0] as { windowStart: string }).windowStart;
    expect(windowStart).toBe('2026-11-06 18:15:53');
    expect(store.listFailedSessionsForRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ windowStart, limit: expect.any(Number) }),
    );
    expect(preview.total).toBe(1);
    expect(preview.recoverableCount).toBe(1);
    expect(preview.truncated).toBe(false);
    const item = preview.items[0];
    expect(item).toMatchObject({
      sessionId: 431,
      userName: '用户24',
      agentName: 'Agent9',
      phase: 'FAILED',
      httpStatus: 403,
      errorCode: 'insufficient_user_quota',
      willRecover: true,
      skipReason: null,
      hasProgressCard: true,
      lastUserMessage: '可以根据主体（寰明）在宁波大贸仓查询库存',
      failedAt: '2026-11-06 18:15:52',
    });
    expect(item.errorSummary).toContain('预扣费额度失败');
  });

  it('listsPermissionAndToolFailuresAsRecoverable', async () => {
    const { service } = makeHarness([
      candidateRow({
        sessionId: 1,
        runtimeStatusJson: JSON.stringify({ executionError: PERM_ERROR_403 }),
        llmErrorMessage: PERM_ERROR_403,
        llmSuccess: 0,
      }),
      candidateRow({
        sessionId: 2,
        runtimeStatusJson: JSON.stringify({ executionError: TOOL_ERROR }),
        llmErrorMessage: null,
        llmSuccess: 1,
        llmCalledAt: '2026-11-06 18:10:00',
      }),
      candidateRow({
        sessionId: 3,
        runtimeStatusJson: null,
        llmErrorMessage: null,
        llmSuccess: null,
        llmCalledAt: null,
      }),
    ]);
    const preview = await service.preview(24);
    expect(preview.items.map((item) => [item.sessionId, item.willRecover, item.skipReason, item.httpStatus])).toEqual([
      [1, true, null, 403],
      [2, true, null, null],
      [3, true, null, null],
    ]);
    expect(preview.items[1].errorSummary).toContain('tool bash failed');
    expect(preview.items[1].failedAt).toBe('2026-11-06 18:15:53');
    expect(preview.items[2].errorSummary).toBe('执行失败');
    expect(preview.recoverableCount).toBe(3);
  });

  it('marksLocalModePendingRetryAndClaimedRowsAsSkipped', async () => {
    const { service, deps } = makeHarness([
      candidateRow({ sessionId: 1, executionMode: 'LOCAL' }),
      candidateRow({ sessionId: 2 }),
      candidateRow({ sessionId: 3 }),
    ]);
    (deps.store as unknown as FailedRecoveryStore).listSessionIdsWithPendingTaskRetry = vi.fn(async () => new Set([3]));
    const claimedDeps = { ...deps, isSessionClaimed: (id: number) => id === 2 };
    const claimedService = new FailedSessionRecoveryService(claimedDeps as never);
    claimedService.attachKernel({ recoverFailedSessions: vi.fn() } as unknown as FailedRecoveryKernel);
    const preview = await claimedService.preview(24);
    expect(preview.items.map((item) => [item.sessionId, item.skipReason])).toEqual([
      [1, 'LOCAL_MODE'],
      [2, 'ALREADY_RUNNING'],
      [3, 'PENDING_TASK_RETRY'],
    ]);
    expect(preview.recoverableCount).toBe(0);
  });

  it('showsScheduledTaskRefAndHandlesMissingCardLookup', async () => {
    const { service, deps } = makeHarness([candidateRow()]);
    (deps.store as unknown as FailedRecoveryStore).listScheduledTaskRefsBySessionIds = vi.fn(async () =>
      new Map([[431, [{ id: 77, name: '每日库存播报' }]]]));
    const noCardDeps = { ...deps, progressCardLookup: {} };
    const noCardService = new FailedSessionRecoveryService(noCardDeps as never);
    noCardService.attachKernel({ recoverFailedSessions: vi.fn() } as unknown as FailedRecoveryKernel);
    const preview = await noCardService.preview(24);
    expect(preview.items[0]).toMatchObject({
      scheduledTask: { id: 77, name: '每日库存播报' },
      hasProgressCard: false,
    });
  });

  it('clampsWindowHoursIntoLegalRange', async () => {
    const { service, store } = makeHarness([]);
    await service.preview(999);
    const opts = store.listFailedSessionsForRecovery.mock.calls[0][0] as { windowStart: string };
    // 999 小时被收紧到 168：窗口起点 = now - 168h = 2026-10-31 18:15:53
    expect(opts.windowStart).toBe('2026-10-31 18:15:53');
  });
});

describe('FailedSessionRecoveryService.run', () => {
  it('dedupesIdsAndDelegatesEligibleSessionsToKernel', async () => {
    const { service, kernel } = makeHarness([candidateRow({ sessionId: 431 }), candidateRow({ sessionId: 473 })]);
    const result = await service.run([431, 431, 473]);
    expect(kernel.recoverFailedSessions).toHaveBeenCalledWith([431, 473], expect.objectContaining({
      onSessionFinished: expect.any(Function),
    }));
    expect(result).toEqual({ accepted: [431, 473], skipped: [] });
  });

  it('skipsMissingRowsWithFineGrainedReasons', async () => {
    // 999：会话不在库（NOT_FAILED）；998：存在但 phase 已被用户手动重试为 RUNNING（NOT_FAILED）；
    // 997：仍 FAILED 但是子代理，候选查询只收 NORMAL，所以行缺失（NON_NORMAL_SESSION）。
    const sessionsById = new Map<number, Session>([
      [998, { id: 998, phase: 'RUNNING', sessionType: 'NORMAL' } as Session],
      [997, { id: 997, phase: 'FAILED', sessionType: 'SUBAGENT' } as Session],
    ]);
    const { service } = makeHarness([], {
      store: {
        listFailedSessionsForRecovery: vi.fn(async () => []),
        listSessionIdsWithPendingTaskRetry: vi.fn(async () => new Set<number>()),
        listScheduledTaskRefsBySessionIds: vi.fn(async () => new Map()),
        findById: vi.fn(async (id: number) => sessionsById.get(id) ?? null),
      } as unknown as FailedRecoveryStore,
    });
    const result = await service.run([999, 998, 997]);
    expect(result.accepted).toEqual([]);
    expect(result.skipped).toEqual([
      { sessionId: 999, reason: 'NOT_FAILED' },
      { sessionId: 998, reason: 'NOT_FAILED' },
      { sessionId: 997, reason: 'NON_NORMAL_SESSION' },
    ]);
  });

  it('revalidatesExclusionsAtRunTime', async () => {
    // 会话 3 在预览后被 WS 执行占位（用户手动发消息）
    const { service, kernel } = makeHarness([
      candidateRow({
        sessionId: 1,
        runtimeStatusJson: JSON.stringify({ executionError: PERM_ERROR_403 }),
        llmErrorMessage: PERM_ERROR_403,
      }),
      candidateRow({ sessionId: 2, executionMode: 'LOCAL' }),
      candidateRow({ sessionId: 3 }),
    ], { isSessionClaimed: (id: number) => id === 3 });
    const result = await service.run([1, 2, 3]);
    expect(kernel.recoverFailedSessions).toHaveBeenCalledWith([1], expect.any(Object));
    expect(result.accepted).toEqual([1]);
    expect(result.skipped).toEqual([
      { sessionId: 2, reason: 'LOCAL_MODE' },
      { sessionId: 3, reason: 'ALREADY_RUNNING' },
    ]);
  });

  it('mergesKernelSkipReasonsIntoResult', async () => {
    const { service, kernel } = makeHarness([candidateRow({ sessionId: 431 })]);
    kernel.recoverFailedSessions.mockResolvedValueOnce({
      accepted: [],
      skipped: [{ id: 431, reason: 'EXECUTOR_BUSY' }],
    });
    const result = await service.run([431]);
    expect(result.accepted).toEqual([]);
    expect(result.skipped).toEqual([{ sessionId: 431, reason: 'EXECUTOR_BUSY' }]);
  });

  it('rejectsBatchAboveLimit', async () => {
    const { service, kernel } = makeHarness([]);
    const ids = Array.from({ length: FAILED_RECOVERY_MAX_BATCH + 1 }, (_, i) => i + 1);
    await expect(service.run(ids)).rejects.toMatchObject({ code: 2001 });
    expect(kernel.recoverFailedSessions).not.toHaveBeenCalled();
  });

  it('throwsWhenKernelMissing', async () => {
    const detached = new FailedSessionRecoveryService({
      store: {
        listFailedSessionsForRecovery: vi.fn(async () => [candidateRow()]),
        listSessionIdsWithPendingTaskRetry: vi.fn(async () => new Set<number>()),
        listScheduledTaskRefsBySessionIds: vi.fn(async () => new Map()),
        findById: vi.fn(async () => null),
      } as unknown as FailedRecoveryStore,
      userLookup: { findByIds: vi.fn(async () => []) },
      agentLookup: { findByIds: vi.fn(async () => []) },
      messageLookup: { getLastUserMessage: vi.fn(async () => null) },
      progressCardLookup: {},
      isSessionClaimed: () => false,
    } as never);
    await expect(detached.run([431])).rejects.toMatchObject({ code: 5001 });
  });

  it('pushesFallbackReplyOnlyForCompletedSessionsWithoutCard', async () => {
    const { service, kernel, deps } = makeHarness([candidateRow()]);
    await service.run([431]);
    const onFinished = (kernel.recoverFailedSessions.mock.calls[0][1] as {
      onSessionFinished?: (sessionId: number, outcome: { phase: 'COMPLETED' | 'FAILED' | 'CANCELLED'; hadProgressCard: boolean }) => Promise<void>;
    }).onSessionFinished;
    expect(onFinished).toBeDefined();
    await onFinished!(431, { phase: 'COMPLETED', hadProgressCard: false });
    expect(deps.pushFinalReply).toHaveBeenCalledWith(431);
    await onFinished!(431, { phase: 'COMPLETED', hadProgressCard: true });
    await onFinished!(431, { phase: 'FAILED', hadProgressCard: false });
    expect(deps.pushFinalReply).toHaveBeenCalledTimes(1);
  });
});
