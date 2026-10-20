import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { FeedbackDbLookup, FeedbackService, buildContentPreview, buildPreview, REASON_LABELS, type FeedbackMessageLookup } from './feedback.service.js';
import type { FeedbackRepository } from './feedback.repository.js';

const DETAIL_ROW = {
  id: 1,
  messageId: 11,
  sessionId: 5,
  userId: 9,
  username: 'alice',
  displayName: 'Alice',
  agentId: 2,
  agentName: 'Coder',
  reason: 'WRONG_RESULT',
  source: 'desktop',
  status: 'PENDING',
  handledBy: null,
  handledByName: null,
  handledAt: null,
  experienceId: null,
  sameGroupCount: 3,
  messageExists: true,
  content: 'hello ${skill}$ world',
  toolSummary: null,
  toolCallCount: 0,
  createdAt: '2026-09-27T00:00:00.000Z',
} as const;

function makeRepo(): FeedbackRepository {
  return {
    upsert: vi.fn(async () => undefined),
    deleteByMessageId: vi.fn(async () => true),
    existsByMessageId: vi.fn(async () => false),
    listMessageIdsBySession: vi.fn(async () => [11, 22]),
    countTotal: vi.fn(async () => 2),
    sumByReason: vi.fn(async (_sd?: string, _ed?: string) => [
      { reason: 'WRONG_RESULT', count: 3 },
      { reason: 'OTHER', count: 1 },
    ]),
    sumByDay: vi.fn(async () => [{ date: '2026-09-27', count: 4 }]),
    countPending: vi.fn(async () => 5),
    countPendingGroupBy: vi.fn(async () => [
      { agentId: 2, agentName: 'Coder', reason: 'WRONG_RESULT', count: 3 },
      { agentId: 2, agentName: 'Coder', reason: 'NO_REASON', count: 1 },
      { agentId: null, agentName: null, reason: 'OTHER', count: 1 },
    ]),
    markDismissed: vi.fn(async () => 1),
    listDetails: vi.fn(async (): Promise<unknown[]> => [DETAIL_ROW]),
  } as unknown as FeedbackRepository;
}

function makeLookup(ownership: Parameters<FeedbackMessageLookup['findAssistantMessageOwner']>[0] extends never ? never : Awaited<ReturnType<FeedbackMessageLookup['findAssistantMessageOwner']>>): FeedbackMessageLookup {
  return {
    findAssistantMessageOwner: vi.fn(async () => ownership),
    findLatestAssistantMessageId: vi.fn(async () => 11),
  };
}

const OWNERSHIP = { messageId: 11, sessionId: 5, userId: 9, agentId: 2 };

describe('FeedbackService', () => {
  it('dislikeUpsertsWithOwnership', async () => {
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9);
    await service.dislike(9, 11, 'WRONG_RESULT');
    expect(repo.upsert).toHaveBeenCalledWith(11, 5, 9, 2, 'WRONG_RESULT', 'desktop');
  });

  it('dislikePassesSourceThrough', async () => {
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9);
    await service.dislike(9, 11, 'NO_REASON', 'feishu');
    expect(repo.upsert).toHaveBeenCalledWith(11, 5, 9, 2, 'NO_REASON', 'feishu');
  });

  it('dislikeAcceptsFeishuNoReason', async () => {
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9);
    await expect(service.dislike(9, 11, 'NO_REASON')).resolves.toBeUndefined();
    expect(repo.upsert).toHaveBeenCalledTimes(1);
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
    expect(summary.byReason.map((r) => r.reason)).toEqual(['WRONG_RESULT', 'SLOW_RESPONSE', 'NOT_SOLVED', 'OTHER', 'NO_REASON']);
    expect(summary.byReason.map((r) => r.label)).toEqual(Object.values(REASON_LABELS));
    expect(summary.byReason.find((r) => r.reason === 'WRONG_RESULT')?.count).toBe(3);
    expect(summary.byReason.find((r) => r.reason === 'SLOW_RESPONSE')?.count).toBe(0);
    expect(summary.byReason.find((r) => r.reason === 'NO_REASON')?.label).toBe('未选择原因（飞书）');
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
    expect(page.items[0]).toMatchObject({ reasonLabel: '结果错误', username: 'alice', agentName: 'Coder', source: 'desktop' });
    expect(page.items[0].contentPreview).toBe('hello skill world');
  });

  it('listDetailsAcceptsNoReasonFilter', async () => {
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9);
    await expect(service.listDetails({ reason: 'NO_REASON', page: 1, pageSize: 20 })).resolves.toMatchObject({ total: 2 });
  });
});

