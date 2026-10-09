import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { FixedWindowRateLimiter } from './rate-limiter.js';
import { OpenApiCallLogCleanup } from './open-api-call-log.cleanup.js';
import {
  bucketAnomalyFlags,
  buildCallSummary,
  buildOpenApiCallCsv,
  countsTowardAutoDisable,
  fullBodyJson,
  FULL_BODY_MAX_BYTES,
  isTrafficSpike,
  logicalRejection,
  messageFromFullJson,
  percentile,
  queueWaitMsOf,
  redactSensitive,
} from './open-api-call-log.logic.js';
import { OpenApiCallLogService } from './open-api-call-log.service.js';
import type { OpenApiCallLogRepository, OpenApiCallLogRow } from './open-api-call-log.repository.js';
import { ApiTokenService } from './api-token.service.js';
import type { ApiToken, MysqlApiTokenRepository } from './openapi.repository.js';

describe('开放调用流水纯逻辑', () => {
  it('摘要不含 message 明文', () => {
    const summary = buildCallSummary('API', { message: '密钥 sk-live', sessionId: 42 });
    expect(summary).not.toContain('sk-live');
    expect(JSON.parse(summary)).toEqual({ messageChars: '密钥 sk-live'.length, sessionId: 42 });
    const hook = JSON.parse(buildCallSummary('WEBHOOK', JSON.stringify({ event: 'push', data: { password: 'p' } })));
    expect(hook.payloadKeys).toEqual(['event', 'data']);
    expect(JSON.stringify(hook)).not.toContain('password');
  });

  it('完整请求体递归打码并按字节截断', () => {
    const json = fullBodyJson({ message: 'hi', nested: { password: 'secret', items: [{ api_key: 'k' }] } });
    const parsed = JSON.parse(json);
    expect(parsed.nested.password).toBe('***');
    expect(parsed.nested.items[0].api_key).toBe('***');
    expect(parsed.message).toBe('hi');
    const huge = fullBodyJson({ message: '测'.repeat(40_000) });
    expect(Buffer.byteLength(huge, 'utf8')).toBeLessThanOrEqual(FULL_BODY_MAX_BYTES);
    expect(() => JSON.parse(huge)).not.toThrow();
  });

  it('逻辑状态按常量名映射，3041 记为预算拒绝', () => {
    expect(logicalRejection(new BusinessException(ErrorCode.BUDGET_EXCEEDED, '超了'))).toMatchObject({
      httpStatus: 403, errorCode: 'BUDGET_EXCEEDED',
    });
    expect(logicalRejection(new BusinessException(ErrorCode.PARAM_INVALID, '坏'))).toMatchObject({
      httpStatus: 400, errorCode: 'PARAM_INVALID',
    });
    expect(logicalRejection(new BusinessException(ErrorCode.AGENT_NOT_FOUND))).toMatchObject({ httpStatus: 404, errorCode: 'AGENT_NOT_FOUND' });
    expect(logicalRejection(new BusinessException(ErrorCode.RATE_LIMITED))).toMatchObject({ httpStatus: 429, errorCode: 'RATE_LIMITED' });
    expect(logicalRejection(new Error('boom'))).toMatchObject({ httpStatus: 500, errorCode: 'INTERNAL_ERROR' });
  });

  it('排队等待解析失败时返回 null，不抛错', () => {
    expect(queueWaitMsOf('not-a-date')).toBeNull();
    expect(queueWaitMsOf(null)).toBeNull();
    const now = Date.parse('2026-10-09T10:00:10');
    const wait = queueWaitMsOf('2026-10-09 10:00:00', now);
    expect(wait).toBe(10_000);
  });

  it('异常高亮：全是拒绝只标 rejectRateHigh；流量突增按 7 日均值', () => {
    expect(bucketAnomalyFlags({ total: 12, completed: 0, failed: 0, rejected: 12 })).toEqual({
      successRateLow: false, rejectRateHigh: true,
    });
    expect(bucketAnomalyFlags({ total: 12, completed: 2, failed: 8, rejected: 2 })).toEqual({
      successRateLow: true, rejectRateHigh: false,
    });
    expect(isTrafficSpike(9, 0)).toBe(false);
    expect(isTrafficSpike(10, 0)).toBe(true);
    expect(isTrafficSpike(50, 70)).toBe(true);
  });

  it('P95 取最近秩，空样本为 null', () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
  });

  it('自动停用计数排除 429、已停用、重放和非 API', () => {
    expect(countsTowardAutoDisable({ source: 'API', tokenId: 1, replayOfId: null, errorCode: 'PARAM_INVALID', outcome: 'rejected' })).toBe(true);
    expect(countsTowardAutoDisable({ source: 'API', tokenId: 1, replayOfId: null, errorCode: 'RATE_LIMITED', outcome: 'rejected' })).toBe(false);
    expect(countsTowardAutoDisable({ source: 'API', tokenId: 1, replayOfId: 9, errorCode: 'PARAM_INVALID', outcome: 'rejected' })).toBe(false);
    expect(countsTowardAutoDisable({ source: 'WEBHOOK', tokenId: null, replayOfId: null, errorCode: null, outcome: 'failed' })).toBe(false);
    expect(countsTowardAutoDisable({ source: 'API', tokenId: 1, replayOfId: null, errorCode: 'TOKEN_AUTO_DISABLED', outcome: 'rejected' })).toBe(false);
  });

  it('CSV 带 BOM 与 CRLF，转义引号，且不出现完整请求体列', () => {
    const csv = buildOpenApiCallCsv([{ createdAt: '2026-10-09 10:00:00', source: 'API', errorSummary: 'say "hi"', userId: 1 }]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('\r\n');
    expect(csv).toContain('"say ""hi"""');
    expect(csv).not.toContain('requestFullJson');
  });

  it('从完整记录取出 message', () => {
    expect(messageFromFullJson(JSON.stringify({ message: ' hello ' }))).toBe(' hello ');
    expect(messageFromFullJson('{}')).toBeNull();
    expect(messageFromFullJson('not-json')).toBeNull();
  });

  it('打码不改原对象的非敏感键', () => {
    expect(redactSensitive([{ token: 'abc', n: 1 }])).toEqual([{ token: '***', n: 1 }]);
  });
});

