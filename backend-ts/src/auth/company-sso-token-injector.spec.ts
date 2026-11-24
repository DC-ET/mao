import { describe, expect, it, vi } from 'vitest';
import { createCompanySsoTokenInjector } from './company-sso-token-injector.js';
import type { CompanySsoTokenLookup } from './company-sso-token-injector.js';

function lookup(row: { tokenEnc: string; expiresAt: string } | null, token: string | null): CompanySsoTokenLookup {
  return {
    findByUserId: vi.fn(async () => (row ? { userId: 7, ...row } : null)),
    decryptToken: vi.fn(() => token),
  };
}

describe('createCompanySsoTokenInjector', () => {
  it('returns the decrypted token while it is still valid', async () => {
    const tokens = lookup({ tokenEnc: 'enc', expiresAt: '2099-01-01 00:00:00' }, 'sso-live');
    const injector = createCompanySsoTokenInjector(tokens);
    await expect(injector.injectForUser(7)).resolves.toBe('sso-live');
    expect(tokens.decryptToken).toHaveBeenCalledWith('enc');
  });

  it('returns null when the row is missing, expired, or undecryptable', async () => {
    await expect(createCompanySsoTokenInjector(lookup(null, 'x')).injectForUser(7)).resolves.toBeNull();
    const expired = lookup({ tokenEnc: 'enc', expiresAt: '2000-01-01 00:00:00' }, 'sso-old');
    await expect(createCompanySsoTokenInjector(expired).injectForUser(7)).resolves.toBeNull();
    expect(expired.decryptToken).not.toHaveBeenCalled();
    await expect(createCompanySsoTokenInjector(lookup({ tokenEnc: 'enc', expiresAt: '2099-01-01 00:00:00' }, null)).injectForUser(7)).resolves.toBeNull();
  });
});
