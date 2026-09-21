import { describe, expect, it } from 'vitest';
import { matchesCompanySsoOrigin, validateCompanySsoConfig, type CompanySsoConfig } from './company-sso.config.js';

const config: CompanySsoConfig = { enabled: true, allowedDomains: ['example.com'], allowedOrigins: [], accessTtlSeconds: 1800, timeoutMs: 3000, requireHttps: true };

const invalidOriginPatterns = [
  '**', 'https://*', 'http://*.example.com', 'https://foo*.example.com', 'https://**.example.com',
  'https://*.*.example.com', 'https://*.example.*', 'https://*.example.com/', 'https://*.example.com/path',
  'https://*.example.com?x', 'https://*.example.com#', 'https://user@*.example.com', 'https://*.example.com@evil.test',
  'https://*.example.com\\evil.test', 'https://*.example.com\n', ' https://*.example.com',
  'https://*.127.0.0.1', 'https://*.127.1', 'https://*.[::1]', 'https://*.localhost',
  'https://*.example..com', 'https://*.-example.com', 'https://*.example-.com', 'https://*.a_b.team',
  'https://*.example.com.', 'https://*.%65xample.com', `https://*.${'a'.repeat(64)}.team`,
  'https://*.example.com:', 'https://*.example.com:0', 'https://*.example.com:65536',
  'https://*.EXAMPLE.COM', 'https://*.example.com:443',
  'https://*.example.com:08443', 'https://*.example.com:abc',
];

describe('company SSO Origin patterns', () => {
  it.each(['*', 'https://*.example.com', 'https://*.example.com:8443', 'https://host.example.com'])('accepts %s', (pattern) => {
    expect(validateCompanySsoConfig({ ...config, allowedOrigins: [pattern] }).allowedOrigins).toEqual([pattern]);
  });

  it.each(invalidOriginPatterns)('rejects malformed pattern %j even alongside *', (pattern) => {
    expect(() => validateCompanySsoConfig({ ...config, allowedOrigins: ['*', pattern] })).toThrow();
  });

  it.each([
    ['https://a.example.com', true], ['https://a.b.example.com', true], ['https://example.com', false],
    ['https://evilexample.com', false], ['https://a.example.com.evil.test', false],
    ['https://a.example.com:8443', false], ['http://a.example.com', false], ['null', false],
    ['https://a.example.com/path', false], ['https://a.example.com/', false],
    ['https://a.example.com?x', false], ['https://a.example.com#', false],
    ['https://user@a.example.com', false], ['https://a.example.com@evil.test', false],
    ['https:///a.example.com', false], ['https://a.example.com\\evil.test', false],
    ['https://a..example.com', false], ['https://-a.example.com', false], ['https://a_b.example.com', false],
  ])('matches default HTTPS wildcard against %j: %s', (origin, allowed) => {
    expect(matchesCompanySsoOrigin(origin, ['https://*.example.com'])).toBe(allowed);
  });

  it.each(['https://127.0.0.1', 'https://[::1]', 'https://localhost'])('matches mixed exact %s and wildcard regardless of order', (exact) => {
    for (const patterns of [[exact, 'https://*.example.com'], ['https://*.example.com', exact]]) {
      const validated = validateCompanySsoConfig({ ...config, allowedOrigins: patterns });
      expect(matchesCompanySsoOrigin(exact, validated.allowedOrigins)).toBe(true);
      expect(matchesCompanySsoOrigin('https://a.b.example.com', validated.allowedOrigins)).toBe(true);
      expect(matchesCompanySsoOrigin(`${exact}:8443`, validated.allowedOrigins)).toBe(false);
      expect(matchesCompanySsoOrigin('https://example.com', validated.allowedOrigins)).toBe(false);
    }
  });

  it('strictly matches non-default ports and preserves exact origins', () => {
    const patterns = ['https://*.example.com:8443', 'https://exact.example.test'];
    for (const origin of ['https://a.example.com:8443', 'https://a.b.example.com:8443', 'https://exact.example.test']) {
      expect(matchesCompanySsoOrigin(origin, patterns)).toBe(true);
    }
    for (const origin of ['https://a.example.com', 'https://a.example.com:9443', 'https://example.com:8443', 'https://exact.example.test:8443']) {
      expect(matchesCompanySsoOrigin(origin, patterns)).toBe(false);
    }
  });

  it.each(['http://localhost:3000', 'null', 'https://unrelated.test', 'file://', 'custom-source'])('allows any source under *: %s', (origin) => {
    expect(matchesCompanySsoOrigin(origin, ['*'])).toBe(true);
  });
});
