import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/db.js';
import { EcpIdentityRepository } from './ecp-identity.repository.js';

const identity = { email: 'Synthetic@example.test', displayName: 'Test', avatarUrl: 'https://ecp.example.com/a.png' };
const user = { id: 4, username: 'test', email: identity.email, status: 1, deleted: 0 };

function setup(options: { binding?: boolean; matches?: object[]; failInsert?: boolean; role?: boolean } = {}) {
  const tx = {
    queryOne: vi.fn(async (sql: string) => {
      if (sql.includes('user_identity_write_lock')) return { id: 1 };
      if (sql.includes('username =')) return null;
      if (sql.includes('SELECT id, subject FROM user_external_identity')) return null;
      if (sql.includes('subject =')) return options.binding ? { userId: 4 } : null;
      if (sql.includes('`user` WHERE id')) return user;
      if (sql.includes('SELECT provider FROM user_external_identity')) return { provider: 'ecp' };
      if (sql.includes('FROM role')) return options.role === false ? null : { id: 2 };
      throw new Error(`Unexpected test query: ${sql}`);
    }),
    query: vi.fn().mockResolvedValue(options.matches ?? []),
    insert: vi.fn(async (table: string) => {
      if (options.failInsert && table === 'user_external_identity') throw new Error('synthetic write failure');
      return 4;
    }),
    updateById: vi.fn(),
  };
  let committed = false;
  let rolledBack = false;
  const db = { transaction: vi.fn(async (fn: (db: Db) => Promise<unknown>) => {
    try { const result = await fn(tx as unknown as Db); committed = true; return result; }
    catch (error) { rolledBack = true; throw error; }
  }) };
  return { repo: new EcpIdentityRepository(db as unknown as Db), tx, state: () => ({ committed, rolledBack }) };
}

describe('EcpIdentityRepository', () => {
  it('writes user.avatar only when provisioning a new account', async () => {
    const { repo, tx } = setup();
    expect((await repo.resolve(identity)).action).toBe('created');
    expect(tx.insert).toHaveBeenCalledWith('user', expect.objectContaining({ username: 'synthetic', avatarUrl: identity.avatarUrl }));
  });

  it('omits the avatar column when the session carries none', async () => {
    const { repo, tx } = setup();
    await repo.resolve({ email: identity.email, displayName: identity.displayName });
    expect(tx.insert).toHaveBeenCalledWith('user', expect.not.objectContaining({ avatarUrl: expect.anything() }));
  });

  it('never overwrites an existing account avatar on bind or existing login', async () => {
    const bound = setup({ matches: [user] });
    await bound.repo.resolve(identity);
    expect(bound.tx.insert).not.toHaveBeenCalledWith('user', expect.anything());
    const existing = setup({ binding: true });
    await existing.repo.resolve(identity);
    expect(existing.tx.insert).not.toHaveBeenCalledWith('user', expect.anything());
    expect(existing.tx.updateById).not.toHaveBeenCalled();
  });

  it('rolls back the new account when the identity binding fails', async () => {
    const { repo, state } = setup({ failInsert: true });
    await expect(repo.resolve(identity)).rejects.toThrow('synthetic write failure');
    expect(state()).toEqual({ committed: false, rolledBack: true });
  });
});
