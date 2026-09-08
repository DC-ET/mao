import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { describe, expect, it } from 'vitest';
import { corsForRequest } from './cors-policy.js';

const path = '/api/v1/auth/sso/exchange';
describe('SSO exchange CORS boundary', () => {
  it('allows the configured origin and reflects requested headers on preflight', async () => {
    const app = Fastify();
    await app.register(cors, { delegator: async (req: FastifyRequest) => corsForRequest(req, path, { getCompanySsoConfig: async () => ({ enabled: true, allowedDomains: ['example.test'], allowedOrigins: ['https://portal.example.test'], accessTtlSeconds: 1800, timeoutMs: 3000, requireHttps: true }) }) });
    app.post(path, () => ({ ok: true }));
    app.get('/api/v1/users/me', () => ({ ok: true }));
    try {
      const requested = 'authorization,content-type,sw8,sw8-correlation,x-custom-trace';
      const preflight = await app.inject({ method: 'OPTIONS', url: path, headers: {
        origin: 'https://portal.example.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': requested,
      } });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe('https://portal.example.test');
      expect(preflight.headers['access-control-allow-headers']).toBe(requested);
      expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
      for (const origin of ['https://evil.example.test', 'null', 'https://portal.example.test.evil']) {
        const response = await app.inject({ method: 'POST', url: path, headers: { origin } });
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
      }
      const regular = await app.inject({ url: '/api/v1/users/me', headers: { origin: 'https://existing.example.test' } });
      expect(regular.headers['access-control-allow-origin']).toBe('https://existing.example.test');
      const restPreflight = await app.inject({ method: 'OPTIONS', url: '/api/v1/users/me', headers: {
        origin: 'https://existing.example.test',
        'access-control-request-method': 'GET',
        'access-control-request-headers': requested,
      } });
      expect(restPreflight.statusCode).toBe(204);
      expect(restPreflight.headers['access-control-allow-headers']).toBe(requested);
    } finally { await app.close(); }
  });
});
