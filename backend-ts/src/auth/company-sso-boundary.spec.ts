import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { describe, expect, it, vi } from 'vitest';
import { corsForRequest } from '../config/cors-policy.js';
import { authenticateRequest, isPublicPath } from './jwt-hook.js';
import { registerCompanySsoRoutes } from './company-sso.routes.js';
const checkUrl = 'https://sgs.acg.team/api/sso-auth/auth/checkToken';
import { JwtService } from '../crypto/jwt.service.js';

/** Exercise real Fastify ordering: TLS proxy -> CORS -> JWT bypass -> exchange. */
describe('SSO exchange application boundary', () => {
  it('accepts external credentials only at exchange behind a trusted TLS proxy', async () => {
    const path = '/api/v1/auth/sso/exchange';
    const jwt = new JwtService('synthetic-integration-test-secret-only', 3600000, 7200000, 3600000);
    const verifyMao = vi.spyOn(jwt, 'validateAccessToken');
    const exchange = vi.fn(async () => ({ ...jwt.generateCompanySsoToken(42, 'synthetic', 300), refreshAfter: 240, user: { id: 42, displayName: 'Test' }, action: 'existing' as const }));
    const audit = vi.fn(async () => {});
    const app = Fastify({ trustProxy: ['127.0.0.1'] });
    const config = { enabled: true, allowedDomains: ['acg.team'], allowedOrigins: ['https://portal.example.test'], accessTtlSeconds: 1800, timeoutMs: 3000, requireHttps: true as const };
    const settings = { getCompanySsoConfig: async () => config };
    await app.register(cors, { delegator: async (req: FastifyRequest) => corsForRequest(req, path, settings) });
    app.addHook('preHandler', async (request, reply) => {
      if (request.method === 'OPTIONS' || request.url.split('?')[0] === path) return;
      const id = authenticateRequest(request, jwt);
      if (id != null) request.userId = id;
      if (!isPublicPath(request.method, request.url) && id == null) return reply.code(401).send({ code: 1001 });
    });
    await app.register(async (api) => {
      registerCompanySsoRoutes(api, { exchange }, settings, audit);
      api.get('/v1/protected', (request) => ({ userId: request.userId }));
    }, { prefix: '/api' });
    const headers = { authorization: 'Bearer synthetic.sso.token', origin: 'https://portal.example.test', 'x-forwarded-proto': 'https' };
    try {
      const result = await app.inject({ method: 'POST', payload: { checkUrl }, url: path, remoteAddress: '127.0.0.1', headers });
      expect(result.statusCode).toBe(200);
      expect(verifyMao).not.toHaveBeenCalled();
      expect(exchange).toHaveBeenCalledWith('synthetic.sso.token', checkUrl, config);
      expect(audit).toHaveBeenCalledOnce();
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.json().data).not.toHaveProperty('refreshToken');
      expect(result.json().data).not.toHaveProperty('action');
      const denied = await app.inject({ url: '/api/v1/protected', headers });
      expect(denied.statusCode).toBe(401);
      const accepted = await app.inject({ url: '/api/v1/protected', headers: { authorization: `Bearer ${result.json().data.accessToken}` } });
      expect(accepted.json()).toEqual({ userId: 42 });
      const direct = await app.inject({ method: 'POST', payload: { checkUrl }, url: path, remoteAddress: '192.0.2.1', headers });
      expect(direct.statusCode).toBe(403);
      const wrongOrigin = await app.inject({ method: 'POST', payload: { checkUrl }, url: path, remoteAddress: '127.0.0.1', headers: { ...headers, origin: 'https://evil.example.test' } });
      expect(wrongOrigin.statusCode).toBe(403);
      expect(wrongOrigin.headers['access-control-allow-origin']).toBeUndefined();
      expect(exchange).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });
});
