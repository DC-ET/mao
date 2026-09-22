import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/db.js';
import { MysqlUserRepository } from './user.repository.js';

function setup(duplicates: object[] = []) {
  const events: string[] = [];
  const tx = {
    queryOne: vi.fn(async (sql: string) => { events.push(sql.includes('write_lock') ? 'lock' : 'read'); return sql.includes('write_lock') ? { id: 1 } : { id: 4, email: 'Old@example.test' }; }),
    query: vi.fn(async () => { events.push('check'); return duplicates; }),
    insert: vi.fn(async () => { events.push('insert'); return 4; }),
    updateById: vi.fn(async () => { events.push('update'); }),
  };
  const db = { transaction: vi.fn(async (fn: (db: Db) => Promise<unknown>) => fn(tx as unknown as Db)) };
  return { repo: new MysqlUserRepository(db as unknown as Db), tx, events };
}

describe('MysqlUserRepository identity email serialization', () => {
  it('locks and checks email before insert', async () => {
    const { repo, events } = setup();
    await repo.insert({ username: 'synthetic', email: 'Test@example.test' });
    expect(events).toEqual(['lock', 'check', 'insert']);
  });

  it('checks changed email in the same transaction as all update entry points', async () => {
    for (const method of ['updateFields', 'updateById'] as const) {
      const { repo, events, tx } = setup();
      if (method === 'updateFields') await repo.updateFields(4, { email: 'New@example.test' });
      else await repo.updateById({ id: 4, username: 'synthetic', email: 'New@example.test' });
      expect(events).toEqual(['lock', 'read', 'check', 'update']);
      expect(tx.query.mock.calls.length).toBe(1);
    }
  });

  it('filters auth source with the same rule as resolveAuthSource', async () => {
    const sqls: string[] = [];
    const db = {
      queryOne: vi.fn(async (sql: string) => { sqls.push(sql); return { cnt: 0 }; }),
      query: vi.fn(async (sql: string) => { sqls.push(sql); return []; }),
    };
    const repo = new MysqlUserRepository(db as unknown as Db);
    await repo.selectPage(1, 10, undefined, null, 'LDAP');
    expect(sqls[0]).toContain('password_hash');
    expect(sqls[0]).toContain('feishu_user_id');
    await repo.selectPage(1, 10, undefined, null, 'nope');
    expect(sqls[2]).not.toContain('feishu_user_id');
  });

  it('rejects concurrent duplicate/deleted-email occupancy without writing', async () => {
    const { repo, tx } = setup([{ id: 9 }]);
    await expect(repo.insert({ username: 'synthetic', email: 'Taken@example.test' })).rejects.toThrow('该邮箱已被其他用户使用');
    await expect(repo.updateFields(4, { email: 'Taken@example.test' })).rejects.toThrow('该邮箱已被其他用户使用');
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.updateById).not.toHaveBeenCalled();
  });
});
