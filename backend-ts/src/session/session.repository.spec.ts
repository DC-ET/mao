import { describe, expect, it, vi } from 'vitest';
import { FileChangeRepository, MessageRepository, SessionRepository } from './session.repository.js';

function mockDb(queryOne: unknown = null, query: unknown[] = []) {
  return {
    query: vi.fn(async () => query),
    queryOne: vi.fn(async () => queryOne),
    execute: vi.fn(async () => ({ affectedRows: 1, insertId: 9 })),
    insert: vi.fn(async () => 42),
    updateById: vi.fn(async () => undefined),
  };
}

describe('SessionRepository', () => {
  it('covers find insert update lock list page and search', async () => {
    const db = mockDb({ id: 7, title: 't' }, [{ id: 7 }]);
    const repo = new SessionRepository(db as never);
    expect(await repo.findById(7)).toEqual({ id: 7, title: 't' });
    expect(await repo.selectById(7)).toEqual({ id: 7, title: 't' });
    expect(await repo.selectByPhase('RUNNING')).toEqual([{ id: 7 }]);
    expect(await repo.listSideTasks(1)).toEqual([{ id: 7 }]);
    expect(await repo.findActiveByUserAndProjectKey(1, 'p')).toEqual({ id: 7, title: 't' });
    expect(await repo.lockActiveSessionById(7)).toBe(7);
    db.queryOne.mockResolvedValueOnce(null);
    expect(await repo.lockActiveSessionById(8)).toBeNull();

    const session = { userId: 1, title: 'n', isGit: true } as never;
    expect(await repo.insert(session)).toBe(42);
    await repo.updateById({ id: 42, userId: 1, isGit: false } as never);
    await repo.updateById({ userId: 1 } as never);
    expect(await repo.updateFields(42, {})).toBe(0);
    expect(await repo.updateFields(42, { title: 'x' })).toBe(1);
    expect(await repo.updateWhere({}, 'id=?', [1])).toBe(0);
    expect(await repo.updateWhere({ phase: 'RUNNING' }, 'id=?', [1])).toBe(1);
    expect(await repo.claimRunningIfIdle(42)).toBe(1);
    // CAS：仅当 phase 落在给定集合内才改写，且刷新 last_activity_at。
    expect(await repo.markPhaseIfIn(42, 'RESUMING', ['RUNNING', 'RESUMING'])).toBe(1);
    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining("phase IN (?, ?)"),
      expect.arrayContaining(['RESUMING', 42, 'RUNNING']),
    );
    expect(await repo.markPhaseIfIn(42, 'RESUMING', [])).toBe(0);
    expect(await repo.updateTitleIfPlaceholder(42, 'NORMAL', '未命名会话', '新标题', '2026-08-18 12:00:00')).toBe(1);
    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining("session_type = ? AND (title = ? OR title IS NULL OR TRIM(title) = '')"),
      expect.arrayContaining(['新标题', '2026-08-18 12:00:00', 42, 'NORMAL', '未命名会话']),
    );
    await repo.logicalDelete(42);
    db.queryOne.mockResolvedValueOnce({ cnt: 7 });
    expect(await repo.count('user_id=?', [1])).toBe(7);
    db.queryOne.mockResolvedValueOnce(null);
    expect(await repo.count('user_id=?', [1])).toBe(0);
    const page = await repo.selectPage(1, 20, 'user_id=?', [1], 'ORDER BY id');
    expect(page.records).toEqual([{ id: 7 }]);
    await repo.selectMessageSearchCandidates(1, 'kw');
    expect(db.query).toHaveBeenCalled();
  });

  it('insert 落列：未声明来源落 web，客户端自报值原样落库', async () => {
    const db = mockDb();
    const repo = new SessionRepository(db as never);
    await repo.insert({ userId: 1, title: 't' } as never);
    expect(db.insert).toHaveBeenCalledWith('session', expect.objectContaining({ source: 'web' }));
    await repo.insert({ userId: 1, title: 't', source: 'cli' } as never);
    expect(db.insert).toHaveBeenLastCalledWith('session', expect.objectContaining({ source: 'cli' }));
  });
});

