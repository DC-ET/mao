import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { whereFilter, type SqlRow } from '../testing/sql-where.js';
import { SessionService, buildSnippet } from './session.service.js';
import { CLOUD_TEMP } from './util/session-group-key.js';
import type { FileChangeRepository, MessageRepository, SessionRepository } from './session.repository.js';
import type { AgentLookup, Message, Session, UserCommandLookup } from './types.js';
import type { PathSandbox } from '../harness/safety/path-sandbox.js';
import type { EnvironmentInfoProvider } from '../harness/core/environment-info.js';
import type { GitOperationService } from './git-operation.service.js';
import type { SessionCompactionService } from './session-compaction.service.js';
import type { SessionCompactionEventService } from './session-compaction-event.service.js';

function session(id: number, title: string, sessionType: string, agentId: number | null, updatedAt: string): Session {
  return { id, userId: 7, title, sessionType, agentId, updatedAt, phase: 'COMPLETED' };
}

function message(id: number, sessionId: number, content: string | null): Message {
  return { id, sessionId, role: 'USER', content };
}

function makeService() {
  const txDb = {
    insert: vi.fn(async (table: string, data: Record<string, unknown>) => {
      if (table === 'session') return 99;
      if (table === 'message') {
        data.id = ++txMessageId;
        return data.id;
      }
      return 299;
    }),
    queryOne: vi.fn(async (sql: string) => {
      if (sql.includes('FROM `session`')) {
        return vi.mocked(sessionRepo.findById).getMockImplementation()?.(20) ?? null;
      }
      return null;
    }),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM `message`')) {
        return [
          { id: 1, sessionId: 20, role: 'USER', content: '检查一下' },
          { id: 2, sessionId: 20, role: 'ASSISTANT', content: '完成' },
        ];
      }
      if (sql.includes('FROM `session`')) return vi.mocked(sessionRepo.list).getMockImplementation()?.(sql, [], '') ?? [];
      if (sql.includes('message_file_change')) return [];
      if (sql.includes('session_todo')) return [];
      return [];
    }),
    execute: vi.fn(async () => ({ affectedRows: 1 })),
  };
  let txMessageId = 199;
  const sessionRepo = {
    findById: vi.fn(),
    updateById: vi.fn(),
    updateWhere: vi.fn(),
    updateFields: vi.fn(async () => 1),
    pageSessionsByFilter: vi.fn(),
    count: vi.fn(async () => 0),
    selectMessageSearchCandidates: vi.fn(),
    selectMatchingSessions: vi.fn(async () => []),
    countMatchingSessions: vi.fn(async () => 0),
    selectByIds: vi.fn(async () => []),
    selectPage: vi.fn(async () => ({ records: [], total: 0 })),
    list: vi.fn(),
    listDescendantSideTasks: vi.fn(async () => []),
    listDescendantSideTasksByRoots: vi.fn(async () => new Map<number, Session[]>()),
    insert: vi.fn(async (s: Session) => { s.id = 99; return 99; }),
    lockActiveSessionById: vi.fn(),
    logicalDelete: vi.fn(),
    transaction: vi.fn(async (fn: (db: unknown) => Promise<unknown>) => {
      txMessageId = 199;
      return fn(txDb);
    }),
  } as unknown as SessionRepository;
  const messageRepo = {
    selectMessagesForSearch: vi.fn(),
    selectHitMessages: vi.fn(async () => []),
    selectRoundStartForMessage: vi.fn(async () => null),
    selectNextUserMessageId: vi.fn(async () => null),
    hasMessageBefore: vi.fn(async () => false),
    selectUserStarts: vi.fn(async () => []),
    selectRange: vi.fn(async () => []),
    selectFirstMatchingMessages: vi.fn(async () => []),
    listBySession: vi.fn(async () => []),
    insert: vi.fn(async (m: Message) => { m.id = 199; return 199; }),
    logicalDeleteBySession: vi.fn(),
    findById: vi.fn(),
    logicalDeleteAfter: vi.fn(),
    updateById: vi.fn(),
    selectLastUserMessage: vi.fn(),
    selectValidBoundaryMessage: vi.fn(),
  } as unknown as MessageRepository;
  const agentLookup = {
    findByIds: vi.fn().mockResolvedValue([]),
  } as unknown as AgentLookup;
  const fileChangeRepo = {
    listBySession: vi.fn(async () => []),
    insert: vi.fn(),
  } as unknown as FileChangeRepository;
  const sessionCompactionService = { deleteBySessionId: vi.fn() } as unknown as SessionCompactionService;
  const sessionCompactionEventService = { deleteBySessionId: vi.fn() } as unknown as SessionCompactionEventService;
  const service = new SessionService(
    sessionRepo,
    messageRepo,
    fileChangeRepo,
    agentLookup,
    {} as PathSandbox,
    {} as EnvironmentInfoProvider,
    {} as UserCommandLookup,
    {} as GitOperationService,
    sessionCompactionService,
    sessionCompactionEventService,
  );
  return { service, sessionRepo, messageRepo, fileChangeRepo, agentLookup, txDb };
}