function memoryRepo() {
  const rows = new Map<number, OpenApiCallLogRow>();
  let next = 1;
  const repo = {
    insert: vi.fn(async (row: OpenApiCallLogRow) => {
      const id = next++;
      rows.set(id, { ...row, id, outcome: row.outcome, createdAt: '2026-10-09 10:00:00' });
      return id;
    }),
    markFinished: vi.fn(async (id: number, patch: Partial<OpenApiCallLogRow> & { outcome: string }) => {
      const row = rows.get(id);
      if (row == null || (row.outcome !== 'pending' && row.outcome !== 'queued')) return false;
      Object.assign(row, patch);
      return true;
    }),
    settleQueued: vi.fn(async (id: number, outcome: string, queueWaitMs: number | null, messageId: number | null) => {
      const row = rows.get(id);
      if (row == null || (row.outcome !== 'pending' && row.outcome !== 'queued')) return false;
      row.outcome = outcome;
      row.queueWaitMs = queueWaitMs;
      row.messageId = messageId ?? row.messageId;
      row.executionMs = 1000;
      return true;
    }),
    findById: vi.fn(async (id: number, userId?: number) => {
      const row = rows.get(id) ?? null;
      if (row == null) return null;
      if (userId != null && row.userId !== userId) return null;
      return row;
    }),
    list: vi.fn(async () => ({ records: [...rows.values()], total: rows.size })),
    aggregate: vi.fn(async () => []),
    sampleLatencies: vi.fn(async () => []),
    trafficByToken: vi.fn(async () => []),
    deleteBatch: vi.fn(async () => 0),
    rows,
  };
  return repo;
}

