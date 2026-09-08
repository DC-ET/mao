import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { describe, expect, it, vi } from 'vitest';
import { COMPANY_SSO_CONFIG_KEY, SystemSettingService } from './settings.service.js';
import type { SystemSetting, SystemSettingRepository } from './types.js';
import { registerSystemSettingRoutes } from './settings.routes.js';
import { handleError } from '../common/http-error.js';
import { ErrorCode } from '../common/error-code.js';
import { corsForRequest } from '../config/cors-policy.js';
import { registerCompanySsoRoutes } from '../auth/company-sso.routes.js';
import { CompanySsoService } from '../auth/company-sso.service.js';
import { CompanySsoClient } from '../auth/company-sso.client.js';
import { JwtService } from '../crypto/jwt.service.js';

const defaults = { enabled: false, allowedDomains: [], allowedOrigins: [], accessTtlSeconds: 1800, timeoutMs: 3000 };
const enabled = { ...defaults, enabled: true, allowedDomains: ['acg.team'], allowedOrigins: ['https://portal.example.test'] };
const path = '/api/v1/auth/sso/exchange';
const checkUrl = 'https://sgs.acg.team/check';
const headers = { authorization: 'Bearer synthetic', origin: enabled.allowedOrigins[0], 'x-forwarded-proto': 'https' };

function fixture(value: string | null = JSON.stringify(defaults)) {
  let row: SystemSetting | null = { id: 1, settingKey: COMPANY_SSO_CONFIG_KEY, value, category: '集成配置', editable: 1, isSecret: 0 };
  const repo: SystemSettingRepository = {
    findByKey: vi.fn(async () => row ? { ...row } : null),
    list: vi.fn(async () => row ? [{ ...row }] : []),
    updateById: vi.fn(async (next) => { row = { ...next }; }),
  };
  const settings = new SystemSettingService(repo, { findById: async () => null }, { findById: async () => null }, { workspaceRoot: '', skillsDir: '' });
  return { settings, repo, remove: () => { row = null; } };
}

async function application(value = JSON.stringify(enabled)) {
  const f = fixture(value);
  const app = Fastify({ trustProxy: ['127.0.0.1'] });
  app.setErrorHandler(handleError);
  await app.register(cors, { delegator: async (request: FastifyRequest) => corsForRequest(request, path, f.settings) });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
    code: 0, success: true, data: { illegal: false, claims: { id: 42, email: 'test@example.test', realName: 'Test', exp: Math.floor(Date.now() / 1000) + 7200 } },
  }), { headers: { 'content-type': 'application/json' } }));
  const client = new CompanySsoClient(fetcher);
  const verify = vi.spyOn(client, 'verify');
  const identities = { resolve: vi.fn(async () => ({ user: { id: 42, username: 'test' }, action: 'existing' as const })) };
  const service = new CompanySsoService(client, identities, new JwtService('synthetic-test-secret-only-not-a-real-key', 3600000, 7200000, 3600000));
  await app.register(async (api) => {
    api.addHook('preHandler', async (request) => { request.userId = 1; });
    registerSystemSettingRoutes(api, { systemSettingService: f.settings, permissionService: { hasPermission: async () => true } });
    registerCompanySsoRoutes(api, service, f.settings);
    api.get('/v1/ordinary', () => ({ ok: true }));
  }, { prefix: '/api' });
  const save = (config: unknown, batch = false) => app.inject({ method: 'PUT', url: `/api/v1/system-settings/${batch ? 'batch' : COMPANY_SSO_CONFIG_KEY}`,
    payload: batch ? { items: [{ key: COMPANY_SSO_CONFIG_KEY, value: JSON.stringify(config) }] } : { value: JSON.stringify(config) } });
  const exchange = (url = checkUrl, origin = headers.origin) => app.inject({ method: 'POST', url: path, payload: { checkUrl: url }, headers: { ...headers, origin } });
  return { ...f, app, fetcher, verify, identities, save, exchange };
}

