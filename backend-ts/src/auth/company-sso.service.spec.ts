import { describe, expect, it, vi } from 'vitest';
import { CompanySsoClient } from './company-sso.client.js';
import { CompanySsoService } from './company-sso.service.js';
import type { CompanySsoConfig } from './company-sso.config.js';
import { JwtService } from '../crypto/jwt.service.js';

const config: CompanySsoConfig = { enabled: true, allowedDomains: ['acg.team'], allowedOrigins: ['https://host.example.test'], accessTtlSeconds: 1800, timeoutMs: 3000, requireHttps: true };
const jwt = new JwtService('synthetic-test-secret-not-a-real-credential', 86400000, 604800000, 7200000);
const identity = (remaining: number) => ({ subject: '3089', email: 'Synthetic@example.test', displayName: 'Test', expiresAt: Date.now() + remaining * 1000 });

describe('CompanySsoService', () => {
  it.each([3600, 120])('issues actual bounded TTL for %i remaining seconds and no refresh', async (remaining) => {
    const verified = identity(remaining);
    const service = new CompanySsoService({ verify: vi.fn().mockResolvedValue(verified) }, { resolve: vi.fn().mockResolvedValue({ user: { id: 4, username: 'test' }, action: 'bound' }) }, jwt);
    const result = await service.exchange('synthetic', 'https://sgs.acg.team/check', config);
    expect(result.expiresIn).toBeLessThanOrEqual(Math.min(1800, remaining));
    expect(result.expiresAt).toBeLessThanOrEqual(verified.expiresAt);
    expect(result.refreshAfter).toBeLessThan(result.expiresIn);
    expect(result).not.toHaveProperty('refreshToken');
    expect(jwt.getAccessTokenMetadata(result.accessToken)).toEqual({ userId: 4, authSource: 'company_sso', expiresAt: result.expiresAt });
    expect(jwt.getTokenType(result.accessToken)).toBe('access');
  });

  it('passes each URL through the real client without changing the stable subject or provider', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      code: 0, success: true, data: { illegal: false, claims: { id: 3089, email: 'Synthetic@example.test', realName: 'Test', exp: Math.floor(Date.now() / 1000) + 3600 } },
    }), { headers: { 'content-type': 'application/json' } }));
    const resolve = vi.fn().mockResolvedValue({ user: { id: 4, username: 'test' }, action: 'existing' });
    const service = new CompanySsoService(new CompanySsoClient(fetcher), { resolve }, jwt);
    for (const checkUrl of ['https://acg.team/business/check?app=first', 'https://sgs.acg.team/other/path?app=second']) {
      const result = await service.exchange('synthetic', checkUrl, config);
      expect(String(fetcher.mock.lastCall![0])).toBe(`${checkUrl}&token=synthetic`);
      expect(resolve).toHaveBeenLastCalledWith(expect.objectContaining({ subject: '3089' }));
      expect(jwt.getAccessTokenMetadata(result.accessToken)).toMatchObject({ userId: 4, authSource: 'company_sso' });
    }
  });

  it('rejects near expiry before writing accounts and rechecks after DB work', async () => {
    const resolve = vi.fn().mockResolvedValue({ user: { id: 4, username: 'test' }, action: 'existing' });
    const service = new CompanySsoService({ verify: vi.fn().mockResolvedValue(identity(29)) }, { resolve }, jwt);
    await expect(service.exchange('synthetic', 'https://sgs.acg.team/check', config)).rejects.toMatchObject({ code: 1402 });
    expect(resolve).not.toHaveBeenCalled();
    const verified = identity(60);
    resolve.mockImplementation(async () => { verified.expiresAt = Date.now() + 1000; return { user: { id: 4, username: 'test' }, action: 'existing' }; });
    await expect(new CompanySsoService({ verify: vi.fn().mockResolvedValue(verified) }, { resolve }, jwt).exchange('synthetic', 'https://sgs.acg.team/check', config)).rejects.toMatchObject({ code: 1402 });
  });

  it('rate limits verified subject across exchanges', async () => {
    const service = new CompanySsoService({ verify: vi.fn().mockResolvedValue(identity(3600)) }, { resolve: vi.fn().mockResolvedValue({ user: { id: 4, username: 'test' }, action: 'existing' }) }, jwt);
    for (let i = 0; i < 20; i++) await service.exchange('synthetic', 'https://sgs.acg.team/check', config);
    await expect(service.exchange('synthetic', 'https://sgs.acg.team/check', config)).rejects.toMatchObject({ status: 429 });
  });
});