describe('SessionService archive', () => {
  it('unarchiveSessionSetsStatusActive', async () => {
    const { service, sessionRepo } = makeService();
    const s: Session = { id: 10, userId: 7, status: 'ARCHIVED' };
    vi.mocked(sessionRepo.findById).mockResolvedValue(s);
    await service.unarchiveSession(10);
    expect(sessionRepo.updateFields).toHaveBeenCalledWith(10, { status: 'ACTIVE' });
    expect(sessionRepo.updateById).not.toHaveBeenCalled();
  });

  it('unarchiveSessionThrowsWhenNotFound', async () => {
    const { service, sessionRepo } = makeService();
    vi.mocked(sessionRepo.findById).mockResolvedValue(null);
    await expect(service.unarchiveSession(99)).rejects.toBeInstanceOf(BusinessException);
  });

  it('restoreRunningAfterApprovalIssuesConditionalUpdateAndReturnsTrue', async () => {
    const { service, sessionRepo } = makeService();
    vi.mocked(sessionRepo.updateWhere).mockResolvedValue(1);
    expect(await service.restoreRunningAfterApproval(10)).toBe(true);
  });

  it('restoreRunningAfterApprovalReturnsFalseWhenConditionalUpdateMisses', async () => {
    const { service, sessionRepo } = makeService();
    vi.mocked(sessionRepo.updateWhere).mockResolvedValue(0);
    expect(await service.restoreRunningAfterApproval(10)).toBe(false);
  });

  it('listDescendantSideTaskSessionsDelegatesToRepoWithUserId', async () => {
    const { service, sessionRepo } = makeService();
    const side: Session = { id: 20, userId: 7, parentSessionId: 10, sessionType: 'SIDE_TASK' };
    vi.mocked(sessionRepo.listDescendantSideTasks).mockResolvedValue([side]);
    const sides = await service.listDescendantSideTaskSessions(10, 7);
    expect(sides).toHaveLength(1);
    expect(sides[0].parentSessionId).toBe(10);
    expect(sessionRepo.listDescendantSideTasks).toHaveBeenCalledWith(10, 7);
  });

  it('listDescendantSideTaskSessionsByRootsReturnsPerRootGroups', async () => {
    const { service, sessionRepo } = makeService();
    const side: Session = { id: 20, userId: 7, parentSessionId: 10, sessionType: 'SIDE_TASK' };
    vi.mocked(sessionRepo.listDescendantSideTasksByRoots).mockResolvedValue(new Map([[10, [side]]]));
    const result = await service.listDescendantSideTaskSessionsByRoots([10, 11]);
    expect(result.get(10)).toHaveLength(1);
    expect(result.has(11)).toBe(false);
    expect(sessionRepo.listDescendantSideTasksByRoots).toHaveBeenCalledWith([10, 11]);
  });

  it('promotesSideTaskToNormalSessionAndCopiesMessages', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    vi.mocked(sessionRepo.findById).mockResolvedValue({
      id: 20,
      userId: 7,
      title: '边路检查',
      sessionType: 'SIDE_TASK',
      phase: 'COMPLETED',
      agentId: 9,
      executionMode: 'CLOUD',
      workspace: '/tmp/w',
      permissionLevel: 'READ_WRITE',
      modelId: 3,
      projectKey: 'demo',
    });
    vi.mocked(sessionRepo.list).mockResolvedValue([]);

    const promoted = await service.promoteSideTaskToMainSession(20, 7);

    expect(promoted.id).toBe(99);
    expect(promoted.sessionType).toBe('NORMAL');
    expect(promoted.parentSessionId).toBeNull();
    expect(promoted.projectKey).toBe('demo');
    expect(sessionRepo.transaction).toHaveBeenCalled();
  });

  it('derivesProjectKeyWhenPromotingLegacySideTaskWithoutProjectKey', async () => {
    const { service, sessionRepo } = makeService();
    vi.mocked(sessionRepo.findById).mockResolvedValue({
      id: 20,
      userId: 7,
      title: '旧边路任务',
      sessionType: 'SIDE_TASK',
      phase: 'COMPLETED',
      executionMode: 'CLOUD',
      workspace: '/opt/mao-data/workspace/7/projects/mao',
      projectKey: null,
    });
    vi.mocked(sessionRepo.list).mockResolvedValue([]);

    const promoted = await service.promoteSideTaskToMainSession(20, 7);

    expect(promoted.projectKey).toBe('mao');
  });

  it('rejectsRunningSideTaskPromotion', async () => {
    const { service, sessionRepo } = makeService();
    vi.mocked(sessionRepo.findById).mockResolvedValue({ id: 20, userId: 7, sessionType: 'SIDE_TASK', phase: 'RUNNING' });
    await expect(service.promoteSideTaskToMainSession(20, 7)).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
  });

  it('rejectsSideTaskPromotionWhenChildSessionExists', async () => {
    const { service, sessionRepo } = makeService();
    vi.mocked(sessionRepo.findById).mockResolvedValue({ id: 20, userId: 7, sessionType: 'SIDE_TASK', phase: 'COMPLETED' });
    vi.mocked(sessionRepo.list).mockResolvedValue([{ id: 30, userId: 7, parentSessionId: 20, sessionType: 'SUBAGENT' }]);
    await expect(service.promoteSideTaskToMainSession(20, 7)).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    expect(sessionRepo.insert).not.toHaveBeenCalled();
  });

  it('allowsSideTaskPromotionWhenOnlySideTaskChildrenExist', async () => {
    const { service, sessionRepo, txDb } = makeService();
    vi.mocked(sessionRepo.findById).mockResolvedValue({
      id: 20,
      userId: 7,
      title: '深层边路',
      sessionType: 'SIDE_TASK',
      phase: 'COMPLETED',
      executionMode: 'CLOUD',
      workspace: '/tmp/w',
    });
    // 仅 SIDE_TASK 子会话：提升放行，子树 parent 不变、自然跟随新主会话。
    // txDb.query 会把真实 SQL 透传给 list mock：SUBAGENT 校验查空、其余查询返回边路子会话
    vi.mocked(sessionRepo.list).mockImplementation(((sql: string) => (
      sql.includes("session_type = 'SUBAGENT'") ? [] : [{ id: 30, userId: 7, parentSessionId: 20, sessionType: 'SIDE_TASK' }]
    )) as never);
    const promoted = await service.promoteSideTaskToMainSession(20, 7);
    expect(promoted.sessionType).toBe('NORMAL');
    expect(promoted.parentSessionId).toBeNull();
    // 子树跟随：直接子会话必须重挂到新主会话 id（99），否则整棵子树在新旧两棵树上都不可达
    expect(txDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('parent_session_id = ?'),
      [99, 20],
    );
  });

  it('promotesSideTaskAndDeletesItsWorkspaceRulesSnapshot', async () => {
    // 边路会话提升不走 onSessionDeleted，工作区规则快照须在同一事务内回收（技术方案 §4.6 评审补充）
    const { service, sessionRepo, txDb } = makeService();
    vi.mocked(sessionRepo.findById).mockResolvedValue({
      id: 20,
      userId: 7,
      title: '边路任务',
      sessionType: 'SIDE_TASK',
      phase: 'COMPLETED',
      executionMode: 'CLOUD',
      workspace: '/tmp/w',
    });
    vi.mocked(sessionRepo.list).mockResolvedValue([]);

    const promoted = await service.promoteSideTaskToMainSession(20, 7);

    expect(promoted.id).toBe(99);
    expect(txDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM session_workspace_rules WHERE session_id = ?'),
      [20],
    );
  });

  it('rejectsDeleteWhenSessionRunning', async () => {
    const { service, sessionRepo } = makeService();
    vi.mocked(sessionRepo.findById).mockResolvedValue({ id: 11, userId: 7, phase: 'RUNNING' });
    await expect(service.deleteSession(11)).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    expect(sessionRepo.logicalDelete).not.toHaveBeenCalled();
  });

  it('rejectsEditMessageFromOtherSession', async () => {
    const { service, messageRepo } = makeService();
    vi.mocked(messageRepo.findById).mockResolvedValue({ id: 3, sessionId: 99, role: 'USER', content: 'old' });
    await expect(service.editMessageAndTruncate(11, 3, 'new', null)).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN.code });
  });

  it('rejectsEditWhenNotLastUserMessage', async () => {
    const { service, messageRepo } = makeService();
    vi.mocked(messageRepo.findById).mockResolvedValue({ id: 3, sessionId: 11, role: 'USER', content: 'old' });
    vi.mocked(messageRepo.selectLastUserMessage).mockResolvedValue({ id: 9, sessionId: 11, role: 'USER', content: 'later' });
    await expect(service.editMessageAndTruncate(11, 3, 'new', null)).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    expect(messageRepo.logicalDeleteAfter).not.toHaveBeenCalled();
  });
});

