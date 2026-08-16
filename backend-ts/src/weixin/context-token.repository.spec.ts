import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/db.js';
import { ContextTokenRepository } from './context-token.repository.js';

describe('ContextTokenRepository', () => {
  const db = {
    queryOne: vi.fn(),
    query: vi.fn(),
    insert: vi.fn(),
    updateById: vi.fn(),
    execute: vi.fn(),
  };
  const repo = new ContextTokenRepository(db as unknown as Db);

  it('saveOrUpdateCreatesNewToken', async () => {
    db.queryOne.mockResolvedValue(null);
    db.insert.mockResolvedValue(1);
    await repo.saveOrUpdate('account1', 'wxUser1', 'token123');
    expect(db.insert).toHaveBeenCalled();
  });

  it('saveOrUpdateUpdatesExistingToken', async () => {
    const existing = { id: 1, accountId: 'account1', wxUserId: 'wxUser1', token: 'old-token' };
    db.queryOne.mockResolvedValue(existing);
    await repo.saveOrUpdate('account1', 'wxUser1', 'new-token');
    expect(db.updateById).toHaveBeenCalledWith('weixin_channel_context_token', 1, { token: 'new-token' });
  });

  it('getLatestTokenReturnsToken', async () => {
    db.queryOne.mockResolvedValue({ token: 'token123' });
    expect(await repo.getLatestToken('account1', 'wxUser1')).toBe('token123');
  });

  it('getLatestTokenReturnsNullWhenNotFound', async () => {
    db.queryOne.mockResolvedValue(null);
    expect(await repo.getLatestToken('account1', 'wxUser1')).toBeNull();
  });

  it('deleteByAccountIdDeletesTokens', async () => {
    await repo.deleteByAccountId('account1');
    expect(db.execute).toHaveBeenCalled();
  });
});