describe('FeedbackService.toggleSessionDislike', () => {
  it('inserts feishu dislike when no record exists', async () => {
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9, async () => 2);
    await expect(service.toggleSessionDislike(9, 5, 'feishu')).resolves.toEqual({ disliked: true });
    expect(repo.existsByMessageId).toHaveBeenCalledWith(11);
    expect(repo.upsert).toHaveBeenCalledWith(11, 5, 9, 2, 'NO_REASON', 'feishu');
    expect(repo.deleteByMessageId).not.toHaveBeenCalled();
  });

  it('deletes the record when it already exists', async () => {
    const repo = makeRepo();
    (repo.existsByMessageId as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9, async () => 2);
    await expect(service.toggleSessionDislike(9, 5, 'feishu')).resolves.toEqual({ disliked: false });
    expect(repo.deleteByMessageId).toHaveBeenCalledWith(11);
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('判定不区分来源：同一条消息已有桌面记录时，飞书 toggle 走删除分支', async () => {
    // uk_message(message_id) 唯一键下同一条消息只有一行：桌面点踩过的消息在飞书再点一次即取消，
    // 不会出现两行，也不会把桌面记录"升级"成飞书记录。
    const repo = makeRepo();
    (repo.existsByMessageId as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9, async () => 2);
    await expect(service.toggleSessionDislike(9, 5, 'feishu')).resolves.toEqual({ disliked: false });
    expect(repo.deleteByMessageId).toHaveBeenCalledWith(11);
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('returns null when the session is gone', async () => {
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => null);
    await expect(service.toggleSessionDislike(9, 5, 'feishu')).resolves.toBeNull();
    expect(repo.upsert).not.toHaveBeenCalled();
    expect(repo.deleteByMessageId).not.toHaveBeenCalled();
  });

  it('returns null when no assistant message remains', async () => {
    const repo = makeRepo();
    const lookup = makeLookup(OWNERSHIP);
    (lookup.findLatestAssistantMessageId as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const service = new FeedbackService(repo, lookup, async () => 9);
    await expect(service.toggleSessionDislike(9, 5, 'feishu')).resolves.toBeNull();
    expect(repo.upsert).not.toHaveBeenCalled();
    expect(repo.deleteByMessageId).not.toHaveBeenCalled();
  });

  it('writes null agent id when the session agent cannot be resolved', async () => {
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9, async () => null);
    await service.toggleSessionDislike(9, 5, 'feishu');
    expect(repo.upsert).toHaveBeenCalledWith(11, 5, 9, null, 'NO_REASON', 'feishu');
  });

  it('toggles back to not-disliked on the second call (DB as source of truth)', async () => {
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9, async () => 2);
    await service.toggleSessionDislike(9, 5, 'feishu');
    (repo.existsByMessageId as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    await expect(service.toggleSessionDislike(9, 5, 'feishu')).resolves.toEqual({ disliked: false });
  });
});

describe('buildPreview', () => {
  it('buildPreviewStripsMarkersAndTruncates', () => {
    expect(buildPreview('# ${skill}$ abc')).toBe('# skill abc');
    expect(buildPreview('a@{f}@b #{c}#d')).toBe('afb cd');
    const long = 'x'.repeat(300);
    const preview = buildPreview(long);
    expect(preview).toHaveLength(101);
    expect(preview.endsWith('…')).toBe(true);
  });
});

describe('buildContentPreview', () => {
  it('优先正文，其次工具调用摘要', () => {
    expect(buildContentPreview(true, '正文', '执行 shell', 2)).toBe('正文');
    expect(buildContentPreview(true, '', '执行 shell', 2)).toBe('[工具调用] 执行 shell 等 2 项工具调用');
    expect(buildContentPreview(true, null, '执行 shell', 1)).toBe('[工具调用] 执行 shell');
  });

  it('消息不存在或无任何内容时返回 null', () => {
    // messageExists=false 优先于一切：消息被清理时不展示残留摘要
    expect(buildContentPreview(false, '正文', '执行 shell', 2)).toBeNull();
    expect(buildContentPreview(true, '   ', null, 0)).toBeNull();
    expect(buildContentPreview(true, null, '  ', 1)).toBeNull();
  });
});

describe('FeedbackDbLookup', () => {
  it('findLatestAssistantMessageId 跳过 content 为空的工具调用中间消息', async () => {
    const captured: string[] = [];
    const db = {
      queryOne: vi.fn(async (sql: string) => {
        captured.push(sql);
        return { id: 7 };
      }),
    };
    const lookup = new FeedbackDbLookup(db as never);
    await expect(lookup.findLatestAssistantMessageId(5)).resolves.toBe(7);
    expect(captured[0]).toContain("role = 'ASSISTANT'");
    expect(captured[0]).toContain("content IS NOT NULL AND TRIM(content) <> ''");
  });
});

describe('FeedbackService 待处理视角', () => {
  it('getSummary 附带 pendingCount 与 pendingMatrix，矩阵原因带中文标签', async () => {
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9);
    const summary = await service.getSummary();
    expect(summary.pendingCount).toBe(5);
    expect(summary.pendingMatrix).toEqual([
      { agentId: 2, agentName: 'Coder', reason: 'WRONG_RESULT', reasonLabel: '结果错误', count: 3 },
      { agentId: 2, agentName: 'Coder', reason: 'NO_REASON', reasonLabel: '未选择原因（飞书）', count: 1 },
      { agentId: null, agentName: null, reason: 'OTHER', reasonLabel: '其他', count: 1 },
    ]);
    // 待处理口径不带日期筛选：与明细 status=PENDING 的筛选结果一致
    expect(repo.countPending).toHaveBeenCalledTimes(1);
  });

  it('listDetails 透传 status / agentId 筛选并校验取值', async () => {
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9);
    await service.listDetails({ status: 'PENDING', agentId: 2, page: 1, pageSize: 20 });
    expect(repo.countTotal).toHaveBeenCalledWith(expect.objectContaining({ status: 'PENDING', agentId: 2 }));
    expect(repo.listDetails).toHaveBeenCalledWith(expect.objectContaining({ status: 'PENDING', agentId: 2, offset: 0, limit: 20 }));
    // agentId 允许为 null（筛选「无 Agent」的飞书点踩）
    await service.listDetails({ agentId: null, page: 1, pageSize: 20 });
    expect(repo.listDetails).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: null }));
    await expect(service.listDetails({ status: 'HACK', page: 1, pageSize: 20 }))
      .rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
  });

  it('listDetails 行带状态、处理人、经验 id 与同类聚集数', async () => {
    const repo = makeRepo();
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9);
    const page = await service.listDetails({ status: 'PENDING', page: 1, pageSize: 20 });
    expect(page.items[0]).toMatchObject({
      status: 'PENDING',
      handledBy: null,
      handledByName: null,
      experienceId: null,
      sameGroupCount: 3,
      messageExists: true,
    });
  });

  it('listDetails 正文为空时回退工具调用摘要', async () => {
    // 工具调用中间消息 content 为空：预览取首个 summary，并标出工具调用总数
    const repo = makeRepo();
    (repo.listDetails as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...DETAIL_ROW, content: '', toolSummary: '执行 cd vtn-mall && echo "..." (20 行输出)', toolCallCount: 3 },
    ]);
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9);
    const page = await service.listDetails({ page: 1, pageSize: 20 });
    expect(page.items[0].contentPreview).toBe('[工具调用] 执行 cd vtn-mall && echo "..." (20 行输出) 等 3 项工具调用');
  });

  it('listDetails 消息已删除时 contentPreview 为 null', async () => {
    const repo = makeRepo();
    (repo.listDetails as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...DETAIL_ROW, messageExists: false, content: null, toolSummary: null, toolCallCount: 0 },
    ]);
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9);
    const page = await service.listDetails({ page: 1, pageSize: 20 });
    expect(page.items[0]).toMatchObject({ messageExists: false, contentPreview: null });
  });

  it('listDetails 消息存在但无正文也无工具调用时 contentPreview 为 null', async () => {
    const repo = makeRepo();
    (repo.listDetails as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...DETAIL_ROW, content: '   ', toolSummary: null, toolCallCount: 0 },
    ]);
    const service = new FeedbackService(repo, makeLookup(OWNERSHIP), async () => 9);
    const page = await service.listDetails({ page: 1, pageSize: 20 });
    expect(page.items[0]).toMatchObject({ messageExists: true, contentPreview: null });
  });
});
