import { describe, expect, it, vi } from 'vitest';
import { HttpApiExecutor, validateArguments } from './http-api-executor.js';
import type { ResolvedHttpTool, UserToolParam } from '../../../user-tool/types.js';

function tool(overrides: Partial<ResolvedHttpTool> = {}): ResolvedHttpTool {
  return {
    name: 'weather',
    displayName: '天气查询',
    method: 'GET',
    url: 'https://api.example.com/v1/weather',
    headers: {},
    bodyTemplate: null,
    timeoutMs: 15000,
    ...overrides,
  };
}

function param(overrides: Partial<UserToolParam> = {}): UserToolParam {
  return { toolId: 1, name: 'city', label: '城市', type: 'string', required: 1, defaultValue: null, sortOrder: 0, ...overrides };
}

/** 构造可注入 fetch / DNS 的执行内核。默认 DNS 把主机名解析到公网地址。 */
function makeExecutor(options: {
  fetchImpl?: typeof fetch;
  resolveIps?: (hostname: string) => Promise<string[]>;
  allowlist?: string[];
  allowlistThrows?: boolean;
} = {}) {
  const allowlistProvider = options.allowlistThrows
    ? vi.fn(async () => { throw new Error('settings down'); })
    : vi.fn(async () => options.allowlist ?? []);
  return {
    allowlistProvider,
    executor: new HttpApiExecutor({
      allowlistProvider,
      fetchImpl: options.fetchImpl ?? (async () => new Response('ok', { status: 200 })),
      resolveIps: options.resolveIps ?? (async () => ['93.184.216.34']),
      allowlistTtlMs: 60000,
    }),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('HttpApiExecutor SSRF guard', () => {
  it('allows public http/https targets', async () => {
    const { executor } = makeExecutor();
    const result = await executor.execute(tool(), [], '{}');
    expect(result).toEqual({ status: 200, body: 'ok', truncated: false, displayName: '天气查询' });
  });

  it('denies non-http protocols', async () => {
    const fetchImpl = vi.fn();
    const { executor } = makeExecutor({ fetchImpl });
    const result = await executor.execute(tool({ url: 'ftp://api.example.com/x' }), [], '{}');
    expect('error' in result && result.error).toContain('仅支持 http/https');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('denies loopback literals even with a matching allowlist entry', async () => {
    const fetchImpl = vi.fn();
    const { executor } = makeExecutor({ fetchImpl, allowlist: ['127.0.0.0/8'] });
    const result = await executor.execute(tool({ url: 'http://127.0.0.1:8080/admin' }), [], '{}');
    expect('error' in result && result.error).toContain('请求被拒绝');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('denies the cloud metadata IP and hostnames even with a matching allowlist entry', async () => {
    const fetchImpl = vi.fn();
    const { executor } = makeExecutor({ fetchImpl, allowlist: ['169.254.0.0/16'] });
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://metadata.google.internal/computeMetadata/v1/']) {
      const result = await executor.execute(tool({ url }), [], '{}');
      expect('error' in result && result.error, url).toContain('请求被拒绝');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('denies private hostnames unless every resolved IP hits the allowlist', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const denied = makeExecutor({ fetchImpl, resolveIps: async () => ['10.1.2.3'] });
    const deniedResult = await denied.executor.execute(tool({ url: 'http://intranet.example.com/api' }), [], '{}');
    expect('error' in deniedResult && deniedResult.error).toContain('请求被拒绝');

    const allowed = makeExecutor({ fetchImpl, resolveIps: async () => ['10.1.2.3'], allowlist: ['10.0.0.0/8'] });
    const allowedResult = await allowed.executor.execute(tool({ url: 'http://intranet.example.com/api' }), [], '{}');
    expect('error' in allowedResult).toBe(false);
    expect(allowed.allowlistProvider).toHaveBeenCalled();
  });

  it('denies when only some resolved IPs hit the allowlist (multi-A record)', async () => {
    // 主机名解析出多个地址时 fetch 连哪个由运行时择优：只放行命中项会让请求
    // 落到管理员未批准的网段，因此要求全部解析 IP 命中名单。
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const { executor } = makeExecutor({
      fetchImpl, resolveIps: async () => ['10.1.2.3', '192.168.1.5'], allowlist: ['10.0.0.0/8'],
    });
    const result = await executor.execute(tool({ url: 'http://mixed.example.com/api' }), [], '{}');
    expect('error' in result && result.error).toContain('请求被拒绝');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows when every resolved IP hits the allowlist across entries', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const { executor } = makeExecutor({
      fetchImpl,
      resolveIps: async () => ['10.1.2.3', '192.168.1.5'],
      allowlist: ['10.0.0.0/8', '192.168.1.0/24'],
    });
    const result = await executor.execute(tool({ url: 'http://mixed.example.com/api' }), [], '{}');
    expect('error' in result).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('denies public hostnames that resolve into private space (DNS rebinding shape)', async () => {
    const fetchImpl = vi.fn();
    const { executor } = makeExecutor({ fetchImpl, resolveIps: async () => ['192.168.0.9'] });
    const result = await executor.execute(tool({ url: 'https://evil.example.com/steal' }), [], '{}');
    expect('error' in result && result.error).toContain('请求被拒绝');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects IPv6 endpoints with a readable notice (P1: IPv4 only)', async () => {
    const fetchImpl = vi.fn();
    const { executor } = makeExecutor({ fetchImpl });
    const result = await executor.execute(tool({ url: 'http://[::1]:8080/x' }), [], '{}');
    expect('error' in result && result.error).toContain('IPv6');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats a failing settings lookup as an empty allowlist (fail closed)', async () => {
    const fetchImpl = vi.fn();
    const { executor, allowlistProvider } = makeExecutor({
      fetchImpl, resolveIps: async () => ['10.1.2.3'], allowlistThrows: true,
    });
    const result = await executor.execute(tool({ url: 'http://intranet.example.com/api' }), [], '{}');
    expect('error' in result && result.error).toContain('请求被拒绝');
    expect(allowlistProvider).toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('caches the allowlist for the TTL window', async () => {
    const { executor, allowlistProvider } = makeExecutor({ resolveIps: async () => ['10.1.2.3'], allowlist: ['10.0.0.0/8'] });
    await executor.execute(tool({ url: 'http://a.intranet.example.com/' }), [], '{}');
    await executor.execute(tool({ url: 'http://b.intranet.example.com/' }), [], '{}');
    expect(allowlistProvider).toHaveBeenCalledTimes(1);
  });
});

describe('HttpApiExecutor argument contract', () => {
  it('rejects non-object arguments JSON', async () => {
    const { executor } = makeExecutor();
    const result = await executor.execute(tool(), [], '[1,2]');
    expect('error' in result && result.error).toContain('参数必须是 JSON 对象');
  });

  it('rejects unknown argument keys and guides http_describe', async () => {
    const fetchImpl = vi.fn();
    const { executor } = makeExecutor({ fetchImpl });
    const result = await executor.execute(tool(), [param()], JSON.stringify({ city: 'SH', nope: 1 }));
    expect('error' in result && result.error).toContain('未定义的参数 nope');
    expect('error' in result && result.error).toContain('http_describe');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports missing required parameters', async () => {
    const fetchImpl = vi.fn();
    const { executor } = makeExecutor({ fetchImpl });
    const result = await executor.execute(tool(), [param()], '{}');
    expect('error' in result && result.error).toBe('缺少必填参数 city（城市）');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports type mismatches for number / boolean / string', async () => {
    const { executor } = makeExecutor();
    const params = [
      param({ name: 'limit', label: '条数', type: 'number' }),
      param({ name: 'verbose', label: '详细', type: 'boolean', required: 0 }),
      param({ name: 'note', label: '备注', type: 'string', required: 0 }),
    ];
    const badNumber = await executor.execute(tool(), params, JSON.stringify({ limit: 'ten' }));
    expect('error' in badNumber && badNumber.error).toBe('参数 limit 应为 number');
    const badBool = await executor.execute(tool(), params, JSON.stringify({ limit: 1, verbose: 'yes' }));
    expect('error' in badBool && badBool.error).toBe('参数 verbose 应为 boolean（true/false）');
    const badString = await executor.execute(tool(), params, JSON.stringify({ limit: 1, note: { a: 1 } }));
    expect('error' in badString && badString.error).toBe('参数 note 应为 string');
  });

  it('accepts optional parameters omitted and defaults applied later', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const { executor } = makeExecutor({ fetchImpl });
    const result = await executor.execute(tool(), [param({ required: 0 })], '{}');
    expect('error' in result).toBe(false);
  });
});

describe('HttpApiExecutor request shaping', () => {
  it('renders the body template with argument values, falling back to defaults', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const { executor } = makeExecutor({ fetchImpl });
    await executor.execute(
      tool({ method: 'POST', bodyTemplate: '{"city":"{{city}}","unit":"{{unit}}"}' }),
      [param(), param({ name: 'unit', label: '单位', required: 0, defaultValue: 'c' })],
      JSON.stringify({ city: '上海' }),
    );
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe('{"city":"上海","unit":"c"}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('does not recursively expand placeholders inside argument values', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const { executor } = makeExecutor({ fetchImpl });
    await executor.execute(
      tool({ method: 'POST', bodyTemplate: '{"q":"{{q}}"}' }),
      [param({ name: 'q', label: '关键词' })],
      JSON.stringify({ q: '{{q}}' }),
    );
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe('{"q":"{{q}}"}');
  });

  it('lets user headers override defaults and keeps sensitive values as provided', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const { executor } = makeExecutor({ fetchImpl });
    await executor.execute(
      tool({ headers: { 'User-Agent': 'my-agent/1.0', Authorization: 'Bearer t' } }),
      [],
      '{}',
    );
    const headers = (fetchImpl.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('my-agent/1.0');
    expect(headers['Authorization']).toBe('Bearer t');
    expect(headers['Accept']).toContain('application/json');
  });

  it('drops the body for GET even when a template exists', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const { executor } = makeExecutor({ fetchImpl });
    await executor.execute(tool({ bodyTemplate: '{"a":1}' }), [], '{}');
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });
});

describe('HttpApiExecutor URL template rendering', () => {
  it('substitutes query-string placeholders with percent-encoded argument values', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const { executor } = makeExecutor({ fetchImpl });
    await executor.execute(
      tool({ url: 'https://api.example.com/v1/weather?city={{city}}&days={{days}}' }),
      [param(), param({ name: 'days', label: '天数', type: 'number', required: 0, defaultValue: 3 })],
      JSON.stringify({ city: '上海' }),
    );
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toBe('https://api.example.com/v1/weather?city=%E4%B8%8A%E6%B5%B7&days=3');
  });

  it('substitutes path placeholders and falls back to defaults', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const { executor } = makeExecutor({ fetchImpl });
    await executor.execute(
      tool({ url: 'https://api.example.com/v1/tickets/{{id}}' }),
      [param({ name: 'id', label: '工单号', type: 'number', required: 0, defaultValue: 1001 })],
      '{}',
    );
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.example.com/v1/tickets/1001');
  });

  it('percent-encodes structural characters so argument values cannot reshape the URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const { executor } = makeExecutor({ fetchImpl });
    await executor.execute(
      tool({ url: 'https://api.example.com/v1/weather?city={{city}}' }),
      [param()],
      JSON.stringify({ city: 'x&admin=1#frag' }),
    );
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.example.com/v1/weather?city=x%26admin%3D1%23frag');
  });

  it('leaves undeclared placeholders untouched so URL validation can reject them', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const { executor } = makeExecutor({ fetchImpl });
    const result = await executor.execute(
      tool({ url: 'https://api.example.com/v1/weather?city={{city}}' }),
      [],
      '{}',
    );
    // 未声明占位符原样保留：URL 仍可构造并发起请求（后端不替用户猜参数）
    expect('status' in result).toBe(true);
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.example.com/v1/weather?city={{city}}');
  });

  it('does not recursively expand placeholders inside argument values in the URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const { executor } = makeExecutor({ fetchImpl });
    await executor.execute(
      tool({ url: 'https://api.example.com/v1/weather?city={{city}}' }),
      [param()],
      JSON.stringify({ city: '{{city}}' }),
    );
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.example.com/v1/weather?city=%7B%7Bcity%7D%7D');
  });
});

describe('HttpApiExecutor redirects', () => {
  it('follows up to two redirects, re-checking SSRF on each hop', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://api.example.com/v2' } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://api.example.com/v3' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const { executor } = makeExecutor({ fetchImpl });
    const result = await executor.execute(tool(), [], '{}');
    expect('error' in result).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('stops after two redirects', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://api.example.com/next' } }));
    const { executor } = makeExecutor({ fetchImpl });
    const result = await executor.execute(tool(), [], '{}');
    expect('error' in result && result.error).toContain('重定向次数过多');
  });

  it('degrades POST to GET on 303 and drops the body', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 303, headers: { location: 'https://api.example.com/done' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const { executor } = makeExecutor({ fetchImpl });
    await executor.execute(tool({ method: 'POST', bodyTemplate: '{"a":1}' }), [], '{}');
    const second = fetchImpl.mock.calls[1]![1] as RequestInit;
    expect(second.method).toBe('GET');
    expect(second.body).toBeUndefined();
    expect((second.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('denies a redirect that targets loopback', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9080/internal' } }));
    const { executor } = makeExecutor({ fetchImpl });
    const result = await executor.execute(tool(), [], '{}');
    expect('error' in result && result.error).toContain('请求被拒绝');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('HttpApiExecutor result normalization', () => {
  it('returns HTTP status with a body snippet for non-2xx', async () => {
    const { executor } = makeExecutor({
      fetchImpl: async () => new Response('boom details', { status: 503, headers: { 'content-type': 'text/plain' } }),
    });
    const result = await executor.execute(tool(), [], '{}');
    expect(result).toEqual({ error: 'HTTP 503：boom details', displayName: '天气查询' });
  });

  it('truncates the error snippet to 500 characters', async () => {
    const { executor } = makeExecutor({
      fetchImpl: async () => new Response('x'.repeat(2000), { status: 500, headers: { 'content-type': 'text/plain' } }),
    });
    const result = await executor.execute(tool(), [], '{}');
    expect('error' in result && result.error.length).toBeLessThanOrEqual(520);
    expect('error' in result && result.error.startsWith('HTTP 500：')).toBe(true);
  });

  it('returns a notice instead of garbled text for binary responses', async () => {
    const { executor } = makeExecutor({
      fetchImpl: async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200, headers: { 'content-type': 'image/png' },
      }),
    });
    const result = await executor.execute(tool(), [], '{}');
    expect(result).toMatchObject({ status: 200, body: '', truncated: false });
    expect('notice' in result && result.notice).toContain('image/png');
  });

  it('truncates large textual responses at 64KB', async () => {
    const { executor } = makeExecutor({
      fetchImpl: async () => new Response('y'.repeat(70 * 1024), { status: 200, headers: { 'content-type': 'text/plain' } }),
    });
    const result = await executor.execute(tool(), [], '{}');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(result.body, 'utf8')).toBe(64 * 1024);
    }
  });

  it('normalizes timeout / DNS / connection errors without leaking the URL', async () => {
    const timeout = makeExecutor({
      fetchImpl: async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }); },
    });
    const timeoutResult = await timeout.executor.execute(tool({ url: 'https://api.example.com/slow' }), [], '{}');
    expect('error' in timeoutResult && timeoutResult.error).toContain('请求超时');

    const dnsFail = makeExecutor({
      fetchImpl: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { cause: { code: 'ENOTFOUND' } }); },
    });
    const dnsResult = await dnsFail.executor.execute(tool({ url: 'https://api.example.com/slow' }), [], '{}');
    expect('error' in dnsResult && dnsResult.error).toBe('请求失败：无法解析目标主机名');
  });

  it('rejects a malformed tool URL before any network call', async () => {
    const fetchImpl = vi.fn();
    const { executor } = makeExecutor({ fetchImpl });
    const result = await executor.execute(tool({ url: 'not-a-url' }), [], '{}');
    expect('error' in result && result.error).toBe('URL 格式不正确');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('validateArguments', () => {
  it('accepts empty params and empty args', () => {
    expect(validateArguments([], {})).toBeNull();
  });

  it('accepts declared optional args with correct types', () => {
    const params = [param({ required: 0 }), param({ name: 'n', label: 'N', type: 'number', required: 0 })];
    expect(validateArguments(params, { city: 'SH', n: 3 })).toBeNull();
  });

  it('rejects undefined keys, missing required and bad types', () => {
    const params = [param()];
    expect(validateArguments(params, { extra: 1 })).toContain('未定义的参数');
    expect(validateArguments(params, {})).toBe('缺少必填参数 city（城市）');
    expect(validateArguments(params, { city: { a: 1 } })).toBe('参数 city 应为 string');
  });
});