describe('SessionService message search', () => {
  function hit(messageId: number, sessionId: number, content: string | null, role = 'USER') {
    return { messageId, sessionId, role, content, createdAt: '2026-08-07 10:00:00', score: 1 };
  }

  function prime(
    sessionRepo: { selectMatchingSessions: ReturnType<typeof vi.fn>; countMatchingSessions: ReturnType<typeof vi.fn>; selectByIds: ReturnType<typeof vi.fn> },
    messageRepo: { selectHitMessages: ReturnType<typeof vi.fn> },
    sessions: ReturnType<typeof session>[],
    hits: ReturnType<typeof hit>[],
    total = sessions.length,
  ) {
    vi.mocked(sessionRepo.selectMatchingSessions).mockResolvedValue(
      sessions.map((s) => ({ sessionId: s.id!, hitCount: Math.max(1, hits.filter((h) => h.sessionId === s.id).length), maxScore: 1 })),
    );
    vi.mocked(sessionRepo.countMatchingSessions).mockResolvedValue(total);
    vi.mocked(sessionRepo.selectByIds).mockImplementation(async (ids: number[]) => {
      const byId = new Map(sessions.filter((s) => s.id != null).map((s) => [s.id!, s]));
      return ids.map((id) => byId.get(id)).filter((s): s is ReturnType<typeof session> => s != null).reverse();
    });
    vi.mocked(messageRepo.selectHitMessages).mockResolvedValue(hits);
  }

  it('returnsHitSessionWithSnippetAndAgentName', async () => {
    const { service, sessionRepo, messageRepo, agentLookup } = makeService();
    const s = session(1, '修复登录 Bug', 'NORMAL', 9, '2026-08-07 10:30:00');
    prime(sessionRepo, messageRepo, [s], [hit(100, 1, '帮我看看登录页面为什么报 500 错误')]);
    vi.mocked(agentLookup.findByIds).mockResolvedValue([{ id: 9, name: '默认 Agent' }]);
    const result = await service.searchMessages(7, '登录');
    expect(result.path).toBe('FULLTEXT');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].sessionId).toBe(1);
    expect(result.items[0].title).toBe('修复登录 Bug');
    expect(result.items[0].agentName).toBe('默认 Agent');
    expect(result.items[0].hits[0].snippet).toContain('登录');
    expect(result.items[0].hits[0].messageId).toBe(100);
    expect(result.items[0].updatedAt).toBe('2026-08-07T10:30');
    expect(sessionRepo.selectMatchingSessions).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'FULLTEXT',
      userId: 7,
      match: '"登录"',
    }));
  });

  it('messageSearchSnippetsStripCitationMarkers', async () => {
    const { service, sessionRepo, messageRepo, agentLookup } = makeService();
    const s = session(1, '申报答疑', 'NORMAL', 9, '2026-08-07 10:30:00');
    prime(sessionRepo, messageRepo, [s], [hit(100, 1, '截止时间是 11 月 30 日[^1^]，详见通知')]);
    vi.mocked(agentLookup.findByIds).mockResolvedValue([{ id: 9, name: '默认 Agent' }]);
    const result = await service.searchMessages(7, '截止时间');
    expect(result.items[0].hits[0].snippet).toContain('截止时间是 11 月 30 日');
    expect(result.items[0].hits[0].snippet).not.toContain('[^1^]');
  });

  it('messageSearchKeepsHitWhenKeywordIsCitationMarkerItself', async () => {
    // 关键词本身是 `[^n^]` 字面量时，剥标文本里找不到词，片段要回退用未剥标正文建；
    // 否则整条命中连同会话被丢掉，而 total 仍按 SQL 计数，桌面显示「找到 1 个相关会话」却列不出东西。
    const { service, sessionRepo, messageRepo, agentLookup } = makeService();
    const s = session(1, '申报答疑', 'NORMAL', 9, '2026-08-07 10:30:00');
    prime(sessionRepo, messageRepo, [s], [hit(100, 1, '截止时间是 11 月 30 日[^1^]，详见通知')]);
    vi.mocked(agentLookup.findByIds).mockResolvedValue([{ id: 9, name: '默认 Agent' }]);
    const result = await service.searchMessages(7, '[^1^]');
    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].hits).toHaveLength(1);
    expect(result.items[0].hits[0].snippet).toContain('[^1^]');
  });

  it('quotesMultiWordAndOperators', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    prime(sessionRepo, messageRepo, [], []);
    await service.searchMessages(7, '部署脚本 回滚');
    expect(sessionRepo.selectMatchingSessions).toHaveBeenCalledWith(expect.objectContaining({ match: '"部署脚本" "回滚"' }));
    await service.searchMessages(7, '+部署 -测试');
    expect(sessionRepo.selectMatchingSessions).toHaveBeenLastCalledWith(expect.objectContaining({ match: '+"部署" -"测试"' }));
    await service.searchMessages(7, '数据库');
    expect(sessionRepo.selectMatchingSessions).toHaveBeenLastCalledWith(expect.objectContaining({ match: '"数据库"' }));
  });

  it('usesLikeForShortKeywordAndKeepsFilters', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    prime(sessionRepo, messageRepo, [], []);
    await service.searchMessages(7, '登', {
      agentId: 9,
      dateFrom: '2026-10-01',
      dateTo: '2026-10-09',
      sessionType: 'NORMAL',
      page: 2,
      size: 10,
    });
    expect(sessionRepo.selectMatchingSessions).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'LIKE',
      userId: 7,
      match: '登',
      agentId: 9,
      createdFrom: '2026-10-01 00:00:00',
      createdToExclusive: '2026-10-10 00:00:00',
      sessionType: 'NORMAL',
      limit: 10,
      offset: 10,
    }));
  });

  it('passesDateWindowIntoDisplayedHits', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    const s = session(1, '当天', 'NORMAL', null, '2026-10-01 10:00:00');
    prime(sessionRepo, messageRepo, [s], [hit(8, 1, '登录问题')]);
    await service.searchMessages(7, '登录', { dateFrom: '2026-10-01', dateTo: '2026-10-01' });
    expect(messageRepo.selectHitMessages).toHaveBeenCalledWith(
      [1],
      'FULLTEXT',
      '"登录"',
      '2026-10-01 00:00:00',
      '2026-10-02 00:00:00',
    );
  });

  it('degradesFulltextErrorsToLikeWithSameFilters', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    vi.mocked(sessionRepo.selectMatchingSessions)
      .mockRejectedValueOnce(new Error('FTS query exceeds result cache limit'))
      .mockResolvedValueOnce([]);
    vi.mocked(sessionRepo.countMatchingSessions).mockResolvedValue(0);
    const result = await service.searchMessages(7, '登录', { agentId: 3 });
    expect(result.path).toBe('LIKE');
    expect(sessionRepo.selectMatchingSessions).toHaveBeenLastCalledWith(expect.objectContaining({
      mode: 'LIKE',
      match: '登录',
      agentId: 3,
    }));
    expect(messageRepo.selectHitMessages).not.toHaveBeenCalled();
  });

  it('returnsEmptyWhenNoCandidates', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    prime(sessionRepo, messageRepo, [], []);
    const result = await service.searchMessages(7, '不存在');
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('throwsWhenKeywordBlank', async () => {
    const { service } = makeService();
    await expect(service.searchMessages(7, '   ')).rejects.toMatchObject({ code: ErrorCode.PARAM_MISSING.code });
  });

  it('throwsWhenKeywordTooLong', async () => {
    const { service } = makeService();
    await expect(service.searchMessages(7, 'a'.repeat(101))).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
  });

  it('escapesLikeWildcardsOnShortKeyword', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    prime(sessionRepo, messageRepo, [], []);
    await service.searchMessages(7, '%');
    expect(sessionRepo.selectMatchingSessions).toHaveBeenCalledWith(expect.objectContaining({ mode: 'LIKE', match: '\\%' }));
  });

  it('passesParentExistsAndRoleThroughFilterObject', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    prime(sessionRepo, messageRepo, [], []);
    await service.searchMessages(7, 'OK');
    const filter = vi.mocked(sessionRepo.selectMatchingSessions).mock.calls[0][0];
    expect(filter.mode).toBe('FULLTEXT');
    expect(filter.userId).toBe(7);
    expect(filter.match).toBe('"OK"');
  });

  it('keepsStage1OrderWhenSessionReloadIsReversed', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    const newer = session(10, '较新', 'NORMAL', null, '2026-08-07 12:00:00');
    const older = session(11, '较旧', 'NORMAL', null, '2026-08-01 09:00:00');
    prime(sessionRepo, messageRepo, [newer, older], [
      hit(1, 10, '新的登录问题'),
      hit(2, 11, '旧的登录问题'),
    ]);
    const result = await service.searchMessages(7, '登录');
    expect(result.items.map((item) => item.sessionId)).toEqual([10, 11]);
  });

  it('resolvesRootSessionIdForSideTaskCandidates', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    const deep = session(30, '深层任务', 'SIDE_TASK', null, '2026-08-07 10:30:00');
    deep.parentSessionId = 20;
    prime(sessionRepo, messageRepo, [deep], [hit(300, 30, '深层任务的关键词')]);
    vi.mocked(sessionRepo.list).mockResolvedValue([
      { id: 20, userId: 7, parentSessionId: 10, sessionType: 'SIDE_TASK' },
      { id: 10, userId: 7, parentSessionId: null, sessionType: 'NORMAL' },
    ]);
    const result = await service.searchMessages(7, '关键词');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].sessionId).toBe(30);
    expect(result.items[0].rootSessionId).toBe(10);
  });

  it('dropsOrphanSideTaskCandidatesWithoutReachableRoot', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    const orphan = session(30, '孤儿任务', 'SIDE_TASK', null, '2026-08-07 10:30:00');
    orphan.parentSessionId = 20;
    prime(sessionRepo, messageRepo, [orphan], [hit(300, 30, '孤儿任务的关键词')]);
    vi.mocked(sessionRepo.list).mockResolvedValue([]);
    const result = await service.searchMessages(7, '关键词');
    expect(result.items).toHaveLength(0);
  });

  it('setsRootSessionIdToSelfForNormalCandidates', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    const main = session(1, '主会话', 'NORMAL', 9, '2026-08-07 10:30:00');
    prime(sessionRepo, messageRepo, [main], [hit(100, 1, '主会话关键词')]);
    const result = await service.searchMessages(7, '关键词');
    expect(result.items[0].rootSessionId).toBe(1);
  });

  it('snippetContainsKeywordWhenKeywordInMiddle', () => {
    const text = `${'a'.repeat(100)}登录页面${'b'.repeat(100)}`;
    const snippet = buildSnippet(text, '登录页面');
    expect(snippet).toContain('登录页面');
    expect(snippet!.startsWith('…')).toBe(true);
    expect(snippet!.endsWith('…')).toBe(true);
    expect(snippet!.length).toBeLessThanOrEqual(200);
  });

  it('rejectsMultimodalFalseHit', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    const jsonContent = '[{"type":"text","text":"帮我看看这个图片"},{"type":"image_url","url":"http://x/login.png"}]';
    prime(sessionRepo, messageRepo, [session(2, '图片会话', 'NORMAL', null, '2026-08-07 10:00:00')], [hit(200, 2, jsonContent)]);
    const result = await service.searchMessages(7, 'image_url');
    expect(result.items).toEqual([]);
  });

  it('acceptsMultimodalTextPart', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    const jsonContent = '[{"type":"text","text":"登录页面报错了"},{"type":"image_url","url":"http://x/a.png"}]';
    prime(sessionRepo, messageRepo, [session(3, '带图会话', 'NORMAL', null, '2026-08-07 10:00:00')], [hit(300, 3, jsonContent)]);
    const result = await service.searchMessages(7, '登录');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].hits[0].snippet).toContain('登录页面报错了');
    expect(result.items[0].hits[0].snippet).not.toContain('image_url');
  });

  it('dropsFalseHitAndKeepsVisibleCount', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    prime(sessionRepo, messageRepo, [session(14, '先图后文', 'NORMAL', null, '2026-08-07 10:00:00')], [
      hit(1, 14, '[{"type":"image_url","url":"http://x/登录.png"}]'),
      hit(2, 14, '后续提到了登录页面'),
    ]);
    vi.mocked(sessionRepo.selectMatchingSessions).mockResolvedValue([{ sessionId: 14, hitCount: 3, maxScore: 1 }]);
    const result = await service.searchMessages(7, '登录');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].hits).toHaveLength(1);
    expect(result.items[0].hitCount).toBe(1);
    expect(result.items[0].hits[0].snippet).toContain('登录');
  });

  it('keepsSqlHitCountWhenEverySampleHasSnippet', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    const s = session(6, '多条命中', 'NORMAL', null, '2026-08-07 10:00:00');
    prime(sessionRepo, messageRepo, [s], [
      hit(1, 6, '开头 abc登录'),
      hit(2, 6, 'xyz登录123'),
    ]);
    vi.mocked(sessionRepo.selectMatchingSessions).mockResolvedValue([{ sessionId: 6, hitCount: 8, maxScore: 2 }]);
    const result = await service.searchMessages(7, '登录');
    expect(result.items[0].hitCount).toBe(8);
    expect(result.items[0].hits[0].snippet).toContain('开头');
    expect(result.items[0].hits).toHaveLength(2);
  });

  it('plainJsonArrayMessageMatchesAsText', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    prime(sessionRepo, messageRepo, [session(13, '数组文本', 'NORMAL', null, '2026-08-07 10:00:00')], [hit(1, 13, '["登录","500"]')]);
    const result = await service.searchMessages(7, '登录');
    expect(result.items[0].hits[0].snippet).toContain('登录');
  });

  it('emptyGroupingSurvivesNullContentMessages', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    prime(sessionRepo, messageRepo, [session(12, '空内容', 'NORMAL', null, '2026-08-07 10:00:00')], [hit(1, 12, null)]);
    const result = await service.searchMessages(7, '关键词');
    expect(result.items).toEqual([]);
  });

  it('aroundAssistantHitUsesNextUserAsUpperBound', async () => {
    const { service, messageRepo } = makeService();
    vi.mocked(messageRepo.findById).mockImplementation(async (id: number) => {
      if (id === 100) return { id: 100, sessionId: 11, role: 'ASSISTANT', content: '修复方案' };
      if (id === 110) return { id: 110, sessionId: 11, role: 'USER', content: '下一轮' };
      return null;
    });
    vi.mocked(messageRepo.selectRoundStartForMessage).mockResolvedValue(90);
    vi.mocked(messageRepo.selectNextUserMessageId).mockResolvedValue(110);
    vi.mocked(messageRepo.selectUserStarts).mockResolvedValue([{ id: 90, sessionId: 11, role: 'USER' }]);
    vi.mocked(messageRepo.selectRange).mockResolvedValue([
      { id: 90, sessionId: 11, role: 'USER', content: '问题' },
      { id: 100, sessionId: 11, role: 'ASSISTANT', content: '修复方案' },
    ]);
    const page = await service.getMessagesByRounds(11, 5, null, { aroundMessageId: 100 });
    expect(messageRepo.selectUserStarts).toHaveBeenCalledWith(11, 110, 6);
    expect(page.messages.map((m) => m.id)).toEqual([90, 100]);
    expect(page.hasNewer).toBe(true);
  });

  it('aroundLastRoundHasNoNewer', async () => {
    const { service, messageRepo } = makeService();
    vi.mocked(messageRepo.findById).mockResolvedValue({ id: 100, sessionId: 11, role: 'ASSISTANT', content: '末尾' });
    vi.mocked(messageRepo.selectRoundStartForMessage).mockResolvedValue(90);
    vi.mocked(messageRepo.selectNextUserMessageId).mockResolvedValue(null);
    vi.mocked(messageRepo.selectUserStarts).mockResolvedValue([{ id: 90, sessionId: 11, role: 'USER' }]);
    vi.mocked(messageRepo.selectRange).mockResolvedValue([
      { id: 90, sessionId: 11, role: 'USER', content: '问' },
      { id: 100, sessionId: 11, role: 'ASSISTANT', content: '末尾' },
    ]);
    const page = await service.getMessagesByRounds(11, 5, null, { aroundMessageId: 100 });
    expect(messageRepo.selectUserStarts).toHaveBeenCalledWith(11, null, 6);
    expect(page.hasNewer).toBe(false);
    expect(page.messages.some((m) => m.id === 100)).toBe(true);
  });

  it('aroundRejectsMessageFromAnotherSession', async () => {
    const { service, messageRepo } = makeService();
    vi.mocked(messageRepo.findById).mockResolvedValue({ id: 100, sessionId: 99, role: 'ASSISTANT', content: 'x' });
    await expect(service.getMessagesByRounds(11, 5, null, { aroundMessageId: 100 })).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    expect(messageRepo.selectUserStarts).not.toHaveBeenCalled();
  });

  it('withoutAroundDoesNotReportHasNewer', async () => {
    const { service, messageRepo } = makeService();
    vi.mocked(messageRepo.selectUserStarts).mockResolvedValue([{ id: 5, sessionId: 11, role: 'USER' }]);
    vi.mocked(messageRepo.selectRange).mockResolvedValue([{ id: 5, sessionId: 11, role: 'USER', content: 'x' }]);
    const page = await service.getMessagesByRounds(11, 5, null);
    expect(page.hasNewer).toBeUndefined();
    expect(messageRepo.selectRoundStartForMessage).not.toHaveBeenCalled();
  });
});

