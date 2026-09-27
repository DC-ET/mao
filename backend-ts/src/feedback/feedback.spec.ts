import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { FeedbackService, buildPreview, REASON_LABELS, type FeedbackMessageLookup } from './feedback.service.js';
import type { FeedbackRepository } from './feedback.repository.js';

function makeRepo(): FeedbackRepository {
  return {
    upsert: vi.fn(async () => undefined),
    deleteByMessageId: vi.fn(async () => true),
    listMessageIdsBySession: vi.fn(async () => [11, 22]),
    countTotal: vi.fn(async () => 2),
    sumByReason: vi.fn(async (_sd?: string, _ed?: string) => [
      { reason: 'WRONG_RESULT', count: 3 },
      { reason: 'OTHER', count: 1 },
    ]),
    sumByDay: vi.fn(async () => [{ date: '2026-09-27', count: 4 }]),
    listDetails: vi.fn(async () => [
      {
        id: 1,
        messageId: 11,
        sessionId: 5,
        userId: 9,
        username: 'alice',
        displayName: 'Alice',
        agentId: 2,
        agentName: 'Coder',
        reason: 'WRONG_RESULT',
        contentPreview: 'hello ${skill}$ world',
        createdAt: '2026-09-27T00:00:00.000Z',
      },
    ]),
  } as unknown as FeedbackRepository;
}

function makeLookup(ownership: Parameters<FeedbackMessageLookup['findAssistantMessageOwner']>[0] extends never ? never : Awaited<ReturnType<FeedbackMessageLookup['findAssistantMessageOwner']>>): FeedbackMessageLookup {
  return { findAssistantMessageOwner: vi.fn(async () => ownership) };
}

const OWNERSHIP = { messageId: 11, sessionId: 5, userId: 9, agentId: 2 };

describe('FeedbackService', () => {
  it('dislikeUpsertsWithOwnership', async () => {
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9);
    await service.dislike(9, 11, 'WRONG_RESULT');
    expect(repo.upsert).toHaveBeenCalledWith(11, 5, 9, 2, 'WRONG_RESULT');
  });

  it('dislikeRejectsInvalidReason', async () => {
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9);
    await expect(service.dislike(9, 11, 'NOT_A_REASON')).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('dislikeRejectsMissingMessage', async () => {
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(null), async () => 9);
    await expect(service.dislike(9, 11, 'OTHER')).rejects.toMatchObject({ code: ErrorCode.MESSAGE_NOT_FOUND.code });
  });

  it('dislikeRejectsForeignMessage', async () => {
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9);
    await expect(service.dislike(123, 11, 'OTHER')).rejects.toMatchObject({ code: ErrorCode.MESSAGE_ACCESS_DENIED.code });
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('cancelDislikeChecksOwnership', async () => {
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9);
    await service.cancelDislike(9, 11);
    expect(repo.deleteByMessageId).toHaveBeenCalledWith(11);

    const foreign = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9);
    await expect(foreign.cancelDislike(123, 11)).rejects.toMatchObject({ code: ErrorCode.MESSAGE_ACCESS_DENIED.code });
    expect(repo.deleteByMessageId).toHaveBeenCalledTimes(1);
  });

  it('listDislikedMessageIdsOnlyForSessionOwner', async () => {
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9);
    await expect(service.listDislikedMessageIds(9, 5)).resolves.toEqual([11, 22]);
    expect(repo.listMessageIdsBySession).toHaveBeenCalledTimes(1);
  });

  it('listDislikedMessageIdsRejectsForeignSession', async () => {
    // 非本人会话是权限问题：必须与「会话内没有点踩」区分开
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9);
    await expect(service.listDislikedMessageIds(123, 5)).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN.code });
    expect(repo.listMessageIdsBySession).not.toHaveBeenCalled();
  });

  it('listDislikedMessageIdsRejectsMissingSession', async () => {
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => null);
    await expect(service.listDislikedMessageIds(9, 5)).rejects.toMatchObject({ code: ErrorCode.SESSION_NOT_FOUND.code });
    expect(repo.listMessageIdsBySession).not.toHaveBeenCalled();
  });

  it('summaryFillsAllReasonsWithLabels', async () => {
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9);
    const summary = await service.getSummary('2026-09-01', '2026-09-27');
    expect(summary.total).toBe(4);
    expect(summary.byReason.map((r) => r.reason)).toEqual(['WRONG_RESULT', 'SLOW_RESPONSE', 'NOT_SOLVED', 'OTHER']);
    expect(summary.byReason.map((r) => r.label)).toEqual(Object.values(REASON_LABELS));
    expect(summary.byReason.find((r) => r.reason === 'WRONG_RESULT')?.count).toBe(3);
    expect(summary.byReason.find((r) => r.reason === 'SLOW_RESPONSE')?.count).toBe(0);
    expect(summary.byDay).toEqual([{ date: '2026-09-27', count: 4 }]);
  });

  it('summaryPassesDateFilterToRepository', async () => {
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9);
    await service.getSummary('2026-09-01', '2026-09-27');
    expect(repo.sumByReason).toHaveBeenCalledWith('2026-09-01', '2026-09-27');
    expect(repo.sumByDay).toHaveBeenCalledWith('2026-09-01', '2026-09-27');

    await service.getSummary();
    expect(repo.sumByReason).toHaveBeenLastCalledWith(undefined, undefined);
  });

  it('summaryQueriesByDayWhenOnlyOneDateBoundIsGiven', async () => {
    // 单侧日期时 byReason 有数据而 byDay 不能静默变空：两者必须同口径。
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9);
    const onlyStart = await service.getSummary('2026-09-01', undefined);
    expect(onlyStart.byDay).toEqual([{ date: '2026-09-27', count: 4 }]);
    expect(repo.sumByDay).toHaveBeenLastCalledWith('2026-09-01', undefined);

    const onlyEnd = await service.getSummary(undefined, '2026-09-27');
    expect(onlyEnd.byDay).toEqual([{ date: '2026-09-27', count: 4 }]);
    expect(repo.sumByDay).toHaveBeenLastCalledWith(undefined, '2026-09-27');
  });

  it('listDetailsRejectsInvalidReasonFilter', async () => {
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9);
    await expect(service.listDetails({ reason: 'HACK', page: 1, pageSize: 20 })).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
  });

  it('listDetailsReturnsPageWithLabelsAndPreview', async () => {
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9);
    const page = await service.listDetails({ reason: 'WRONG_RESULT', page: 2, pageSize: 10 });
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ reasonLabel: '结果错误', username: 'alice', agentName: 'Coder' });
    expect(page.items[0].contentPreview).toBe('hello skill world');
  });

  it('buildPreviewStripsMarkersAndTruncates', () => {
    expect(buildPreview('# ${skill}$ abc')).toBe('# skill abc');
    expect(buildPreview('a@{f}@b #{c}#d')).toBe('afb cd');
    const long = 'x'.repeat(300);
    const preview = buildPreview(long);
    expect(preview).toHaveLength(101);
    expect(preview.endsWith('…')).toBe(true);
  });
});
