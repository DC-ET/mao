import { describe, expect, it, vi } from 'vitest';
import { CompanySsoClient, MAX_SSO_BODY_BYTES } from './company-sso.client.js';
import type { CompanySsoConfig } from './company-sso.config.js';

const checkUrl = 'https://sso.example.com/auth/checkToken';

export const config: CompanySsoConfig = { enabled: true, allowedDomains: ['example.com'], allowedOrigins: ['https://host.example.test'], accessTtlSeconds: 1800, timeoutMs: 3000, requireHttps: true };
const claims = () => ({ id: 3089, sub: 'ignored', email: 'Synthetic@example.test', realName: 'Test', exp: Math.floor(Date.now() / 1000) + 3600, environment: 'prod' });
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

describe('CompanySsoClient', () => {
  it('uses only trusted remote claims and fixed GET protocol', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ code: 0, success: true, data: { illegal: false, claims: claims() } }));
    const identity = await new CompanySsoClient(fetcher).verify('synthetic-token', checkUrl, config);
    expect(identity).toMatchObject({ subject: 'Synthetic@example.test', email: 'Synthetic@example.test', displayName: 'Test' });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe(`${checkUrl}?token=synthetic-token`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', headers: { Accept: 'application/json' } });
  });

  it.each(['https://example.com/business/check?app=mao&scope=a%2Fb', 'https://child.sgs.example.com:8443/other/check?app=two'])('passes the supplied business URL to GET: %s', async (url) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ code: 0, success: true, data: { illegal: false, claims: claims() } }));
    await new CompanySsoClient(fetcher).verify('synthetic+token/=', url, config);
    const expected = new URL(url);
    expected.searchParams.set('token', 'synthetic+token/=');
    expect(String(fetcher.mock.calls[0][0])).toBe(expected.href);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('body');
  });

  it('ignores a lying Content-Length header and accepts checkToken bodies over 64KiB', async () => {
    const payload = { code: 0, success: true, data: { illegal: false, claims: { ...claims(), padding: 'n'.repeat(70_000) } } };
    const ok = new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json;charset=UTF-8', 'content-length': '999999' },
    });
    await expect(new CompanySsoClient(vi.fn().mockResolvedValue(ok)).verify('synthetic', checkUrl, config)).resolves.toMatchObject({ subject: 'Synthetic@example.test' });
    const huge = new Response('x'.repeat(MAX_SSO_BODY_BYTES + 1), { headers: { 'content-type': 'application/json' } });
    await expect(new CompanySsoClient(vi.fn().mockResolvedValue(huge)).verify('synthetic', checkUrl, config)).rejects.toMatchObject({
      status: 503, detail: `oversized:${MAX_SSO_BODY_BYTES + 1}`,
    });
  });

  it.each(['application/json', 'application/json;charset=UTF-8', 'application/json; charset=UTF-8'])('accepts JSON content type %s', async (contentType) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      code: 0, success: true, data: { illegal: false, claims: claims() },
    }), { headers: { 'content-type': contentType } }));
    await expect(new CompanySsoClient(fetcher).verify('synthetic', checkUrl, config)).resolves.toMatchObject({ subject: 'Synthetic@example.test' });
  });

  it('uses email as the stable subject across different company user ids', async () => {
    for (const id of [1, 9999]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ code: 0, success: true, data: { illegal: false, claims: { ...claims(), id } } }));
      await expect(new CompanySsoClient(fetcher).verify('synthetic', checkUrl, config)).resolves.toMatchObject({ subject: 'Synthetic@example.test' });
    }
  });

  it.each(['https://evilexample.com/check', 'https://example.com.evil.com/check', 'http://example.com', 'https://example.com?token=existing', 'not a URL'])('rejects %s before any outbound request', async (url) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new CompanySsoClient(fetcher).verify('synthetic', url, config)).rejects.toMatchObject({ status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    {}, { code: 0, success: false, data: { illegal: false, claims: claims() } },
    { code: 0, success: true, data: { claims: claims() } },
    { code: 0, success: true, data: { illegal: false, claims: { ...claims(), id: '3089' } } },
    { code: 0, success: true, data: { illegal: false, claims: { ...claims(), exp: undefined } } },
  ])('fails closed for ambiguous contract %j', async (body) => {
    await expect(new CompanySsoClient(vi.fn().mockResolvedValue(response(body))).verify('synthetic', checkUrl, config)).rejects.toMatchObject({ status: 503, detail: 'contract' });
  });

  it('distinguishes explicit illegal and expired credentials', async () => {
    for (const data of [{ illegal: true }, { illegal: false, claims: { ...claims(), exp: 1 } }]) {
      await expect(new CompanySsoClient(vi.fn().mockResolvedValue(response({ code: 0, success: true, data }))).verify('synthetic', checkUrl, config)).rejects.toMatchObject({ status: 401 });
    }
  });

  it('bounds streamed responses and suppresses transport error details', async () => {
    const cases = [
      { fetcher: vi.fn().mockRejectedValue(new Error('https://example.test/?token=secret')), detail: 'transport' },
      { fetcher: vi.fn().mockResolvedValue(new Response('', { status: 302, headers: { location: 'https://elsewhere.test' } })), detail: 'http_302' },
      { fetcher: vi.fn().mockResolvedValue(new Response('<html></html>', { headers: { 'content-type': 'text/html' } })), detail: 'content_type' },
    ];
    for (const { fetcher, detail } of cases) {
      await expect(new CompanySsoClient(fetcher).verify('synthetic', checkUrl, config)).rejects.toMatchObject({ status: 503, detail, message: 'SSO service is unavailable' });
    }
  });

  it('times out without exposing the request URL', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('synthetic secret URL')));
    }));
    await expect(new CompanySsoClient(fetcher).verify('synthetic', checkUrl, { ...config, timeoutMs: 5 })).rejects.toMatchObject({ status: 503 });
  });
});
