import { describe, expect, it, vi } from 'vitest';
import {
  FAILED_RECOVERY_MAX_BATCH,
  FailedSessionRecoveryService,
  isQuotaRelatedError,
  type FailedRecoveryKernel,
  type FailedRecoveryStore,
} from './failed-session-recovery.service.js';
import type { FailedSessionCandidateRow } from './session.repository.js';
import type { Session } from './types.js';

const QUOTA_ERROR_403 =
  'LLM API returned 403: {"error":{"message":"预扣费额度失败, 用户剩余额度: $0.0078","type":"new_api_error","code":"insufficient_user_quota"}}';
const QUOTA_ERROR_402 = 'LLM API returned 402: 余额不足（insufficient balance）';
const PERM_ERROR_403 = 'LLM API returned 403: {"error":{"message":"无权访问该模型"}}';

function candidateRow(overrides: Partial<FailedSessionCandidateRow> = {}): FailedSessionCandidateRow {
  return {
    sessionId: 431,
    userId: 24,
    agentId: 9,
    title: '采购入库品牌查询',
    executionMode: 'CLOUD',
    sessionType: 'NORMAL',
    lastActivityAt: '2026-11-06 18:15:53',
    errorMessage: QUOTA_ERROR_403,
    failedAt: '2026-11-06 18:15:52',
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
    listFailedSessionsWithLastAgentError: vi.fn(async (opts: { ids?: number[] }) =>
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

describe('isQuotaRelatedError', () => {
  it('matchesQuotaKeywordsCaseInsensitively', () => {
    expect(isQuotaRelatedError(QUOTA_ERROR_403)).toBe(true);
    expect(isQuotaRelatedError(QUOTA_ERROR_402)).toBe(true);
    expect(isQuotaRelatedError('Insufficient User Quota')).toBe(true);
    expect(isQuotaRelatedError('账户欠费，请充值')).toBe(true);
    expect(isQuotaRelatedError('预扣费额度失败')).toBe(true);
  });

  it('rejectsPermissionErrorsAndEmpty', () => {
    expect(isQuotaRelatedError(PERM_ERROR_403)).toBe(false);
    expect(isQuotaRelatedError(null)).toBe(false);
    expect(isQuotaRelatedError('')).toBe(false);
  });
});

describe('FailedSessionRecoveryService.preview', () => {
  it('passesWindowStartOf24hAndEnrichesItems', async () => {
    const { service, store } = makeHarness([candidateRow()]);
    const preview = await service.preview(24, 'QUOTA');
    // 窗口起点 = now - 24h，格式与 nowSql 同构（本地时区 'YYYY-MM-DD HH:mm:ss'）
    const windowStart = (store.listFailedSessionsWithLastAgentError.mock.calls[0][0] as { windowStart: string }).windowStart;
    expect(windowStart).toBe('2026-11-06 18:15:53');
    expect(store.listFailedSessionsWithLastAgentError).toHaveBeenCalledWith(
      expect.objectContaining({ windowStart, limit: expect.any(Number) }),
    );
    expect(preview.total).toBe(1);
    expect(preview.recoverableCount).toBe(1);
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
    });
    expect(item.errorSummary).toContain('预扣费额度失败');
  });

  it('marksNonQuota403AsSkippedUnderQuotaScopeButRecoverableUnderAllScope', async () => {
    const { service } = makeHarness([candidateRow({ errorMessage: PERM_ERROR_403 })]);
    const quotaPreview = await service.preview(24, 'QUOTA');
    expect(quotaPreview.items[0]).toMatchObject({ willRecover: false, skipReason: 'NON_QUOTA_ERROR' });
    const allPreview = await service.preview(24, 'ALL_402_403');
    expect(allPreview.items[0]).toMatchObject({ willRecover: true, skipReason: null });
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
    const preview = await claimedService.preview(24, 'QUOTA');
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
    const preview = await noCardService.preview(24, 'QUOTA');
    expect(preview.items[0]).toMatchObject({
      scheduledTask: { id: 77, name: '每日库存播报' },
      hasProgressCard: false,
    });
  });

  it('clampsWindowHoursIntoLegalRange', async () => {
    const { service, store } = makeHarness([]);
    await service.preview(999, 'QUOTA');
    const opts = store.listFailedSessionsWithLastAgentError.mock.calls[0][0] as { windowStart: string };
    // 999 小时被收紧到 168：窗口起点 = now - 168h = 2026-10-31 18:15:53
    expect(opts.windowStart).toBe('2026-10-31 18:15:53');
  });
});

describe('FailedSessionRecoveryService.run', () => {
  it('dedupesIdsAndDelegatesEligibleSessionsToKernel', async () => {
    const { service, kernel } = makeHarness([candidateRow({ sessionId: 431 }), candidateRow({ sessionId: 473 })]);
    const result = await service.run([431, 431, 473], 'QUOTA');
    expect(kernel.recoverFailedSessions).toHaveBeenCalledWith([431, 473], expect.objectContaining({
      onSessionFinished: expect.any(Function),
    }));
    expect(result).toEqual({ accepted: [431, 473], skipped: [] });
  });

  it('skipsMissingRowsWithFineGrainedReasons', async () => {
    // 999：会话不在库（NOT_FAILED）；998：存在但 phase 已被用户手动重试为 RUNNING（NOT_FAILED）；
    // 997：仍 FAILED 但最后一次 agent 调用不再是 402/403（NOT_402_403）。
    const sessionsById = new Map<number, Session>([
      [998, { id: 998, phase: 'RUNNING' } as Session],
      [997, { id: 997, phase: 'FAILED' } as Session],
    ]);
    const { service } = makeHarness([], {
      store: {
        listFailedSessionsWithLastAgentError: vi.fn(async () => []),
        listSessionIdsWithPendingTaskRetry: vi.fn(async () => new Set<number>()),
        listScheduledTaskRefsBySessionIds: vi.fn(async () => new Map()),
        findById: vi.fn(async (id: number) => sessionsById.get(id) ?? null),
      } as unknown as FailedRecoveryStore,
    });
    const result = await service.run([999, 998, 997], 'QUOTA');
    expect(result.accepted).toEqual([]);
    expect(result.skipped).toEqual([
      { sessionId: 999, reason: 'NOT_FAILED' },
      { sessionId: 998, reason: 'NOT_FAILED' },
      { sessionId: 997, reason: 'NOT_402_403' },
    ]);
  });

  it('revalidatesExclusionsAtRunTime', async () => {
    // 会话 3 在预览后被 WS 执行占位（用户手动发消息）
    const { service } = makeHarness([
      candidateRow({ sessionId: 1, errorMessage: PERM_ERROR_403 }),
      candidateRow({ sessionId: 2, executionMode: 'LOCAL' }),
      candidateRow({ sessionId: 3 }),
    ], { isSessionClaimed: (id: number) => id === 3 });
    const result = await service.run([1, 2, 3], 'QUOTA');
    expect(result.accepted).toEqual([]);
    expect(result.skipped).toEqual([
      { sessionId: 1, reason: 'NON_QUOTA_ERROR' },
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
    const result = await service.run([431], 'QUOTA');
    expect(result.accepted).toEqual([]);
    expect(result.skipped).toEqual([{ sessionId: 431, reason: 'EXECUTOR_BUSY' }]);
  });

  it('rejectsBatchAboveLimit', async () => {
    const { service, kernel } = makeHarness([]);
    const ids = Array.from({ length: FAILED_RECOVERY_MAX_BATCH + 1 }, (_, i) => i + 1);
    await expect(service.run(ids, 'QUOTA')).rejects.toMatchObject({ code: 2001 });
    expect(kernel.recoverFailedSessions).not.toHaveBeenCalled();
  });

  it('throwsWhenKernelMissing', async () => {
    const detached = new FailedSessionRecoveryService({
      store: {
        listFailedSessionsWithLastAgentError: vi.fn(async () => [candidateRow()]),
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
    await expect(detached.run([431], 'QUOTA')).rejects.toMatchObject({ code: 5001 });
  });

  it('pushesFallbackReplyOnlyForCompletedSessionsWithoutCard', async () => {
    const { service, kernel, deps } = makeHarness([candidateRow()]);
    await service.run([431], 'QUOTA');
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
