import { describe, expect, it } from 'vitest';
import { matchesCompanySsoOrigin, validateCompanySsoConfig, type CompanySsoConfig } from './company-sso.config.js';

const config: CompanySsoConfig = { enabled: true, allowedDomains: ['acg.team'], allowedOrigins: [], accessTtlSeconds: 1800, timeoutMs: 3000, requireHttps: true };

const invalidOriginPatterns = [
  '**', 'https://*', 'http://*.acg.team', 'https://foo*.acg.team', 'https://**.acg.team',
  'https://*.*.acg.team', 'https://*.acg.*', 'https://*.acg.team/', 'https://*.acg.team/path',
  'https://*.acg.team?x', 'https://*.acg.team#', 'https://user@*.acg.team', 'https://*.acg.team@evil.test',
  'https://*.acg.team\\evil.test', 'https://*.acg.team\n', ' https://*.acg.team',
  'https://*.127.0.0.1', 'https://*.127.1', 'https://*.[::1]', 'https://*.localhost',
  'https://*.acg..team', 'https://*.-acg.team', 'https://*.acg-.team', 'https://*.a_b.team',
  'https://*.acg.team.', 'https://*.%61cg.team', `https://*.${'a'.repeat(64)}.team`,
  'https://*.acg.team:', 'https://*.acg.team:0', 'https://*.acg.team:65536',
  'https://*.ACG.TEAM', 'https://*.acg.team:443',
  'https://*.acg.team:08443', 'https://*.acg.team:abc',
];

describe('company SSO Origin patterns', () => {
  it.each(['*', 'https://*.acg.team', 'https://*.acg.team:8443', 'https://host.acg.team'])('accepts %s', (pattern) => {
    expect(validateCompanySsoConfig({ ...config, allowedOrigins: [pattern] }).allowedOrigins).toEqual([pattern]);
  });

  it.each(invalidOriginPatterns)('rejects malformed pattern %j even alongside *', (pattern) => {
    expect(() => validateCompanySsoConfig({ ...config, allowedOrigins: ['*', pattern] })).toThrow();
  });

  it.each([
    ['https://a.acg.team', true], ['https://a.b.acg.team', true], ['https://acg.team', false],
    ['https://evilacg.team', false], ['https://a.acg.team.evil.test', false],
    ['https://a.acg.team:8443', false], ['http://a.acg.team', false], ['null', false],
    ['https://a.acg.team/path', false], ['https://a.acg.team/', false],
    ['https://a.acg.team?x', false], ['https://a.acg.team#', false],
    ['https://user@a.acg.team', false], ['https://a.acg.team@evil.test', false],
    ['https:///a.acg.team', false], ['https://a.acg.team\\evil.test', false],
    ['https://a..acg.team', false], ['https://-a.acg.team', false], ['https://a_b.acg.team', false],
  ])('matches default HTTPS wildcard against %j: %s', (origin, allowed) => {
    expect(matchesCompanySsoOrigin(origin, ['https://*.acg.team'])).toBe(allowed);
  });

  it.each(['https://127.0.0.1', 'https://[::1]', 'https://localhost'])('matches mixed exact %s and wildcard regardless of order', (exact) => {
    for (const patterns of [[exact, 'https://*.acg.team'], ['https://*.acg.team', exact]]) {
      const validated = validateCompanySsoConfig({ ...config, allowedOrigins: patterns });
      expect(matchesCompanySsoOrigin(exact, validated.allowedOrigins)).toBe(true);
      expect(matchesCompanySsoOrigin('https://a.b.acg.team', validated.allowedOrigins)).toBe(true);
      expect(matchesCompanySsoOrigin(`${exact}:8443`, validated.allowedOrigins)).toBe(false);
      expect(matchesCompanySsoOrigin('https://acg.team', validated.allowedOrigins)).toBe(false);
    }
  });

  it('strictly matches non-default ports and preserves exact origins', () => {
    const patterns = ['https://*.acg.team:8443', 'https://exact.example.test'];
    for (const origin of ['https://a.acg.team:8443', 'https://a.b.acg.team:8443', 'https://exact.example.test']) {
      expect(matchesCompanySsoOrigin(origin, patterns)).toBe(true);
    }
    for (const origin of ['https://a.acg.team', 'https://a.acg.team:9443', 'https://acg.team:8443', 'https://exact.example.test:8443']) {
      expect(matchesCompanySsoOrigin(origin, patterns)).toBe(false);
    }
  });

  it.each(['http://localhost:3000', 'null', 'https://unrelated.test', 'file://', 'custom-source'])('allows any source under *: %s', (origin) => {
    expect(matchesCompanySsoOrigin(origin, ['*'])).toBe(true);
  });
});
