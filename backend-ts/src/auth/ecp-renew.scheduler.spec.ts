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
