import { describe, expect, it, vi } from 'vitest';
import { createEcpTokenProvider } from './ecp-token-provider.js';
import type { EcpSessionReader } from './ecp-token-provider.js';
import type { UserEcpSession } from './ecp-session.repository.js';

const FUTURE = '2099-12-31 23:59:59';
const PAST = '2000-01-01 00:00:00';

function session(overrides: Partial<UserEcpSession> = {}): UserEcpSession {
  return {
    userId: 7,
    sessionTokenEnc: 'enc-token',
    expiresAt: FUTURE,
    renewStatus: 'ACTIVE',
    ...overrides,
  };
}

function readerOf(
  row: UserEcpSession | null,
  decrypt: (enc: string) => string | null = () => 'ecp-plain-token',
): { reader: EcpSessionReader; findByUserId: ReturnType<typeof vi.fn> } {
  const findByUserId = vi.fn(async () => row);
  return { reader: { findByUserId, decryptToken: decrypt }, findByUserId };
}

describe('createEcpTokenProvider', () => {
  it('returnsTokenForUsableSession', async () => {
    const { reader } = readerOf(session());
    const provider = createEcpTokenProvider(reader);
    await expect(provider.getUsableToken(7)).resolves.toEqual({ ok: true, token: 'ecp-plain-token' });
  });

  it('reportsNoSessionWhenRowMissing', async () => {
    const { reader } = readerOf(null);
    const provider = createEcpTokenProvider(reader);
    await expect(provider.getUsableToken(7)).resolves.toEqual({ ok: false, reason: 'no_session' });
  });

  it('reportsRenewFailedWhenSessionMarkedFailed', async () => {
    const { reader } = readerOf(session({ renewStatus: 'FAILED' }));
    const provider = createEcpTokenProvider(reader);
    await expect(provider.getUsableToken(7)).resolves.toEqual({ ok: false, reason: 'renew_failed' });
  });

  it('reportsExpiredWhenExpiresAtInPast', async () => {
    const { reader } = readerOf(session({ expiresAt: PAST }));
    const provider = createEcpTokenProvider(reader);
    await expect(provider.getUsableToken(7)).resolves.toEqual({ ok: false, reason: 'expired' });
  });

  it('reportsDecryptFailedWhenDecryptReturnsNull', async () => {
    const { reader } = readerOf(session(), () => null);
    const provider = createEcpTokenProvider(reader);
    await expect(provider.getUsableToken(7)).resolves.toEqual({ ok: false, reason: 'decrypt_failed' });
  });

  it('reportsDisabledWhenEcpLoginOff', async () => {
    const { reader, findByUserId } = readerOf(session());
    const provider = createEcpTokenProvider(reader, { isEnabled: async () => false });
    await expect(provider.getUsableToken(7)).resolves.toEqual({ ok: false, reason: 'disabled' });
    expect(findByUserId).not.toHaveBeenCalled();
  });

  it('cachesPositiveResultWithinTtl', async () => {
    const { reader, findByUserId } = readerOf(session());
    const provider = createEcpTokenProvider(reader, { ttlMs: 60_000 });
    await provider.getUsableToken(7);
    await provider.getUsableToken(7);
    expect(findByUserId).toHaveBeenCalledTimes(1);
  });

  it('doesNotCacheNegativeResult', async () => {
    const findByUserId = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(session());
    const reader: EcpSessionReader = { findByUserId, decryptToken: () => 'ecp-plain-token' };
    const provider = createEcpTokenProvider(reader);
    await expect(provider.getUsableToken(7)).resolves.toEqual({ ok: false, reason: 'no_session' });
    await expect(provider.getUsableToken(7)).resolves.toEqual({ ok: true, token: 'ecp-plain-token' });
    expect(findByUserId).toHaveBeenCalledTimes(2);
  });

  it('refetchesAfterTtlElapsed', async () => {
    let clock = 0;
    const { reader, findByUserId } = readerOf(session());
    const provider = createEcpTokenProvider(reader, { ttlMs: 1000, now: () => clock });
    await provider.getUsableToken(7);
    clock = 1001;
    await provider.getUsableToken(7);
    expect(findByUserId).toHaveBeenCalledTimes(2);
  });
});