describe('OpenApiCallLogService', () => {
  it('同 IP 第 21 条查无 token 不落行', async () => {
    const repo = memoryRepo();
    const service = new OpenApiCallLogService({
      repo: repo as unknown as OpenApiCallLogRepository,
      rejectLimiter: new FixedWindowRateLimiter(60_000, () => 1_000),
    });
    for (let i = 0; i < 21; i += 1) {
      await service.recordAuthReject({ reason: 'not_found', tokenPrefix: 'mao_badbadba', sourceIp: '1.1.1.1' });
    }
    expect(repo.insert).toHaveBeenCalledTimes(20);
  });

  it('吊销 token 落行带 tokenId，且不计入自动停用', async () => {
    const repo = memoryRepo();
    const recordTokenOutcome = vi.fn();
    const service = new OpenApiCallLogService({
      repo: repo as unknown as OpenApiCallLogRepository,
      tokens: { findById: async () => null, recordTokenOutcome },
    });
    await service.recordAuthReject({ reason: 'revoked', tokenPrefix: 'mao_abcdefgh', tokenId: 3, userId: 7, sourceIp: '2.2.2.2' });
    expect(repo.rows.get(1)).toMatchObject({ tokenId: 3, userId: 7, errorCode: 'TOKEN_REVOKED', outcome: 'rejected' });
    expect(recordTokenOutcome).not.toHaveBeenCalled();
  });

  it('直跑成功同时写 duration 与 execution，重复 settle 不覆盖', async () => {
    const repo = memoryRepo();
    const recordTokenOutcome = vi.fn();
    const service = new OpenApiCallLogService({
      repo: repo as unknown as OpenApiCallLogRepository,
      tokens: { findById: async () => ({ id: 3, name: 'ci', logFullBody: 0 }), recordTokenOutcome },
      now: () => 5_000,
    });
    const begun = await service.begin({ source: 'API', tokenId: 3, userId: 7, agentId: 1, body: { message: 'hi', sessionId: null } });
    await service.markAccepted(begun!.id, 4_000, { sessionId: 9, messageId: 8, queued: false, terminalPhase: 'COMPLETED' });
    expect(repo.rows.get(begun!.id)).toMatchObject({ outcome: 'completed', durationMs: 1000, executionMs: 1000, messageId: 8 });
    expect(recordTokenOutcome).toHaveBeenCalledWith(3, 'completed');
    await service.settleQueued(begun!.id, 'FAILED', 10, 99);
    expect(repo.rows.get(begun!.id)?.outcome).toBe('completed');
  });

  it('排队回写失败会计入自动停用；重放行不计', async () => {
    const repo = memoryRepo();
    const recordTokenOutcome = vi.fn();
    const service = new OpenApiCallLogService({
      repo: repo as unknown as OpenApiCallLogRepository,
      tokens: { findById: async () => ({ id: 3, name: 'ci', logFullBody: 1 }), recordTokenOutcome },
    });
    const queued = await service.begin({ source: 'API', tokenId: 3, userId: 7, body: { message: 'q', password: 'p' } });
    expect(repo.rows.get(queued!.id)?.requestFullJson).toContain('"password":"***"');
    await service.markAccepted(queued!.id, queued!.startedAt, { sessionId: 1, messageId: null, queued: true, terminalPhase: 'COMPLETED' });
    await service.settleQueued(queued!.id, 'FAILED', 30, 44);
    expect(recordTokenOutcome).toHaveBeenCalledWith(3, 'failed');
    expect(repo.rows.get(queued!.id)).toMatchObject({ outcome: 'failed', messageId: 44, queueWaitMs: 30 });

    recordTokenOutcome.mockClear();
    const replay = await service.begin({ source: 'API', tokenId: 3, userId: 7, replayOfId: queued!.id, body: { message: 'again' } });
    await service.markAccepted(replay!.id, replay!.startedAt, { sessionId: 1, messageId: 2, queued: false, terminalPhase: 'FAILED' });
    expect(recordTokenOutcome).not.toHaveBeenCalled();
  });

  it('同一 10 分钟桶里并发失败不会把次数盖成 1', async () => {
    const repo = memoryRepo();
    let lookups = 0;
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const recordOpenApiCallFailed = vi.fn();
    let arm = false;
    const service = new OpenApiCallLogService({
      repo: repo as unknown as OpenApiCallLogRepository,
      tokens: {
        findById: async () => {
          if (!arm) return { id: 3, name: 'ci', logFullBody: 0 };
          lookups += 1;
          if (lookups === 1) await firstGate;
          return { id: 3, name: 'ci', logFullBody: 0 };
        },
        recordTokenOutcome: async () => undefined,
      },
      inbox: { recordOpenApiCallFailed },
      now: () => 1_000,
    });
    const first = await service.begin({ source: 'API', tokenId: 3, userId: 7, body: { message: 'a' } });
    const second = await service.begin({ source: 'API', tokenId: 3, userId: 7, body: { message: 'b' } });
    arm = true;
    const p1 = service.markRejected(first!.id, 1_000, new BusinessException(ErrorCode.PARAM_INVALID, '坏'));
    await vi.waitFor(() => { if (lookups < 1) throw new Error('wait'); });
    const p2 = service.markRejected(second!.id, 1_000, new BusinessException(ErrorCode.PARAM_INVALID, '又坏'));
    await p2;
    releaseFirst();
    await p1;
    await service.flushFailures(600_000);
    expect(recordOpenApiCallFailed.mock.calls[0][0].count).toBe(2);
  });

  it('失败通知按 10 分钟桶聚合，flush 时才投递', async () => {
    const repo = memoryRepo();
    const recordOpenApiCallFailed = vi.fn();
    let now = 0;
    const service = new OpenApiCallLogService({
      repo: repo as unknown as OpenApiCallLogRepository,
      tokens: { findById: async () => ({ id: 3, name: 'ci' }), recordTokenOutcome: async () => undefined },
      inbox: { recordOpenApiCallFailed },
      now: () => now,
    });
    const first = await service.begin({ source: 'API', tokenId: 3, userId: 7, body: { message: 'a' } });
    await service.markRejected(first!.id, 0, new BusinessException(ErrorCode.PARAM_INVALID, '坏'));
    const second = await service.begin({ source: 'API', tokenId: 3, userId: 7, body: { message: 'b' } });
    await service.markRejected(second!.id, 0, new BusinessException(ErrorCode.PARAM_INVALID, '又坏'));
    expect(recordOpenApiCallFailed).not.toHaveBeenCalled();
    now = 600_000;
    await service.flushFailures(now);
    expect(recordOpenApiCallFailed).toHaveBeenCalledTimes(1);
    expect(recordOpenApiCallFailed.mock.calls[0][0].count).toBe(2);
  });

  it('用户详情看不到别人的行', async () => {
    const repo = memoryRepo();
    const service = new OpenApiCallLogService({ repo: repo as unknown as OpenApiCallLogRepository });
    const begun = await service.begin({ source: 'API', userId: 7, body: { message: 'a' } });
    expect(await service.getForUser(8, begun!.id)).toBeNull();
    expect(await service.getForUser(7, begun!.id)).toMatchObject({ userId: 7 });
  });

  it('原会话已删除时重放抛出会话不存在，且不新建执行', async () => {
    const repo = memoryRepo();
    repo.rows.set(5, {
      id: 5, source: 'API', userId: 7, agentId: 1, tokenId: 3, sessionId: 99, requestFullJson: JSON.stringify({ message: 'hi' }),
    });
    const run = vi.fn(async () => { throw new BusinessException(ErrorCode.SESSION_NOT_FOUND); });
    const service = new OpenApiCallLogService({
      repo: repo as unknown as OpenApiCallLogRepository,
      tokens: { findById: async () => ({ id: 3, revokedAt: null, expiresAt: null, autoDisabledAt: null, tokenPrefix: 'mao_abcdefghi' }), recordTokenOutcome: async () => undefined },
      openRun: { run },
    });
    await expect(service.replay(5, undefined)).rejects.toMatchObject({ code: ErrorCode.SESSION_NOT_FOUND.code });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 99, userId: 7 }));
  });
});