describe('SessionService embed source', () => {
  it('marks legacy resident session web -> embed once', async () => {
    const { service, sessionRepo } = makeService();
    vi.mocked(sessionRepo.findById)
      .mockResolvedValueOnce({ ...session(20, '常驻', 'NORMAL', 9, '2026-08-07 10:00:00'), source: 'web' })
      .mockResolvedValueOnce({ ...session(20, '常驻', 'NORMAL', 9, '2026-08-07 10:00:00'), source: 'embed' });
    const updated = await service.markSessionSource(20, 7, 'embed');
    expect(updated.source).toBe('embed');
    expect(sessionRepo.updateFields).toHaveBeenCalledWith(20, { source: 'embed' });
  });

  it('is idempotent when session is already embed', async () => {
    const { service, sessionRepo } = makeService();
    vi.mocked(sessionRepo.findById)
      .mockResolvedValue({ ...session(20, '常驻', 'NORMAL', 9, '2026-08-07 10:00:00'), source: 'embed' });
    const updated = await service.markSessionSource(20, 7, 'embed');
    expect(updated.source).toBe('embed');
    expect(sessionRepo.updateFields).not.toHaveBeenCalled();
  });

  it('rejects non-embed target and foreign owner', async () => {
    const { service, sessionRepo } = makeService();
    vi.mocked(sessionRepo.findById)
      .mockResolvedValue({ ...session(20, '常驻', 'NORMAL', 9, '2026-08-07 10:00:00'), source: 'web' });
    await expect(service.markSessionSource(20, 7, 'web' as 'embed')).rejects.toThrow();
    expect(sessionRepo.updateFields).not.toHaveBeenCalled();
    await expect(service.markSessionSource(20, 8, 'embed')).rejects.toThrow();
    expect(sessionRepo.updateFields).not.toHaveBeenCalled();
  });

  it('lists sessions by filter with clamped pagination', async () => {
    const { service, sessionRepo } = makeService();
    const page = {
      items: [{ ...session(20, '常驻', 'NORMAL', 9, '2026-08-07 10:00:00'), source: 'embed' }],
      total: 1, offset: 0, limit: 20, hasMore: false,
    };
    vi.mocked(sessionRepo.pageSessionsByFilter).mockResolvedValue(page);
    const result = await service.listSessionsByFilter(7, 9, 'embed', 0, 999);
    expect(sessionRepo.pageSessionsByFilter).toHaveBeenCalledWith(
      { userId: 7, agentId: 9, source: 'embed' }, 0, 50,
    );
    expect(result.items[0].source).toBe('embed');
  });

  it('admin list matches message content and returns match snippets', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    vi.mocked(sessionRepo.selectPage).mockResolvedValue({
      records: [session(31, '排障会话', 'NORMAL', 9, '2026-08-07 10:00:00')],
      total: 1,
    });
    vi.mocked(messageRepo.selectFirstMatchingMessages).mockResolvedValue([
      { sessionId: 31, content: '用户反馈登录页面一直报 500 错误' },
    ]);

    const result = await service.listSessionsForAdmin(1, 10, null, null, null, null, '登录页面', null);
    const call = vi.mocked(sessionRepo.selectPage).mock.calls[0];
    expect(String(call[2])).toContain('title LIKE');
    expect(String(call[2])).toContain('MATCH(m.content) AGAINST (? IN BOOLEAN MODE)');
    expect(call[3]).toEqual(['%登录页面%', '%登录页面%', '"登录页面"', 'ACTIVE']);
    expect(result.matchSnippets[31]).toContain('登录页面');
    expect(result.matchSnippets[31]).toContain('500');
  });

  it('admin list match snippets strip citation markers', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    vi.mocked(sessionRepo.selectPage).mockResolvedValue({
      records: [session(31, '排障会话', 'NORMAL', 9, '2026-08-07 10:00:00')],
      total: 1,
    });
    vi.mocked(messageRepo.selectFirstMatchingMessages).mockResolvedValue([
      { sessionId: 31, content: '截止时间是 11 月 30 日[^1^]，详见通知' },
    ]);

    const result = await service.listSessionsForAdmin(1, 10, null, null, null, null, '截止时间', null);
    expect(result.matchSnippets[31]).toContain('截止时间是 11 月 30 日');
    expect(result.matchSnippets[31]).not.toContain('[^1^]');
  });

  it('admin list match snippet falls back when keyword is citation marker itself', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    vi.mocked(sessionRepo.selectPage).mockResolvedValue({
      records: [session(31, '排障会话', 'NORMAL', 9, '2026-08-07 10:00:00')],
      total: 1,
    });
    vi.mocked(messageRepo.selectFirstMatchingMessages).mockResolvedValue([
      { sessionId: 31, content: '截止时间是 11 月 30 日[^1^]，详见通知' },
    ]);

    const result = await service.listSessionsForAdmin(1, 10, null, null, null, null, '[^1^]', null);
    expect(result.matchSnippets[31]).toContain('[^1^]');
  });

  it('admin list without keyword skips message snippet load', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    vi.mocked(sessionRepo.selectPage).mockResolvedValue({
      records: [session(31, '排障会话', 'NORMAL', 9, '2026-08-07 10:00:00')],
      total: 1,
    });
    const result = await service.listSessionsForAdmin(1, 10, null, null, null, null, '  ', null);
    expect(result.matchSnippets).toEqual({});
    expect(messageRepo.selectFirstMatchingMessages).not.toHaveBeenCalled();
  });

  it('admin list keyword hits messages through fulltext index', async () => {
    const { service, sessionRepo } = makeService();
    vi.mocked(sessionRepo.selectPage).mockResolvedValue({
      records: [session(31, '排障会话', 'NORMAL', 9, '2026-08-07 10:00:00')],
      total: 1,
    });
    await service.listSessionsForAdmin(1, 10, null, null, null, null, '登录页面', null);
    const call = vi.mocked(sessionRepo.selectPage).mock.calls[0];
    expect(String(call[2])).toContain('MATCH(m.content) AGAINST (? IN BOOLEAN MODE)');
    expect(String(call[2])).not.toContain('m.content LIKE');
    // 布尔短语串作为独立参数下发，不拼进 SQL
    expect(call[3]).toEqual(['%登录页面%', '%登录页面%', '"登录页面"', 'ACTIVE']);
  });

  it('admin list single-char keyword stays on LIKE scan', async () => {
    const { service, sessionRepo } = makeService();
    vi.mocked(sessionRepo.selectPage).mockResolvedValue({ records: [], total: 0 });
    await service.listSessionsForAdmin(1, 10, null, null, null, null, '的', null);
    const call = vi.mocked(sessionRepo.selectPage).mock.calls[0];
    // ngram(token_size=2) 索引不到单字，走 LIKE 才不漏召
    expect(String(call[2])).toContain('m.content LIKE');
    expect(String(call[2])).not.toContain('AGAINST');
    // 降级路径同样只认对话双方，避免单字搜索被工具输出刷屏
    expect(String(call[2])).toContain("m.role IN ('USER', 'ASSISTANT')");
    expect(call[3]).toEqual(['%的%', '%的%', '%的%', 'ACTIVE']);
  });

  it('admin list keyword falls back to LIKE when fulltext disabled', async () => {
    const { service, sessionRepo } = makeService();
    vi.mocked(sessionRepo.selectPage).mockResolvedValue({ records: [], total: 0 });
    const previous = process.env.SEARCH_FULLTEXT_ENABLED;
    process.env.SEARCH_FULLTEXT_ENABLED = 'false';
    try {
      await service.listSessionsForAdmin(1, 10, null, null, null, null, '登录页面', null);
    } finally {
      if (previous == null) delete process.env.SEARCH_FULLTEXT_ENABLED;
      else process.env.SEARCH_FULLTEXT_ENABLED = previous;
    }
    const call = vi.mocked(sessionRepo.selectPage).mock.calls[0];
    expect(String(call[2])).toContain('m.content LIKE');
    expect(String(call[2])).not.toContain('AGAINST');
  });

  it('admin list escapes like wildcards in title and summary match', async () => {
    const { service, sessionRepo } = makeService();
    vi.mocked(sessionRepo.selectPage).mockResolvedValue({ records: [], total: 0 });
    await service.listSessionsForAdmin(1, 10, null, null, null, null, '100%', null);
    const call = vi.mocked(sessionRepo.selectPage).mock.calls[0];
    expect(call[3]).toEqual(['%100\\%%', '%100\\%%', '"100%"', 'ACTIVE']);
  });

  it('admin list defaults to conversation-only message match', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    vi.mocked(sessionRepo.selectPage).mockResolvedValue({
      records: [session(31, '排障会话', 'NORMAL', 9, '2026-08-07 10:00:00')],
      total: 1,
    });
    await service.listSessionsForAdmin(1, 10, null, null, null, null, 'P单', null);
    const call = vi.mocked(sessionRepo.selectPage).mock.calls[0];
    expect(String(call[2])).toContain("m.role IN ('USER', 'ASSISTANT')");
    // 片段查询与召回同口径，否则会出现「命中片段取自工具输出」
    expect(messageRepo.selectFirstMatchingMessages).toHaveBeenCalledWith([31], 'P单', 'CONVERSATION');
  });

  it('admin list message scope ALL keeps tool output searchable', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    vi.mocked(sessionRepo.selectPage).mockResolvedValue({
      records: [session(31, '排障会话', 'NORMAL', 9, '2026-08-07 10:00:00')],
      total: 1,
    });
    await service.listSessionsForAdmin(1, 10, null, null, null, null, 'P单', null, 'all');
    const call = vi.mocked(sessionRepo.selectPage).mock.calls[0];
    expect(String(call[2])).not.toContain('m.role IN');
    expect(String(call[2])).toContain('MATCH(m.content) AGAINST');
    expect(messageRepo.selectFirstMatchingMessages).toHaveBeenCalledWith([31], 'P单', 'ALL');
  });

  it('admin list rejects unknown message scope', async () => {
    const { service, sessionRepo } = makeService();
    await expect(
      service.listSessionsForAdmin(1, 10, null, null, null, null, 'P单', null, 'TOOL'),
    ).rejects.toThrow('搜索范围不合法');
    expect(sessionRepo.selectPage).not.toHaveBeenCalled();
  });
});

