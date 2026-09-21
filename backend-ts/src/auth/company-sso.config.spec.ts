import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateCompanySsoCheckUrl, validateCompanySsoConfig, type CompanySsoConfig } from './company-sso.config.js';
import { loadConfig, resetConfigCache } from '../config/app-config.js';

const config: CompanySsoConfig = { enabled: true, allowedDomains: ['example.com'], allowedOrigins: ['https://host.example.test'], accessTtlSeconds: 1800, timeoutMs: 3000, requireHttps: true };
afterEach(() => { vi.unstubAllEnvs(); resetConfigCache(); });

describe('company SSO configuration', () => {
  it('has no AppConfig SSO configuration even when obsolete environment variables exist', () => {
    vi.stubEnv('SSO_ENABLED', 'true');
    vi.stubEnv('SSO_ALLOWED_DOMAINS', '*');
    vi.stubEnv('SSO_ALLOWED_ORIGINS', 'http://insecure.test');
    vi.stubEnv('SSO_ACCESS_TTL_SECONDS', 'invalid');
    vi.stubEnv('SSO_TIMEOUT_MS', 'invalid');
    resetConfigCache();
    expect(loadConfig()).not.toHaveProperty('sso');
  });

  it.each([
    { allowedOrigins: [] }, { allowedOrigins: ['null'] }, { allowedOrigins: ['https://foo*.example.test'] },
    { allowedOrigins: ['https://host.example.test/path'] }, { allowedOrigins: ['http://host.example.test'] },
    { accessTtlSeconds: 59 }, { accessTtlSeconds: 3601 }, { timeoutMs: 0 }, { allowedDomains: [] },
  ])('rejects unsafe config %j', (override) => {
    expect(() => validateCompanySsoConfig({ ...config, ...override })).toThrow();
  });

  it.each(['', 'https://example.com', '*.example.com', 'example.com/path', 'example.com:443', 'example.com.',
    'example..com', '-example.com', 'example-.com', 'a_b.team', ' example.com', '127.0.0.1', '127.1', '[::1]',
    'localhost', '%65xample.com', 'example.com?x', 'user@example.com', `${'a'.repeat(64)}.team`, `${'a'.repeat(63)}.`.repeat(4) + 'team',
  ])('rejects malformed or non-DNS domain %s', (domain) => {
    expect(() => validateCompanySsoConfig({ ...config, allowedDomains: [domain] })).toThrow();
  });

  it('requires HTTPS in every environment', () => {
    expect(() => validateCompanySsoConfig({ ...config, requireHttps: false } as unknown as CompanySsoConfig)).toThrow();
  });
});

describe('company SSO check URL boundary', () => {
  it.each(['example.com', 'sgs.example.com', 'a.b.example.com', 'EXAMPLE.COM'])('allows configured domain and its subdomains: %s', (host) => {
    expect(validateCompanySsoCheckUrl(`https://${host}/business/check?app=mao`, config).hostname).toBe(host.toLowerCase());
  });

  it('supports a full domain without allowing its parent or siblings', () => {
    const exact = { ...config, allowedDomains: ['sgs.example.com'] };
    expect(validateCompanySsoCheckUrl('https://sgs.example.com/check', exact).hostname).toBe('sgs.example.com');
    expect(validateCompanySsoCheckUrl('https://child.sgs.example.com/check', exact).hostname).toBe('child.sgs.example.com');
    for (const host of ['example.com', 'other.example.com', 'evilsgs.example.com']) {
      expect(() => validateCompanySsoCheckUrl(`https://${host}`, exact)).toThrow();
    }
  });

  it.each([undefined, null, 1, '', '/check', 'https://', 'https://evilexample.com/check', 'https://example.com.evil.com',
    'https://unknown.test', 'https:///example.com/check', 'http://example.com/check', 'https://user:pass@example.com/check', 'https://@example.com/check',
    'https://example.com/check#', 'https://example.com/check#fragment', 'https://example.com/check?token=x',
    'https://example.com/check?%74oken=x', 'https://example.com/check?Token=x', 'https://example.com/check?token',
    'https://example.com/check?token=a&token=b', 'https://example.com./check', 'https://example.com/\ncheck',
    'https://example.com\\evil.com/check', 'https://127.0.0.1/check',
  ])('rejects invalid or untrusted URL %j with 400', (url) => {
    expect(() => validateCompanySsoCheckUrl(url, config)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('accepts 2048 characters and rejects 2049', () => {
    const url = 'https://example.com/check?q='.padEnd(2048, 'a');
    expect(validateCompanySsoCheckUrl(url, config).href).toBe(url);
    expect(() => validateCompanySsoCheckUrl(`${url}a`, config)).toThrow(expect.objectContaining({ status: 400 }));
  });
});