describe('MessageRepository', () => {
  it('covers insert update list delete and search', async () => {
    const db = mockDb({ id: 3, content: 'hi' }, [{ id: 3 }]);
    const repo = new MessageRepository(db as never);
    expect(await repo.findById(3)).toEqual({ id: 3, content: 'hi' });
    const msg = { sessionId: 1, role: 'USER', content: 'hi' } as never;
    expect(await repo.insert(msg)).toBe(42);
    await repo.updateById({ id: 3, content: 'x' } as never);
    await repo.updateById({ content: 'x' } as never);
    expect(await repo.listBySession(1)).toEqual([{ id: 3 }]);
    expect(await repo.selectMessagesAfterId(1, 2)).toEqual([{ id: 3 }]);
    expect(await repo.selectValidBoundaryMessage(1, 3)).toEqual({ id: 3, content: 'hi' });
    await repo.selectThroughMessage(1, null);
    await repo.selectThroughMessage(1, 3);
    expect(db.query.mock.calls.some(([sql]: [string]) => sql.includes('id <= ?'))).toBe(true);
    db.queryOne.mockResolvedValueOnce({ mx: 9 });
    expect(await repo.selectMaxMessageId(1)).toBe(9);
    db.queryOne.mockResolvedValueOnce(null);
    expect(await repo.selectMaxMessageId(1)).toBe(0);
    // 分叉历史里的用户消息都是复制来的（source_session_id 非空），不算「更早的用户消息」
    db.queryOne.mockResolvedValueOnce(null);
    expect(await repo.hasOwnEarlierUserMessage(1, 3)).toBe(false);
    db.queryOne.mockResolvedValueOnce({ id: 2 });
    expect(await repo.hasOwnEarlierUserMessage(1, 3)).toBe(true);
    await repo.selectUserStarts(1, 10, 5);
    await repo.selectUserStarts(1, null, 5);
    await repo.selectRange(1, 1, 10);
    await repo.selectRange(1, 1, null);
    await repo.selectUserStarts(1, null, 5, 9);
    expect(String(db.query.mock.calls.at(-1)?.[0])).toContain('id <= ?');
    await repo.selectRange(1, 1, null, 9);
    expect(String(db.query.mock.calls.at(-1)?.[0])).toContain('id <= ?');
    await repo.selectUserStarts(1, null, 5, null, 99);
    expect(String(db.query.mock.calls.at(-1)?.[0])).toContain('source_session_id <> ?');
    await repo.selectRange(1, 1, null, null, 99);
    expect(String(db.query.mock.calls.at(-1)?.[0])).toContain('source_session_id <> ?');
    // 管理端 compact 投影：metadata 去掉图片 base64，且保留 VO 需要的列
    await repo.selectRange(1, 1, null, null, null, true);
    const compactSql = String(db.query.mock.calls.at(-1)?.[0]);
    expect(compactSql).toContain('JSON_REMOVE(metadata');
    expect(compactSql).toContain('thinking_content');
    expect(compactSql).not.toContain('SELECT *');
    await repo.logicalDeleteById(3);
    await repo.deleteById(3);
    await repo.logicalDeleteBySession(1);
    await repo.logicalDeleteAfter(1, 2);
    await repo.selectLast(1);
    await repo.deleteFromId(1, 2);
    expect(await repo.selectMessagesForSearch([], 'k')).toEqual([]);
    await repo.selectMessagesForSearch([1, 2], 'k');
    expect(await repo.selectFirstMatchingMessages([], 'k')).toEqual([]);
    await repo.selectFirstMatchingMessages([1, 2], 'k');
    await repo.selectHitMessages([1], 'LIKE', '登录', '2026-10-01 00:00:00', '2026-10-02 00:00:00');
    const hitSql = String(db.query.mock.calls.at(-1)?.[0]);
    expect(hitSql).toContain('created_at >=');
    expect(hitSql).toContain('created_at <');
    expect(db.query.mock.calls.at(-1)?.[1]).toEqual([1, '登录', '2026-10-01 00:00:00', '2026-10-02 00:00:00']);
  });

  it('selectFirstMatchingMessages limits roles unless scope is ALL', async () => {
    const db = mockDb(null, []);
    const repo = new MessageRepository(db as never);
    await repo.selectFirstMatchingMessages([1], 'k');
    const defaultSql = String(db.query.mock.calls.at(-1)?.[0]);
    expect(defaultSql).toContain("m.role IN ('USER', 'ASSISTANT')");
    // 片段口径必须跟召回一致，否则 ALL 模式下片段会取自工具输出
    await repo.selectFirstMatchingMessages([1], 'k', 'ALL');
    const allSql = String(db.query.mock.calls.at(-1)?.[0]);
    expect(allSql).not.toContain('m.role IN');
  });

  it('selectFirstMatchingMessages applies the message created_at window', async () => {
    const db = mockDb(null, []);
    const repo = new MessageRepository(db as never);
    await repo.selectFirstMatchingMessages([3, 4], 'k', 'CONVERSATION', '2026-10-31 00:00:00', '2026-11-07 00:00:00');
    const [sql, params] = db.query.mock.calls.at(-1) as [string, unknown[]];
    expect(sql).toContain('m.created_at >= ?');
    expect(sql).toContain('m.created_at < ?');
    // 窗口参数在占位符顺序上位于会话 id 之前
    expect(params).toEqual(['2026-10-31 00:00:00', '2026-11-07 00:00:00', 3, 4, 'k']);
    // 单边窗口只拼一侧
    await repo.selectFirstMatchingMessages([3], 'k', 'CONVERSATION', null, '2026-11-07 00:00:00');
    const oneSided = db.query.mock.calls.at(-1) as [string, unknown[]];
    expect(String(oneSided[0])).not.toContain('m.created_at >=');
    expect(oneSided[1]).toEqual(['2026-11-07 00:00:00', 3, 'k']);
  });

  it('selectFirstUserStamp takes the earliest non-deleted USER stamp', async () => {
    const db = mockDb({ id: 5, createdAt: '2026-10-12 23:50:11' }, [{ id: 5 }]);
    const repo = new MessageRepository(db as never);
    expect(await repo.selectFirstUserStamp(3)).toEqual({ id: 5, createdAt: '2026-10-12 23:50:11' });
    const [sql, params] = db.queryOne.mock.calls.at(-1) as [string, unknown[]];
    expect(sql).toContain("role = 'USER'");
    expect(sql).toContain('deleted = 0');
    expect(sql).toContain('created_at AS createdAt');
    expect(sql).toContain('ORDER BY id ASC');
    expect(sql).toContain('LIMIT 1');
    expect(params).toEqual([3]);

    db.queryOne.mockResolvedValueOnce(null);
    expect(await repo.selectFirstUserStamp(3)).toBeNull();
  });

  it('selectPreviousUserStamp takes the latest USER stamp strictly before the id', async () => {
    const db = mockDb({ id: 9, createdAt: '2026-10-13 08:00:02' }, [{ id: 9 }]);
    const repo = new MessageRepository(db as never);
    expect(await repo.selectPreviousUserStamp(3, 12)).toEqual({ id: 9, createdAt: '2026-10-13 08:00:02' });
    const [sql, params] = db.queryOne.mock.calls.at(-1) as [string, unknown[]];
    expect(sql).toContain("role = 'USER'");
    expect(sql).toContain('deleted = 0');
    expect(sql).toContain('id < ?');
    expect(sql).toContain('created_at AS createdAt');
    expect(sql).toContain('ORDER BY id DESC');
    expect(sql).toContain('LIMIT 1');
    expect(params).toEqual([3, 12]);
  });

  // 记录详情下钻（技术方案 2026-10-22-run-trace-deep-dive §5.3）：按 tool_call_id 反查。
  // tool_calls 是 MySQL JSON 列，取出来是 `"id": "call_x"`（带空格），用 JSON_CONTAINS 精确匹配。
  it('selectAssistantByToolCallId matches the declaring assistant message via JSON_CONTAINS', async () => {
    const db = mockDb({ id: 5, toolCalls: '[]' }, []);
    const repo = new MessageRepository(db as never);
    expect(await repo.selectAssistantByToolCallId(3, 'call_1')).toEqual({ id: 5, toolCalls: '[]' });
    const [sql, params] = db.queryOne.mock.calls.at(-1) as [string, unknown[]];
    expect(sql).toContain("role = 'ASSISTANT'");
    expect(sql).toContain('deleted = 0');
    expect(sql).toContain('JSON_CONTAINS(tool_calls, JSON_OBJECT(\'id\', ?))');
    expect(sql).toContain('ORDER BY id ASC');
    expect(params).toEqual([3, 'call_1']);

    // JSON_CONTAINS 不解释 LIKE 通配符：% / _ / \ 原样传参，不会误配
    await repo.selectAssistantByToolCallId(3, 'call_%_\\1');
    expect(db.queryOne.mock.calls.at(-1)?.[1]).toEqual([3, 'call_%_\\1']);
  });

  it('selectAssistantByToolCallId / selectToolMessageByCallId 对空 id 不发查询', async () => {
    const db = mockDb(null, []);
    const repo = new MessageRepository(db as never);
    expect(await repo.selectAssistantByToolCallId(3, '')).toBeNull();
    expect(await repo.selectToolMessageByCallId(3, '')).toBeNull();
    expect(db.queryOne).not.toHaveBeenCalled();
  });

  it('selectToolMessageByCallId takes the TOOL row by exact tool_call_id', async () => {
    const db = mockDb({ id: 8, role: 'TOOL', toolCallId: 'call_1' }, []);
    const repo = new MessageRepository(db as never);
    expect(await repo.selectToolMessageByCallId(3, 'call_1')).toEqual({ id: 8, role: 'TOOL', toolCallId: 'call_1' });
    const [sql, params] = db.queryOne.mock.calls.at(-1) as [string, unknown[]];
    expect(sql).toContain("role = 'TOOL'");
    expect(sql).toContain('tool_call_id = ?');
    expect(sql).toContain('deleted = 0');
    expect(params).toEqual([3, 'call_1']);
  });

  // compact 补洞回归：页外补抓的 TOOL 行常带截图附件，走 SELECT * 会把 base64
  // data_uri 带回管理端响应，抵消 compact 列表的体积优化（13.7MB → 0.6MB）。
  it('selectToolMessagesByCallIds compactMedia 走紧凑列，默认仍全列', async () => {
    const db = mockDb(null, []);
    const repo = new MessageRepository(db as never);
    expect(await repo.selectToolMessagesByCallIds(3, ['call_1'])).toEqual([]);
    const [defaultSql, defaultParams] = db.query.mock.calls.at(-1) as [string, unknown[]];
    expect(defaultSql).toContain('SELECT *');
    expect(defaultSql).toContain("role = 'TOOL'");
    expect(defaultSql).toContain('tool_call_id IN (?)');
    expect(defaultParams).toEqual([3, 'call_1']);

    await repo.selectToolMessagesByCallIds(3, ['call_1'], null, null, true);
    const [compactSql, compactParams] = db.query.mock.calls.at(-1) as [string, unknown[]];
    expect(compactSql).toContain('JSON_REMOVE(metadata');
    expect(compactSql).toContain('thinking_content');
    expect(compactSql).not.toContain('SELECT *');
    expect(compactParams).toEqual([3, 'call_1']);

    // 水位/来源过滤参数顺序不受 compact 影响
    await repo.selectToolMessagesByCallIds(3, ['call_1', 'call_2'], 99, 7, true);
    expect(db.query.mock.calls.at(-1)?.[1]).toEqual([3, 'call_1', 'call_2', 99, 7]);
  });
});