describe('Token 连续失败自动停用', () => {
  function repo() {
    const rows = new Map<number, ApiToken>();
    return {
      rows,
      insert: vi.fn(),
      findByHash: vi.fn(),
      listByUser: vi.fn(async () => []),
      findById: vi.fn(async (id: number) => rows.get(id) ?? null),
      countActive: vi.fn(),
      revoke: vi.fn(),
      touchLastUsed: vi.fn(),
      setLogFullBody: vi.fn(),
      clearAutoDisable: vi.fn(async (id: number, userId: number) => {
        const row = rows.get(id);
        if (row == null || row.userId !== userId) return false;
        row.autoDisabledAt = null;
        row.failureCount = 0;
        return true;
      }),
      resetFailures: vi.fn(async (id: number) => {
        const row = rows.get(id);
        if (row) row.failureCount = 0;
      }),
      bumpFailure: vi.fn(async (id: number) => {
        const row = rows.get(id);
        if (row == null || row.autoDisabledAt != null || row.revokedAt != null) return null;
        row.failureCount = Number(row.failureCount ?? 0) + 1;
        return row.failureCount;
      }),
      casAutoDisable: vi.fn(async (id: number) => {
        const row = rows.get(id);
        if (row == null || row.autoDisabledAt != null) return false;
        row.autoDisabledAt = '2026-10-09 10:00:00';
        return true;
      }),
    };
  }

  it('达到阈值停用并只通知一次；成功清零；总开关关闭不计数', async () => {
    const store = repo();
    store.rows.set(3, { id: 3, userId: 7, name: 'ci', failureCount: 0, revokedAt: null, autoDisabledAt: null });
    const notifyDisabled = vi.fn();
    let enabled = true;
    const service = new ApiTokenService(store as unknown as MysqlApiTokenRepository);
    service.setOutcomePolicy({
      enabled: async () => enabled,
      threshold: async () => 2,
      notifyDisabled,
    });
    await service.recordTokenOutcome(3, 'rejected');
    expect(notifyDisabled).not.toHaveBeenCalled();
    await service.recordTokenOutcome(3, 'failed');
    expect(store.rows.get(3)?.autoDisabledAt).toBeTruthy();
    expect(notifyDisabled).toHaveBeenCalledTimes(1);
    await service.recordTokenOutcome(3, 'failed');
    expect(notifyDisabled).toHaveBeenCalledTimes(1);
    await service.reEnable(7, 3);
    expect(store.rows.get(3)?.autoDisabledAt).toBeNull();
    await service.recordTokenOutcome(3, 'completed');
    expect(store.rows.get(3)?.failureCount).toBe(0);
    enabled = false;
    await service.recordTokenOutcome(3, 'failed');
    expect(store.bumpFailure).toHaveBeenCalledTimes(3);
  });
});

describe('流水清理', () => {
  it('单轮最多 20 批，删不满一批即停', async () => {
    const deleteBatch = vi.fn()
      .mockResolvedValueOnce(5000)
      .mockResolvedValueOnce(3);
    const cleanup = new OpenApiCallLogCleanup({ deleteBatch } as unknown as OpenApiCallLogRepository, async () => 1);
    const removed = await cleanup.cleanupOnce(Date.parse('2026-10-09T00:00:00Z'));
    expect(removed).toBe(5003);
    expect(deleteBatch).toHaveBeenCalledTimes(2);
  });
});