describe('company SSO settings validation', () => {
  it('defaults only when the row is absent and never overwrites a corrupt stored value', async () => {
    for (const value of [null, '', ' ', '{}', 'invalid']) {
      const f = fixture(value);
      await expect(f.settings.getCompanySsoConfig()).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
      expect(f.repo.updateById).not.toHaveBeenCalled();
      f.remove();
      expect(await f.settings.getCompanySsoConfig()).toEqual({ ...defaults, requireHttps: true });
    }
  });

  it.each([
    undefined, null, '', ' ', '{}', 'null', '[]', '{', JSON.stringify({ ...enabled, extra: 1 }),
    JSON.stringify({ ...enabled, requireHttps: true }), JSON.stringify({ ...enabled, enabled: 'true' }),
    JSON.stringify({ ...enabled, allowedDomains: 'acg.team' }), JSON.stringify({ ...enabled, allowedDomains: [1] }),
    JSON.stringify({ ...enabled, allowedOrigins: [1] }), JSON.stringify({ ...enabled, allowedOrigins: [] }),
    JSON.stringify({ ...enabled, allowedDomains: [] }), JSON.stringify({ ...enabled, allowedOrigins: ['http://portal.example.test'] }),
    ...['https://*.ACG.TEAM', 'https://*.acg.team:443', 'https://foo*.acg.team', 'https://*.*.acg.team', 'https://*.127.0.0.1', 'https://*.acg.team/path', 'https://user@*.acg.team', 'https://*.acg.team:65536']
      .map((pattern) => JSON.stringify({ ...enabled, allowedOrigins: ['*', pattern] })),
    ...[59, 3601, 60.5, '1800', null].map((accessTtlSeconds) => JSON.stringify({ ...enabled, accessTtlSeconds })),
    ...[0, 30001, 1.5, '3000', null].map((timeoutMs) => JSON.stringify({ ...enabled, timeoutMs })),
    ...Object.keys(enabled).map((key) => JSON.stringify(Object.fromEntries(Object.entries(enabled).filter(([field]) => field !== key)))),
  ])('rejects incomplete/invalid snapshot %j in both save paths without writes', async (value) => {
    const { settings, repo } = fixture();
    await expect(settings.update(COMPANY_SSO_CONFIG_KEY, value)).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(settings.updateBatch([{ key: COMPANY_SSO_CONFIG_KEY, value }])).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    expect(repo.updateById).not.toHaveBeenCalled();
  });

  it('saves one normalized complete JSON and returns fixed HTTPS without persisting it', async () => {
    const { settings, repo } = fixture();
    const next = { ...enabled, allowedDomains: ['ACG.Team'], accessTtlSeconds: 60, timeoutMs: 1 };
    const saved = await settings.update(COMPANY_SSO_CONFIG_KEY, JSON.stringify(next));
    expect(JSON.parse(saved.value!)).toEqual({ ...next, allowedDomains: ['acg.team'] });
    expect(await settings.getCompanySsoConfig()).toEqual({ ...next, allowedDomains: ['acg.team'], requireHttps: true });
    expect(repo.updateById).toHaveBeenCalledOnce();
    await settings.updateBatch([{ key: COMPANY_SSO_CONFIG_KEY, value: JSON.stringify({ ...defaults, accessTtlSeconds: 3600, timeoutMs: 30000 }) }]);
    expect((await settings.getCompanySsoConfig()).accessTtlSeconds).toBe(3600);
  });
});