describe('FileChangeRepository', () => {
  it('covers insert list and update', async () => {
    const db = mockDb({ id: 1, path: 'a.ts' }, [{ id: 1 }]);
    const repo = new FileChangeRepository(db as never);
    expect(await repo.insert({ sessionId: 1, messageId: 2, path: 'a.ts', type: 'CREATED' } as never)).toBe(42);
    expect(await repo.selectByMessageAndPath(2, 'a.ts')).toEqual({ id: 1, path: 'a.ts' });
    await repo.updateById(1, { linesAdded: 2 });
    expect(await repo.listBySession(1)).toEqual([{ id: 1 }]);
    expect(await repo.listByMessageIds(1, [])).toEqual([]);
    await repo.listByMessageIds(1, [2, 3]);
    expect(await repo.listSummaryByMessageIds(1, [])).toEqual([]);
    await repo.listSummaryByMessageIds(1, [2, 3]);
    await repo.listSummaryBySession(1);
    const summarySql = String(db.query.mock.calls.at(-1)?.[0]);
    expect(summarySql).toContain('deleted = 0');
    expect(summarySql).toMatch(/JOIN\s+`message`/i);
    expect(summarySql).toContain('file_path');
    expect(summarySql).not.toContain('before_content');
    expect(summarySql).not.toContain('after_content');
    expect(summarySql).not.toContain('patch_content');
    await repo.listSummaryBySession(1, 99);
    expect(String(db.query.mock.calls.at(-1)?.[0])).toContain('m.source_session_id <> ?');
  });
});

