import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/db.js';
import { CompanySsoIdentityRepository } from './company-sso-identity.repository.js';

const identity = { subject: '3089', email: 'Synthetic@example.test', displayName: 'Test', expiresAt: Date.now() + 3600000 };
const user = { id: 4, username: 'test', email: identity.email, status: 1, deleted: 0 };

function setup(options: { binding?: boolean; matches?: object[]; boundUser?: object | null; other?: boolean; failInsert?: boolean; role?: boolean } = {}) {
  const tx = {
    queryOne: vi.fn(async (sql: string) => {
      if (sql.includes('user_identity_write_lock')) return { id: 1 };
      if (sql.includes('subject =')) return options.binding ? { userId: 4 } : null;
      if (sql.includes('`user` WHERE id')) return options.boundUser === undefined ? user : options.boundUser;
      if (sql.includes('user_external_identity')) return options.other ? { id: 9 } : null;
      if (sql.includes('FROM role')) return options.role === false ? null : { id: 2 };
      throw new Error(`Unexpected test query: ${sql}`);
    }),
    query: vi.fn().mockResolvedValue(options.matches ?? []),
    insert: vi.fn(async (table: string) => {
      if (options.failInsert && table === 'user_external_identity') throw new Error('synthetic write failure');
      return 4;
    }),
  };
  let committed = false;
  let rolledBack = false;
  const db = { transaction: vi.fn(async (fn: (db: Db) => Promise<unknown>) => {
    try { const result = await fn(tx as unknown as Db); committed = true; return result; }
    catch (error) { rolledBack = true; throw error; }
  }) };
  return { repo: new CompanySsoIdentityRepository(db as unknown as Db), tx, state: () => ({ committed, rolledBack }) };
}

describe('CompanySsoIdentityRepository', () => {
  it('prefers existing binding even when email differs and preserves promoted roles', async () => {
    const { repo, tx } = setup({ binding: true });
    expect(await repo.resolve({ ...identity, email: 'Changed@example.test' })).toEqual({ user, action: 'existing' });
    expect(tx.query).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('binds unique existing account without overwriting it', async () => {
    const { repo, tx } = setup({ matches: [user] });
    expect(await repo.resolve(identity)).toEqual({ user, action: 'bound' });
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledWith('user_external_identity', expect.objectContaining({ userId: 4, subject: '3089' }));
    expect(tx.insert.mock.calls.map(([table]) => table)).not.toContain('user_role');
  });

  it('creates user, ordinary role and identity in one transaction', async () => {
    const { repo, tx, state } = setup();
    expect((await repo.resolve(identity)).action).toBe('created');
    expect(tx.insert.mock.calls.map(([table]) => table)).toEqual(['user', 'user_role', 'user_external_identity']);
    expect(state().committed).toBe(true);
    expect(tx.queryOne.mock.calls[0][0]).toContain('user_identity_write_lock');
  });

  it.each([
    [{ matches: [user, user] }, 409],
    [{ matches: [{ ...user, status: 0 }] }, 403], [{ matches: [{ ...user, deleted: 1 }] }, 403],
    [{ matches: [user], other: true }, 409], [{ binding: true, boundUser: null }, 403],
    [{ role: false }, 503],
  ] as const)('rejects unsafe mapping %j', async (options, status) => {
    const { repo, tx, state } = setup(options as Parameters<typeof setup>[0]);
    await expect(repo.resolve(identity)).rejects.toMatchObject({ status });
    expect(tx.insert).not.toHaveBeenCalled();
    expect(state().rolledBack).toBe(true);
  });

  it('rereads a concurrent winning binding only after rollback', async () => {
    const options = { binding: false };
    const { repo, tx } = setup(options);
    tx.insert.mockImplementation(async (table) => {
      if (table === 'user_external_identity') {
        options.binding = true;
        throw Object.assign(new Error('synthetic duplicate'), { code: 'ER_DUP_ENTRY' });
      }
      return 4;
    });
    expect(await repo.resolve(identity)).toEqual({ user, action: 'existing' });
    expect(tx.insert).toHaveBeenCalledTimes(3);
  });

  it('rolls back account and role creation when binding fails', async () => {
    const { repo, state } = setup({ failInsert: true });
    await expect(repo.resolve(identity)).rejects.toThrow('synthetic write failure');
    expect(state()).toEqual({ committed: false, rolledBack: true });
  });
});
