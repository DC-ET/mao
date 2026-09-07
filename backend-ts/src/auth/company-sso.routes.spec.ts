import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerCompanySsoRoutes } from './company-sso.routes.js';
import { CompanySsoError } from './company-sso.error.js';
import type { CompanySsoConfig } from './company-sso.config.js';

const checkUrl = 'https://sgs.acg.team/custom/check?application=mao';

const config: CompanySsoConfig = { enabled: true, allowedDomains: ['acg.team'], allowedOrigins: ['https://host.example.test'], accessTtlSeconds: 1800, timeoutMs: 3000, requireHttps: false };
const result = { action: 'created' as const, accessToken: 'synthetic-access', expiresIn: 1800, expiresAt: 9999999999000, refreshAfter: 1680, user: { id: 4, displayName: 'Test' } };

describe('company SSO routes', () => {
  it('returns standard envelope without internal action or refresh token and records safe audit', async () => {
    const app = Fastify();
    const audit = vi.fn().mockResolvedValue(undefined);
    const exchange = vi.fn().mockResolvedValue(result);
    registerCompanySsoRoutes(app, { exchange }, config, audit);
    const res = await app.inject({ method: 'POST', payload: { checkUrl }, url: '/v1/auth/sso/exchange', headers: { authorization: 'Bearer synthetic-token', origin: config.allowedOrigins[0] } });
    expect(exchange).toHaveBeenCalledWith('synthetic-token', checkUrl);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({ code: 0, data: { accessToken: result.accessToken, user: result.user } });
    expect(res.json().data).not.toHaveProperty('action');
    expect(res.json().data).not.toHaveProperty('refreshToken');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'created', userId: 4, outcome: 'success' }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain('synthetic-token');
    await app.close();
  });

  it.each(['invalid_request', 'invalid_token', 'token_expiring', 'account_forbidden', 'identity_conflict', 'rate_limited', 'service_unavailable'] as const)('maps %s to actual HTTP status', async (kind) => {
    const app = Fastify();
    const error = new CompanySsoError(kind, kind === 'rate_limited' ? 60 : undefined);
    registerCompanySsoRoutes(app, { exchange: vi.fn().mockRejectedValue(error) }, config);
    const res = await app.inject({ method: 'POST', payload: { checkUrl }, url: '/v1/auth/sso/exchange', headers: { authorization: 'Bearer synthetic' } });
    expect(res.statusCode).toBe(error.status);
    expect(res.json().code).toBe(error.code);
    if (kind === 'rate_limited') expect(res.headers['retry-after']).toBe('60');
    await app.close();
  });

  it('rejects query tokens, wrong Origins, invalid headers and spoofed HTTPS', async () => {
    const app = Fastify();
    const exchange = vi.fn().mockResolvedValue(result);
    registerCompanySsoRoutes(app, { exchange }, config);
    for (const options of [
      { url: '/v1/auth/sso/exchange?token=synthetic', headers: { authorization: 'Bearer synthetic' }, status: 400 },
      { url: '/v1/auth/sso/exchange', headers: { origin: 'null', authorization: 'Bearer synthetic' }, status: 403 },
      { url: '/v1/auth/sso/exchange', headers: {}, status: 400 },
    ]) {
      expect((await app.inject({ method: 'POST', payload: { checkUrl }, url: options.url, headers: options.headers })).statusCode).toBe(options.status);
    }
    expect(exchange).not.toHaveBeenCalled();
    await app.close();
    const secure = Fastify();
    registerCompanySsoRoutes(secure, { exchange }, { ...config, requireHttps: true });
    expect((await secure.inject({ method: 'POST', payload: { checkUrl }, url: '/v1/auth/sso/exchange', headers: { 'x-forwarded-proto': 'https', authorization: 'Bearer synthetic' } })).statusCode).toBe(403);
    await secure.close();
  });

  it.each([undefined, {}, [], { checkUrl: 123 }, { checkUrl: '' }, { checkUrl, email: 'spoof@example.test' },
    { checkUrl, subject: '123' }, { checkUrl, token: 'spoof' }, { checkUrl: 'https://evilacg.team/check' },
    { checkUrl: 'https://acg.team.evil.com/check' }, { checkUrl: `${checkUrl}&token=existing` },
    { checkUrl: 'https://acg.team/check?q='.padEnd(2049, 'a') },
  ])('rejects missing, extra or invalid body fields %j before service invocation', async (payload) => {
    const app = Fastify();
    const exchange = vi.fn().mockResolvedValue(result);
    registerCompanySsoRoutes(app, { exchange }, config);
    try {
      const res = await app.inject({ method: 'POST', url: '/v1/auth/sso/exchange', payload, headers: { authorization: 'Bearer synthetic' } });
      expect(res.statusCode).toBe(400);
      expect(exchange).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('accepts a 2048-character URL even with expanded JSON escaping', async () => {
    const app = Fastify();
    const exchange = vi.fn().mockResolvedValue(result);
    registerCompanySsoRoutes(app, { exchange }, config);
    const longUrl = 'https://acg.team/check?q='.padEnd(2048, 'a');
    const payload = JSON.stringify({ checkUrl: longUrl }).replaceAll('a', '\\u0061');
    expect(payload.length).toBeGreaterThan(1024);
    try {
      const res = await app.inject({ method: 'POST', url: '/v1/auth/sso/exchange', payload, headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' } });
      expect(res.statusCode).toBe(200);
      expect(exchange).toHaveBeenCalledWith('synthetic', longUrl);
    } finally { await app.close(); }
  });

  it('limits IP requests before contacting SSO', async () => {
    const app = Fastify();
    const exchange = vi.fn().mockResolvedValue(result);
    registerCompanySsoRoutes(app, { exchange }, config);
    for (let i = 0; i < 60; i++) await app.inject({ method: 'POST', payload: { checkUrl }, url: '/v1/auth/sso/exchange', headers: { authorization: 'Bearer synthetic' } });
    const res = await app.inject({ method: 'POST', payload: { checkUrl }, url: '/v1/auth/sso/exchange', headers: { authorization: 'Bearer synthetic' } });
    expect(res.statusCode).toBe(429);
    expect(exchange).toHaveBeenCalledTimes(60);
    await app.close();
  });
});
