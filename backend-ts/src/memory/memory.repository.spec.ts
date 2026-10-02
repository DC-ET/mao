import { describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from './memory.repository.js';

function mockDb(queryOne: unknown = null, query: unknown[] = [], executeResult: { affectedRows: number; insertId: number } = { affectedRows: 1, insertId: 1 }) {
  return {
    queryOne: vi.fn(async () => queryOne),
    query: vi.fn(async () => query),
    execute: vi.fn(async () => executeResult),
    insert: vi.fn(async () => 42),
  };
}

describe('MemoryRepository', () => {
  it('pageFiltersByUserIdAndOptionalFieldsWithDescOrder', async () => {
    const db = mockDb(null, [{ id: 1 }]);
    const repo = new MemoryRepository(db as never);
    const rows = await repo.page({ userId: 7, scope: 'PROJECT', projectKey: 'mao', status: 'ACTIVE', page: 3, pageSize: 10 });
    expect(rows).toHaveLength(1);
    const [sql, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain('user_id = ?');
    expect(sql).toContain('scope = ?');
    expect(sql).toContain('project_key = ?');
    expect(sql).toContain('status = ?');
    expect(sql).toContain('ORDER BY updated_at DESC, id DESC');
    expect(params).toEqual([7, 'PROJECT', 'mao', 'ACTIVE', 10, 20]);
  });

  it('countActiveCountsOnlyActiveRows', async () => {
    const db = mockDb({ total: 5 });
    const repo = new MemoryRepository(db as never);
    expect(await repo.countActive(7)).toBe(5);
    const [sql, params] = (db.queryOne as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain('status = \'ACTIVE\'');
    expect(params).toEqual([7]);
  });

  it('insertStoresUserScopeProjectKeyAndSource', async () => {
    const db = mockDb();
    const repo = new MemoryRepository(db as never);
    const id = await repo.insert({
      userId: 7,
      scope: 'PROJECT',
      projectKey: 'mao',
      content: '测试用 Vitest',
      source: 'AUTO',
      status: 'ACTIVE',
      dedupHash: 'a'.repeat(40),
      originSessionId: 11,
    });
    expect(id).toBe(42);
    const [table, data] = (db.insert as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(table).toBe('memory_item');
    // snake_case 转换由 Db.insert 统一完成，仓储层传驼峰行
    expect(data).toMatchObject({ userId: 7, scope: 'PROJECT', projectKey: 'mao', source: 'AUTO', dedupHash: 'a'.repeat(40), originSessionId: 11 });
  });

  it('touchUpdatesUpdatedAtOnly', async () => {
    const db = mockDb();
    const repo = new MemoryRepository(db as never);
    await repo.touch(9);
    const [sql, params] = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain('SET updated_at = ?');
    expect(params[1]).toBe(9);
  });

  it('injectionQueriesBoundScopeStatusAndLimit', async () => {
    const db = mockDb(null, [{ id: 1 }]);
    const repo = new MemoryRepository(db as never);
    await repo.listActiveUser(7, 8);
    const [userSql, userParams] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(userSql).toContain("scope = 'USER'");
    expect(userSql).toContain("status = 'ACTIVE'");
    expect(userParams).toEqual([7, 8]);

    await repo.listActiveProject(7, 'mao', 12);
    const [projectSql, projectParams] = (db.query as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(projectSql).toContain("scope = 'PROJECT'");
    expect(projectSql).toContain('project_key = ?');
    expect(projectParams).toEqual([7, 'mao', 12]);
  });

  it('preferenceRoundtripDefaultsRowShape', async () => {
    const db = mockDb({ user_id: 7, auto_capture_enabled: 0 });
    const repo = new MemoryRepository(db as never);
    expect(await repo.findPreference(7)).toMatchObject({ auto_capture_enabled: 0 });
    await repo.updatePreference(7, true);
    const [sql, params] = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain('auto_capture_enabled = ?');
    expect(params).toEqual([1, 7]);
  });
});

describe('MemoryRepository dedupQueries', () => {
  it('listActiveForDedupFiltersAutoActiveAndBindsProjectKeyPerGroup', async () => {
    const db = mockDb(null, [{ id: 1 }]);
    const repo = new MemoryRepository(db as never);
    await repo.listActiveForDedup(7, 'PROJECT', 'mao');
    const [projectSql, projectParams] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(projectSql).toContain("source = 'AUTO'");
    expect(projectSql).toContain('project_key = ?');
    expect(projectParams).toEqual([7, 'PROJECT', 'mao']);

    await repo.listActiveForDedup(7, 'USER', null);
    const [userSql, userParams] = (db.query as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(userSql).not.toContain('project_key = ?');
    expect(userParams).toEqual([7, 'USER']);
  });

  it('listStaleAutoOrdersOldestFirstForEviction', async () => {
    const db = mockDb(null, [{ id: 3 }]);
    const repo = new MemoryRepository(db as never);
    await repo.listStaleAuto(7, 'USER', null, 1);
    const [sql, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain('ORDER BY updated_at ASC, id ASC');
    expect(sql).toContain("source = 'AUTO'");
    expect(params).toEqual([7, 'USER', 1]);
  });

  it('listDismissedContentsBindsLimit', async () => {
    const db = mockDb(null, [{ content: 'x' }]);
    const repo = new MemoryRepository(db as never);
    await repo.listDismissedContents(7, 50);
    const [sql, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain("status = 'DISMISSED'");
    expect(params).toEqual([7, 50]);
  });
});