describe('SessionService session group filtering', () => {
  /**
   * 回归：round 1 BUG-4。分组预览按 SessionGroupKey.of() 分组，「展开更多」按
   * applyFilter() 过滤，两端口径漂移时同一会话会在预览里出现一次、展开后却多出
   * 一条（total 对不上、分页偏移错乱）。这里用 testing/sql-where.ts 的求值器
   * 代替 MySQL，驱动真实 SessionService 的两个列表接口互相对照。
   *
   * 行同时带 SQL 列名（WHERE 求值用）与 camelCase 字段（of() 读取用）。
   */
  function groupRow(over: Record<string, unknown>): Session {
    const base: Record<string, unknown> = {
      id: 1,
      user_id: 7, userId: 7,
      title: '会话',
      session_type: 'NORMAL', sessionType: 'NORMAL',
      status: 'ACTIVE',
      phase: 'IDLE',
      agent_id: 9, agentId: 9,
      execution_mode: 'CLOUD', executionMode: 'CLOUD',
      workspace: '/data/workspace/projects/proj',
      project_key: null, projectKey: null,
      source: null,
      updated_at: '2026-10-13 10:00:00', updatedAt: '2026-10-13 10:00:00',
    };
    const merged = { ...base, ...over };
    // 两套命名保持同值，避免 spec 自身因命名不一致误判
    merged.userId = merged.user_id;
    merged.sessionType = merged.session_type;
    merged.agentId = merged.agent_id;
    merged.executionMode = merged.execution_mode;
    merged.projectKey = merged.project_key;
    return merged as unknown as Session;
  }

  function mockGroupRepo(rows: Session[]) {
    const { service, sessionRepo } = makeService();
    const sqlRows = rows as unknown as SqlRow[];
    vi.mocked(sessionRepo.list).mockImplementation(
      async (whereSql: string, params: unknown[]) => whereFilter(whereSql, params, sqlRows) as unknown as Session[],
    );
    vi.mocked(sessionRepo.count).mockImplementation(
      async (whereSql: string, params: unknown[]) => whereFilter(whereSql, params, sqlRows).length,
    );
    return { service };
  }

  it('嵌入 SDK 会话只出现在 EMBED 分组，不挤进同工作区的 CLOUD 分组', async () => {
    const normal = groupRow({ id: 1, title: '普通会话' });
    const embedded = groupRow({ id: 2, title: '嵌入会话', source: 'embed' });
    const { service } = mockGroupRepo([normal, embedded]);

    // 1) 分组预览：EMBED 与 CLOUD:<ws> 各一条，互不重叠
    const groups = await service.listSessionGroups(7, null, null, 5);
    const byKey = new Map(groups.map((g) => [g.key, g]));
    expect([...byKey.keys()].sort()).toEqual(['CLOUD:/data/workspace/projects/proj', 'EMBED:9']);
    expect(byKey.get('CLOUD:/data/workspace/projects/proj')!.total).toBe(1);
    expect(byKey.get('EMBED:9')!.total).toBe(1);

    // 2) 展开 CLOUD 分组：只能拿到普通会话，不能把嵌入会话也带出来
    const cloudPage = await service.listSessionsByGroup(7, 'CLOUD:/data/workspace/projects/proj', null, null, 0, 20);
    expect(cloudPage.total).toBe(1);
    expect(cloudPage.items.map((s) => s.id)).toEqual([1]);

    // 3) 展开 EMBED 分组：只能拿到嵌入会话
    const embedPage = await service.listSessionsByGroup(7, 'EMBED:9', null, null, 0, 20);
    expect(embedPage.total).toBe(1);
    expect(embedPage.items.map((s) => s.id)).toEqual([2]);
  });

  it('临时工作区桶不含 embed 会话（含 workspace 为 NULL 的 embed 行）', async () => {
    // embed 会话的 workspace 可能是 NULL（早期创建）或 {root}/{userId}/{sessionId}
    // （create-app.ts 的自动工作区）；of() 一律分流到 EMBED:<agentId>，
    // CLOUD:临时工作区 桶必须把两类 embed 都排除在外
    const temp = groupRow({ id: 1, title: '临时会话', workspace: null });
    const embeddedNull = groupRow({ id: 2, title: '嵌入会话(无工作区)', source: 'embed', workspace: null });
    const embeddedAuto = groupRow({ id: 3, title: '嵌入会话(自动工作区)', source: 'embed', workspace: '/data/workspace/9/42' });
    const { service } = mockGroupRepo([temp, embeddedNull, embeddedAuto]);

    const groups = await service.listSessionGroups(7, null, null, 5);
    const byKey = new Map(groups.map((g) => [g.key, g]));
    expect([...byKey.keys()].sort()).toEqual([CLOUD_TEMP, 'EMBED:9']);
    expect(byKey.get(CLOUD_TEMP)!.total).toBe(1);

    const page = await service.listSessionsByGroup(7, CLOUD_TEMP, null, null, 0, 20);
    expect(page.items.map((s) => s.id)).toEqual([1]);
  });

  it('飞书私聊会话只出现在 FEISHU_PRIVATE 分组', async () => {
    // 形态与生产一致：飞书私聊 workspace 在 {root}/feishu-chat/{账号}/private-{userId} 下
    const feishuPrivate = groupRow({
      id: 3, title: '飞书私聊',
      project_key: 'feishu-1-private-5', projectKey: 'feishu-1-private-5',
      workspace: '/data/workspace/feishu-chat/1/private-5',
    });
    const { service } = mockGroupRepo([feishuPrivate]);

    const groups = await service.listSessionGroups(7, null, null, 5);
    expect(groups.map((g) => g.key)).toEqual(['FEISHU_PRIVATE:9']);

    const page = await service.listSessionsByGroup(7, 'FEISHU_PRIVATE:9', null, null, 0, 20);
    expect(page.items.map((s) => s.id)).toEqual([3]);
  });
});

describe('SessionService fork cut point', () => {
  it('findOwnedMessage returns the message only when it belongs to the session', async () => {
    const { service, messageRepo } = makeService();
    vi.mocked(messageRepo.selectValidBoundaryMessage).mockResolvedValue(message(77, 20, 'reply'));
    expect(await service.findOwnedMessage(20, 77)).toEqual(message(77, 20, 'reply'));
    expect(messageRepo.selectValidBoundaryMessage).toHaveBeenCalledWith(20, 77);

    vi.mocked(messageRepo.selectValidBoundaryMessage).mockResolvedValue(null);
    expect(await service.findOwnedMessage(20, 78)).toBeNull();
  });
});