describe('company SSO runtime updates through settings HTTP routes', () => {
  it.each(['https://*.acg.team', 'https://*.acg.team:8443', '*'])('saves %s in both paths and shares preflight/POST decisions', async (pattern) => {
    const f = await application();
    try {
      for (const batch of [false, true]) {
        expect((await f.save({ ...enabled, allowedOrigins: [pattern] }, batch)).json().code).toBe(0);
        expect((await f.settings.getCompanySsoConfig()).allowedOrigins).toEqual([pattern]);
      }
      const origins = ['https://a.acg.team', 'https://a.b.acg.team', 'https://acg.team',
        'https://a.acg.team:8443', 'https://a.b.acg.team:8443', 'https://a.acg.team:9443',
        'https://acg.team:8443', 'http://a.acg.team', 'null', 'https://evilacg.team',
        'https://a.acg.team.evil.test', 'https://a.acg.team/path', 'https://user@a.acg.team'];
      for (const origin of origins) {
        const allowed = pattern === '*' || (pattern.endsWith(':8443')
          ? ['https://a.acg.team:8443', 'https://a.b.acg.team:8443'].includes(origin)
          : ['https://a.acg.team', 'https://a.b.acg.team'].includes(origin));
        const preflight = await f.app.inject({ method: 'OPTIONS', url: path, headers: {
          origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'Authorization, Content-Type',
        } });
        const post = await f.exchange(checkUrl, origin);
        expect(post.statusCode).toBe(allowed ? 200 : 403);
        for (const response of [preflight, post]) {
          expect(response.headers['access-control-allow-origin']).toBe(allowed ? (pattern === '*' ? '*' : origin) : undefined);
          expect(response.headers['access-control-allow-credentials']).toBeUndefined();
        }
        if (allowed) expect(preflight.statusCode).toBe(204);
      }
    } finally { await f.app.close(); }
  });

  it('keeps Mao HTTPS and checkUrl rules with all sources enabled', async () => {
    const f = await application(JSON.stringify({ ...enabled, allowedOrigins: ['*'] }));
    try {
      const insecure = await f.app.inject({ method: 'POST', url: path, payload: { checkUrl },
        headers: { ...headers, origin: 'http://localhost:3000', 'x-forwarded-proto': 'http' } });
      expect(insecure.statusCode).toBe(403);
      for (const url of ['http://sgs.acg.team/check', 'https://evilacg.team/check', 'https://acg.team.evil.test/check']) {
        expect((await f.exchange(url, 'null')).statusCode).toBe(400);
      }
      expect(f.fetcher).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });

  it.each([
    { ...enabled, enabled: false, allowedOrigins: ['*'] },
    { ...enabled, allowedOrigins: ['*', 'https://*.*.acg.team'] },
  ])('fails closed on disabled or bad wildcard configuration %j', async (stored) => {
    const f = await application(JSON.stringify(stored));
    try {
      const preflight = await f.app.inject({ method: 'OPTIONS', url: path,
        headers: { origin: 'null', 'access-control-request-method': 'POST' } });
      const post = await f.exchange(checkUrl, 'null');
      expect(post.statusCode).toBe(503);
      for (const response of [preflight, post]) expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(f.fetcher).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });

  it('applies enable, domains, origins, timeout and TTL immediately with one read per exchange', async () => {
    const f = await application(JSON.stringify(defaults));
    try {
      expect((await f.exchange()).statusCode).toBe(503);
      expect((await f.save(enabled)).json().code).toBe(0);
      vi.mocked(f.repo.findByKey).mockClear();
      const first = await f.exchange();
      expect(first.statusCode).toBe(200);
      expect(first.json().data.expiresIn).toBe(1800);
      expect(f.repo.findByKey).toHaveBeenCalledTimes(1);
      expect(f.verify.mock.lastCall![2]).toMatchObject({ timeoutMs: 3000, requireHttps: true });
      const next = { ...enabled, allowedDomains: ['new.example.test'], allowedOrigins: ['https://new.example.test'], timeoutMs: 50, accessTtlSeconds: 60 };
      expect((await f.save(next, true)).json().code).toBe(0);
      expect((await f.exchange()).statusCode).toBe(403);
      expect((await f.exchange(checkUrl, next.allowedOrigins[0])).statusCode).toBe(400);
      const updated = await f.exchange('https://new.example.test/check', next.allowedOrigins[0]);
      expect(updated.statusCode).toBe(200);
      expect(updated.headers['access-control-allow-origin']).toBe(next.allowedOrigins[0]);
      expect(updated.json().data.expiresIn).toBe(60);
      expect(f.verify.mock.lastCall![2]).toMatchObject({ timeoutMs: 50, accessTtlSeconds: 60 });
      const preflight = await f.app.inject({ method: 'OPTIONS', url: path, headers: { origin: next.allowedOrigins[0], 'access-control-request-method': 'POST' } });
      expect(preflight.headers['access-control-allow-origin']).toBe(next.allowedOrigins[0]);
      await f.save(defaults);
      const disabled = await f.exchange('https://new.example.test/check', next.allowedOrigins[0]);
      expect(disabled.statusCode).toBe(503);
      expect(disabled.headers['access-control-allow-origin']).toBeUndefined();
      expect(f.fetcher).toHaveBeenCalledTimes(2);
    } finally { await f.app.close(); }
  });

  it('uses the newly saved timeout for the next outbound verification', async () => {
    const f = await application();
    try {
      await f.save({ ...enabled, timeoutMs: 5 });
      f.fetcher.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('synthetic transport timeout')));
      }));
      expect((await f.exchange()).statusCode).toBe(503);
      expect(f.verify.mock.lastCall![2].timeoutMs).toBe(5);
      expect(f.identities.resolve).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });

  it('keeps the CORS snapshot through route, client and TTL even if saved mid-request', async () => {
    const f = await application();
    const read = f.settings.getCompanySsoConfig.bind(f.settings);
    vi.spyOn(f.settings, 'getCompanySsoConfig').mockImplementationOnce(async () => {
      const snapshot = await read();
      await f.settings.update(COMPANY_SSO_CONFIG_KEY, JSON.stringify(defaults));
      return snapshot;
    });
    f.identities.resolve.mockImplementationOnce(async () => {
      await f.settings.update(COMPANY_SSO_CONFIG_KEY, JSON.stringify({ ...enabled, accessTtlSeconds: 60, timeoutMs: 1 }));
      return { user: { id: 42, username: 'test' }, action: 'existing' };
    });
    try {
      const response = await f.exchange();
      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(headers.origin);
      expect(response.json().data.expiresIn).toBe(1800);
      expect(f.verify.mock.lastCall![2].timeoutMs).toBe(3000);
      expect((await f.exchange()).json().data.expiresIn).toBe(60);
    } finally { await f.app.close(); }
  });

  it('preserves subject and IP rate windows across config saves and toggles', async () => {
    const f = await application();
    try {
      for (let i = 0; i < 20; i++) expect((await f.exchange()).statusCode).toBe(200);
      await f.save(defaults);
      await f.save({ ...enabled, accessTtlSeconds: 60 });
      expect((await f.exchange()).statusCode).toBe(429);
      for (let i = 21; i < 60; i++) expect((await f.exchange()).statusCode).toBe(429);
      expect(f.fetcher).toHaveBeenCalledTimes(60);
      await f.save(enabled);
      const limited = await f.exchange();
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(f.fetcher).toHaveBeenCalledTimes(60);
    } finally { await f.app.close(); }
  });

  it('rejects bad HTTP saves and stored corruption without affecting ordinary REST CORS', async () => {
    const f = await application('broken');
    try {
      for (const batch of [false, true]) {
        const invalid = await f.save({ ...enabled, requireHttps: false }, batch);
        expect(invalid.json().code).toBe(ErrorCode.PARAM_INVALID.code);
      }
      for (const payload of [{}, { value: null }, { value: '' }, { value: enabled }]) {
        const response = await f.app.inject({ method: 'PUT', url: `/api/v1/system-settings/${COMPANY_SSO_CONFIG_KEY}`, payload });
        expect(response.json().code).toBe(ErrorCode.PARAM_INVALID.code);
      }
      expect(f.repo.updateById).not.toHaveBeenCalled();
      const failed = await f.exchange();
      expect(failed.statusCode).toBe(503);
      expect(failed.headers['access-control-allow-origin']).toBeUndefined();
      expect(f.fetcher).not.toHaveBeenCalled();
      vi.mocked(f.repo.findByKey).mockClear();
      const regular = await f.app.inject({ url: '/api/v1/ordinary', headers: { origin: 'http://ordinary.example.test' } });
      expect(regular.statusCode).toBe(200);
      expect(regular.headers['access-control-allow-origin']).toBe('http://ordinary.example.test');
      expect(f.repo.findByKey).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
});
