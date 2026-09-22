import { describe, expect, it, vi } from 'vitest';
import { EcpRenewScheduler } from './ecp-renew.scheduler.js';
import { defaultEcpConfig } from './ecp.config.js';

describe('EcpRenewScheduler', () => {
  it('marks failed when renew throws and does not retry old token', async () => {
    const sessions = {
      listDueForRenew: vi.fn(async () => [{ id: 1, sessionTokenEnc: 'enc', expiresAt: '2099-01-01' }]),
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
      listDueForRenew: vi.fn(async () => [{ id: 2, sessionTokenEnc: 'enc', expiresAt: '2099-01-01' }]),
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
});