describe('SessionRepository failed-session recovery queries', () => {
  it('listFailedSessionsForRecovery 按窗口/ids 组装 SQL，不按 402/403 收窄，且空 ids 短路不查库', async () => {
    const db = mockDb(null, [{ sessionId: 431, llmErrorMessage: 'tool failed' }]);
    const repo = new SessionRepository(db as never);
    const rows = await repo.listFailedSessionsForRecovery({ windowStart: '2026-11-06 00:00:00' });
    expect(rows).toEqual([{ sessionId: 431, llmErrorMessage: 'tool failed' }]);
    const [sql, params] = db.query.mock.calls[0];
    const text = String(sql);
    expect(text).toContain("s.phase = 'FAILED'");
    expect(text).toContain("s.session_type = 'NORMAL'");
    expect(text).toContain("l2.scene = 'agent'");
    expect(text).toContain('LEFT JOIN llm_call');
    expect(text).toContain('s.runtime_status_json AS runtimeStatusJson');
    expect(text).not.toContain('LLM API returned 402');
    expect(text).not.toContain('l.success = 0');
    expect(text).toContain('s.last_activity_at >= ?');
    expect(params).toEqual(['2026-11-06 00:00:00']);

    await repo.listFailedSessionsForRecovery({ ids: [431, 473] });
    const [idsSql, idsParams] = db.query.mock.calls[1];
    expect(String(idsSql)).toContain('s.id IN (?,?)');
    expect(String(idsSql)).not.toContain('s.last_activity_at >= ?');
    expect(idsParams).toEqual([431, 473]);

    const emptyDb = mockDb(null, []);
    const emptyRepo = new SessionRepository(emptyDb as never);
    expect(await emptyRepo.listFailedSessionsForRecovery({ ids: [] })).toEqual([]);
    expect(emptyDb.query).not.toHaveBeenCalled();
  });

  it('listSessionIdsWithPendingTaskRetry 返回 next_retry_at 非空的会话集合', async () => {
    const db = mockDb(null, [{ sessionId: 431 }, { sessionId: 473 }, { sessionId: 'bad' }]);
    const repo = new SessionRepository(db as never);
    const ids = await repo.listSessionIdsWithPendingTaskRetry([431, 473, 431]);
    expect(ids).toEqual(new Set([431, 473]));
    const [sql, params] = db.query.mock.calls[0];
    expect(String(sql)).toContain('scheduled_task_run');
    expect(String(sql)).toContain('next_retry_at IS NOT NULL');
    expect(params).toEqual([431, 473]);
    expect(await new SessionRepository(mockDb() as never).listSessionIdsWithPendingTaskRetry([])).toEqual(new Set());
  });

  it('listScheduledTaskRefsBySessionIds 按会话归组任务引用', async () => {
    const db = mockDb(null, [
      { id: 77, name: '每日库存播报', sessionId: 431 },
      { id: 80, name: '周报汇总', sessionId: 431 },
      { id: 81, name: '其他任务', sessionId: 473 },
    ]);
    const repo = new SessionRepository(db as never);
    const refs = await repo.listScheduledTaskRefsBySessionIds([431, 473]);
    expect(refs.get(431)).toEqual([{ id: 77, name: '每日库存播报' }, { id: 80, name: '周报汇总' }]);
    expect(refs.get(473)).toEqual([{ id: 81, name: '其他任务' }]);
    const [sql, params] = db.query.mock.calls[0];
    expect(String(sql)).toContain('FROM scheduled_task');
    expect(String(sql)).toContain('deleted = 0');
    expect(params).toEqual([431, 473]);
  });
});
