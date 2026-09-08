import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loadTrustedProxyAddresses } from './trusted-proxy.js';

describe('exact trusted proxy configuration', () => {
  it('defaults to no trusted proxy and rejects broad or malformed values', () => {
    expect(loadTrustedProxyAddresses('')).toBe(false);
    expect(loadTrustedProxyAddresses('127.0.0.1,::1')).toEqual(['127.0.0.1', '::1']);
    for (const value of ['true', '*', '0.0.0.0/0', 'proxy.example', '127.0.0.1,']) {
      expect(() => loadTrustedProxyAddresses(value)).toThrow();
    }
  });
  it('honors TLS termination headers only from the registered proxy', async () => {
    const app = Fastify({ trustProxy: loadTrustedProxyAddresses('127.0.0.1') });
    app.get('/', (request) => ({ protocol: request.protocol, ip: request.ip }));
    try {
      const trusted = await app.inject({ url: '/', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.1' } });
      expect(trusted.json()).toEqual({ protocol: 'https', ip: '192.0.2.1' });
      const untrusted = await app.inject({ url: '/', remoteAddress: '192.0.2.2', headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.1' } });
      expect(untrusted.json()).toEqual({ protocol: 'http', ip: '192.0.2.2' });
    } finally { await app.close(); }
  });
});
