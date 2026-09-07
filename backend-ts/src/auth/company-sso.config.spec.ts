import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateCompanySsoCheckUrl, validateCompanySsoConfig, type CompanySsoConfig } from './company-sso.config.js';
import { loadConfig, resetConfigCache } from '../config/app-config.js';

const config: CompanySsoConfig = { enabled: true, allowedDomains: ['acg.team'], allowedOrigins: ['https://host.example.test'], accessTtlSeconds: 1800, timeoutMs: 3000, requireHttps: true };
afterEach(() => { vi.unstubAllEnvs(); resetConfigCache(); });

describe('company SSO configuration', () => {
  it('defaults disabled with bounded TTL and timeout and no fixed URL', () => {
    resetConfigCache();
    expect(loadConfig().sso).toMatchObject({ enabled: false, accessTtlSeconds: 1800, timeoutMs: 3000, allowedDomains: [] });
    expect(loadConfig().sso).not.toHaveProperty('checkUrl');
  });

  it('loads exact origins and comma separated normalized domains', () => {
    vi.stubEnv('SSO_ENABLED', 'true');
    vi.stubEnv('SSO_ALLOWED_DOMAINS', ' ACG.Team , sso.example.test ');
    vi.stubEnv('SSO_ALLOWED_ORIGINS', 'https://a.example.test,https://b.example.test');
    vi.stubEnv('SSO_ACCESS_TTL_SECONDS', '600');
    resetConfigCache();
    expect(loadConfig().sso).toMatchObject({ enabled: true, accessTtlSeconds: 600, allowedDomains: ['acg.team', 'sso.example.test'], allowedOrigins: ['https://a.example.test', 'https://b.example.test'] });
  });

  it.each([
    { allowedOrigins: [] }, { allowedOrigins: ['null'] }, { allowedOrigins: ['https://*.example.test'] },
    { allowedOrigins: ['https://host.example.test/path'] }, { allowedOrigins: ['http://host.example.test'] },
    { accessTtlSeconds: 59 }, { accessTtlSeconds: 3601 }, { timeoutMs: 0 }, { allowedDomains: [] },
  ])('rejects unsafe config %j', (override) => {
    expect(() => validateCompanySsoConfig({ ...config, ...override })).toThrow();
  });

  it.each(['', 'https://acg.team', '*.acg.team', 'acg.team/path', 'acg.team:443', 'acg.team.',
    'acg..team', '-acg.team', 'acg-.team', 'a_b.team', ' acg.team', '127.0.0.1', '127.1', '[::1]',
    'localhost', '%61cg.team', 'acg.team?x', 'user@acg.team', `${'a'.repeat(64)}.team`, `${'a'.repeat(63)}.`.repeat(4) + 'team',
  ])('rejects malformed or non-DNS domain %s', (domain) => {
    expect(() => validateCompanySsoConfig({ ...config, allowedDomains: [domain] })).toThrow();
  });

  it.each(['', 'acg.team,', '*.acg.team'])('rejects invalid domain environment %s when enabled', (domains) => {
    vi.stubEnv('SSO_ENABLED', 'true');
    vi.stubEnv('SSO_ALLOWED_DOMAINS', domains);
    vi.stubEnv('SSO_ALLOWED_ORIGINS', 'https://host.example.test');
    resetConfigCache();
    expect(() => loadConfig()).toThrow();
  });

  it('requires HTTPS in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => validateCompanySsoConfig({ ...config, requireHttps: false })).toThrow();
  });
});

describe('company SSO check URL boundary', () => {
  it.each(['acg.team', 'sgs.acg.team', 'a.b.acg.team', 'ACG.TEAM'])('allows configured domain and its subdomains: %s', (host) => {
    expect(validateCompanySsoCheckUrl(`https://${host}/business/check?app=mao`, config).hostname).toBe(host.toLowerCase());
  });

  it('supports a full domain without allowing its parent or siblings', () => {
    const exact = { ...config, allowedDomains: ['sgs.acg.team'] };
    expect(validateCompanySsoCheckUrl('https://sgs.acg.team/check', exact).hostname).toBe('sgs.acg.team');
    expect(validateCompanySsoCheckUrl('https://child.sgs.acg.team/check', exact).hostname).toBe('child.sgs.acg.team');
    for (const host of ['acg.team', 'other.acg.team', 'evilsgs.acg.team']) {
      expect(() => validateCompanySsoCheckUrl(`https://${host}`, exact)).toThrow();
    }
  });

  it.each([undefined, null, 1, '', '/check', 'https://', 'https://evilacg.team/check', 'https://acg.team.evil.com',
    'https://unknown.test', 'https:///acg.team/check', 'http://acg.team/check', 'https://user:pass@acg.team/check', 'https://@acg.team/check',
    'https://acg.team/check#', 'https://acg.team/check#fragment', 'https://acg.team/check?token=x',
    'https://acg.team/check?%74oken=x', 'https://acg.team/check?Token=x', 'https://acg.team/check?token',
    'https://acg.team/check?token=a&token=b', 'https://acg.team./check', 'https://acg.team/\ncheck',
    'https://acg.team\\evil.com/check', 'https://127.0.0.1/check',
  ])('rejects invalid or untrusted URL %j with 400', (url) => {
    expect(() => validateCompanySsoCheckUrl(url, config)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('accepts 2048 characters and rejects 2049', () => {
    const url = 'https://acg.team/check?q='.padEnd(2048, 'a');
    expect(validateCompanySsoCheckUrl(url, config).href).toBe(url);
    expect(() => validateCompanySsoCheckUrl(`${url}a`, config)).toThrow(expect.objectContaining({ status: 400 }));
  });
});
