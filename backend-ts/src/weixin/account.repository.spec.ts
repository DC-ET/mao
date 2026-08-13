import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import type { Db } from '../db/db.js';
import { WeixinAccountRepository } from './account.repository.js';
import type { WeixinChannelAccount } from './types.js';

function createAccount(id: number | undefined, userId: number, accountId: string): WeixinChannelAccount {
  return {
    id, userId, accountId,
    payloadJson: '{"token":"test","baseUrl":"https://test.com","userId":"wx123"}',
    enabled: 1, deleted: 0,
  };
}

describe('WeixinAccountRepository', () => {
  const db = {
    queryOne: vi.fn(),
    query: vi.fn(),
    insert: vi.fn(),
    updateById: vi.fn(),
    execute: vi.fn(),
  };
  const repo = new WeixinAccountRepository(db as unknown as Db);

  it('findByUserIdReturnsAccount', async () => {
    const account = createAccount(1, 1, 'user_1');
    db.queryOne.mockResolvedValue(account);
    const result = await repo.findByUserId(1);
    expect(result?.userId).toBe(1);
  });

  it('findByUserIdReturnsNullWhenNotFound', async () => {
    db.queryOne.mockResolvedValue(null);
    expect(await repo.findByUserId(1)).toBeNull();
  });

  it('findByAccountIdReturnsAccount', async () => {
    db.queryOne.mockResolvedValue(createAccount(1, 1, 'user_1'));
    expect((await repo.findByAccountId('user_1'))?.accountId).toBe('user_1');
  });

  it('createInsertsAccount', async () => {
    db.insert.mockResolvedValue(9);
    const account = createAccount(undefined, 1, 'user_1');
    await repo.create(account);
    expect(db.insert).toHaveBeenCalled();
    expect(account.id).toBe(9);
  });

  it('updateUpdatesAccount', async () => {
    const account = createAccount(1, 1, 'user_1');
    await repo.update(account);
    expect(db.updateById).toHaveBeenCalled();
  });

  it('getBindingStatusReturnsBoundWhenAccountExists', async () => {
    const account = createAccount(1, 1, 'user_1');
    account.payloadJson = '{"token":"test","baseUrl":"https://test.com","userId":"wx123","savedAt":"2026-07-15T10:00:00"}';
    db.queryOne.mockResolvedValue(account);
    const status = await repo.getBindingStatus(1);
    expect(status.bound).toBe(true);
    expect(status.accountId).toBe('wx123');
  });

  it('getBindingStatusReturnsNotBoundWhenAccountNotFound', async () => {
    db.queryOne.mockResolvedValue(null);
    expect((await repo.getBindingStatus(1)).bound).toBe(false);
  });

  it('unbindDisablesAccount', async () => {
    const account = createAccount(1, 1, 'user_1');
    db.queryOne.mockResolvedValue(account);
    await repo.unbind(1);
    expect(account.enabled).toBe(0);
    expect(db.updateById).toHaveBeenCalled();
  });

  it('unbindThrowsWhenAccountNotFound', async () => {
    db.queryOne.mockResolvedValue(null);
    await expect(repo.unbind(1)).rejects.toBeInstanceOf(BusinessException);
    await expect(repo.unbind(1)).rejects.toThrow(/未找到绑定的微信Bot账号/);
  });

  it('findAllEnabledReturnsAccounts', async () => {
    db.query.mockResolvedValue([createAccount(1, 1, 'user_1'), createAccount(2, 2, 'user_2')]);
    expect(await repo.findAllEnabled()).toHaveLength(2);
  });

  it('updateGetUpdatesBufUpdatesAccount', async () => {
    const account = createAccount(1, 1, 'user_1');
    db.queryOne.mockResolvedValue(account);
    await repo.updateGetUpdatesBuf(1, 'new-buf');
    expect(account.getUpdatesBuf).toBe('new-buf');
    expect(db.updateById).toHaveBeenCalled();
  });

  it('disableAccountDisablesAccount', async () => {
    const account = createAccount(1, 1, 'user_1');
    db.queryOne.mockResolvedValue(account);
    await repo.disableAccount(1);
    expect(account.enabled).toBe(0);
  });
});
