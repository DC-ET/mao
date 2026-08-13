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
    db.queryOne.mockResolvedValueOnce({ mx: 9 });
    expect(await repo.selectMaxMessageId(1)).toBe(9);
    db.queryOne.mockResolvedValueOnce(null);
    expect(await repo.selectMaxMessageId(1)).toBe(0);
    await repo.selectUserStarts(1, 10, 5);
    await repo.selectUserStarts(1, null, 5);
    await repo.selectRange(1, 1, 10);
    await repo.selectRange(1, 1, null);
    await repo.logicalDeleteById(3);
    await repo.deleteById(3);
    await repo.logicalDeleteBySession(1);
    await repo.logicalDeleteAfter(1, 2);
    await repo.selectLast(1);
    await repo.deleteFromId(1, 2);
    expect(await repo.selectMessagesForSearch([], 'k')).toEqual([]);
    await repo.selectMessagesForSearch([1, 2], 'k');
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
  });
});
