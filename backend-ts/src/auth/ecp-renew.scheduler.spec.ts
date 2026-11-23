import { describe, expect, it, vi } from 'vitest';
import { EcpRenewScheduler } from './ecp-renew.scheduler.js';
import { defaultEcpConfig } from './ecp.config.js';

describe('EcpRenewScheduler', () => {
  it('marks failed when renew throws and does not retry old token', async () => {
    const sessions = {
      listDueForRenew: vi.fn(async () => [{ id: 1, userId: 7, sessionTokenEnc: 'enc', expiresAt: '2099-01-01' }]),
      markRenewing: vi.fn(async () => true),
      saveRenewed: vi.fn(),
      markFailed: vi.fn(async () => {}),
      decryptToken: vi.fn(() => 'old-token'),
    };
    const client = {
      renewSession: vi.fn(async () => { throw new Error('timeout'); }),
    };
    const scheduler = new EcpRenewScheduler(
      sessions as never,
      async () => ({ ...defaultEcpConfig(), enabled: true }),
      client,
      (t) => `enc-${t}`,
    );
    await scheduler.tick();
    expect(sessions.markFailed).toHaveBeenCalledWith(1);
    expect(sessions.saveRenewed).not.toHaveBeenCalled();
  });

  it('recovers stale RENEWING rows before scanning for due sessions', async () => {
    const calls: string[] = [];
    const sessions = {
      recoverStaleRenewing: vi.fn(async () => { calls.push('recover'); return 2; }),
      listDueForRenew: vi.fn(async () => { calls.push('list'); return []; }),
      markRenewing: vi.fn(async () => true),
      saveRenewed: vi.fn(),
      markFailed: vi.fn(),
      decryptToken: vi.fn(() => 'old-token'),
    };
    const scheduler = new EcpRenewScheduler(
      sessions as never,
      async () => ({ ...defaultEcpConfig(), enabled: true }),
      { renewSession: vi.fn() },
      (t) => `enc-${t}`,
    );
    await scheduler.tick();
    // markRenewing 后崩溃留下的中间态必须先复位，否则该用户永远不再进入续期队列
    expect(sessions.recoverStaleRenewing).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['recover', 'list']);
  });

  it('saves renewed token on success', async () => {
    const expiresAt = new Date(Date.now() + 3600_000);
    const sessions = {
      listDueForRenew: vi.fn(async () => [{ id: 2, userId: 7, sessionTokenEnc: 'enc', expiresAt: '2099-01-01' }]),
      markRenewing: vi.fn(async () => true),
      saveRenewed: vi.fn(async () => {}),
      markFailed: vi.fn(),
      decryptToken: vi.fn(() => 'old-token'),
    };
    const client = {
      renewSession: vi.fn(async () => ({
        sessionToken: 'new-token',
        expiresAt,
        user: { email: 'a@example.com', displayName: 'A' },
      })),
    };
    const scheduler = new EcpRenewScheduler(
      sessions as never,
      async () => ({ ...defaultEcpConfig(), enabled: true }),
      client,
      (t) => `enc-${t}`,
    );
    await scheduler.tick();
    expect(sessions.saveRenewed).toHaveBeenCalledWith(2, 'enc-new-token', expiresAt);
  });

  it('notifies token rotation after successful renew', async () => {
    const expiresAt = new Date(Date.now() + 3600_000);
    const sessions = {
      listDueForRenew: vi.fn(async () => [{ id: 3, userId: 42, sessionTokenEnc: 'enc', expiresAt: '2099-01-01', renewStatus: 'ACTIVE' }]),
      markRenewing: vi.fn(async () => true),
      saveRenewed: vi.fn(async () => {}),
      markFailed: vi.fn(),
      decryptToken: vi.fn(() => 'old-token'),
    };
    const onSessionRotated = vi.fn();
    const scheduler = new EcpRenewScheduler(
      sessions as never,
      async () => ({ ...defaultEcpConfig(), enabled: true }),
      { renewSession: vi.fn(async () => ({ sessionToken: 'new-token', expiresAt, user: { email: 'a@example.com', displayName: 'A' } })) },
      (t) => `enc-${t}`,
      { onSessionRotated },
    );
    await scheduler.tick();
    // renew 会吊销旧票：必须同步通知凭证缓存失效（否则最多 60s 内继续用死票）
    expect(onSessionRotated).toHaveBeenCalledWith(42);
  });

  it('notifies token rotation after renew failure', async () => {
    const sessions = {
      listDueForRenew: vi.fn(async () => [{ id: 4, userId: 42, sessionTokenEnc: 'enc', expiresAt: '2099-01-01', renewStatus: 'ACTIVE' }]),
      markRenewing: vi.fn(async () => true),
      saveRenewed: vi.fn(),
      markFailed: vi.fn(async () => {}),
      decryptToken: vi.fn(() => 'old-token'),
    };
    const onSessionRotated = vi.fn();
    const scheduler = new EcpRenewScheduler(
      sessions as never,
      async () => ({ ...defaultEcpConfig(), enabled: true }),
      { renewSession: vi.fn(async () => { throw new Error('timeout'); }) },
      (t) => `enc-${t}`,
      { onSessionRotated },
    );
    await scheduler.tick();
    // 失败时旧票也可能已作废（超时丢响应），缓存同样不能留
    expect(onSessionRotated).toHaveBeenCalledWith(42);
  });

  it('keeps renewing later rows when rotation callback throws', async () => {
    const expiresAt = new Date(Date.now() + 3600_000);
    const sessions = {
      listDueForRenew: vi.fn(async () => [
        { id: 5, userId: 1, sessionTokenEnc: 'enc', expiresAt: '2099-01-01', renewStatus: 'ACTIVE' },
        { id: 6, userId: 2, sessionTokenEnc: 'enc', expiresAt: '2099-01-01', renewStatus: 'ACTIVE' },
      ]),
      markRenewing: vi.fn(async () => true),
      saveRenewed: vi.fn(async () => {}),
      markFailed: vi.fn(),
      decryptToken: vi.fn(() => 'old-token'),
    };
    const onSessionRotated = vi.fn(() => { throw new Error('cache offline'); });
    const scheduler = new EcpRenewScheduler(
      sessions as never,
      async () => ({ ...defaultEcpConfig(), enabled: true }),
      { renewSession: vi.fn(async () => ({ sessionToken: 'new-token', expiresAt, user: { email: 'a@example.com', displayName: 'A' } })) },
      (t) => `enc-${t}`,
      { onSessionRotated },
    );
    await scheduler.tick();
    // 回调故障不能打断本轮续期：后面还有用户的票等着续
    expect(sessions.saveRenewed).toHaveBeenCalledTimes(2);
    expect(onSessionRotated).toHaveBeenCalledTimes(2);
  });
});
