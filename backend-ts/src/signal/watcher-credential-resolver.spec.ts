import { describe, expect, it, vi } from 'vitest';
import {
  createWatcherCredentialResolver,
  resolveProbeHeaders,
  type WatcherCredentialResolver,
} from './watcher-credential-resolver.js';

function fakeResolver(overrides: Partial<Record<'MAO_TOKEN' | 'ECP_TOKEN', string | null | Error>> = {}): WatcherCredentialResolver & { calls: Array<{ userId: number; kind: string }> } {
  const calls: Array<{ userId: number; kind: string }> = [];
  return {
    calls,
    async resolve(userId, kind) {
      calls.push({ userId, kind });
      const value = overrides[kind];
      if (value instanceof Error) throw value;
      return value ?? null;
    },
  } as never;
}

describe('resolveProbeHeaders（2026-11-06 凭据占位符方案 §5.1.2）', () => {
  it('headers 为 null / 无占位符时原样直通，不触碰 resolver（存量哨兵零开销）', async () => {
    const resolver = fakeResolver({ MAO_TOKEN: 'tok' });
    expect(await resolveProbeHeaders(null, 7, resolver)).toEqual({});
    const plain = { Accept: 'application/json', 'X-Trace': '1' };
    const out = await resolveProbeHeaders(plain, 7, resolver);
    expect(out).toEqual(plain);
    expect(out).not.toBe(plain);
    expect(resolver.calls).toEqual([]);
  });

  it('占位符替换为 resolver 返回值，其余头原样保留', async () => {
    const resolver = fakeResolver({ MAO_TOKEN: 'tok-123' });
    const out = await resolveProbeHeaders(
      { Authorization: 'Bearer {{MAO_TOKEN}}', Accept: 'json' },
      7,
      resolver,
    );
    expect(out).toEqual({ Authorization: 'Bearer tok-123', Accept: 'json' });
    expect(resolver.calls).toEqual([{ userId: 7, kind: 'MAO_TOKEN' }]);
  });

  it('跨头去重：两个头都用 {{MAO_TOKEN}} 只 resolve 一次，两处值一致（§8.9）', async () => {
    let issued = 0;
    const resolver: WatcherCredentialResolver = {
      async resolve() {
        issued += 1;
        return `tok-${issued}`;
      },
    };
    const out = await resolveProbeHeaders(
      { 'X-A': '{{MAO_TOKEN}}', 'X-B': 'Bearer {{MAO_TOKEN}}' },
      7,
      resolver,
    );
    expect(issued).toBe(1);
    expect(out).toEqual({ 'X-A': 'tok-1', 'X-B': 'Bearer tok-1' });
  });

  it('一个头里两个同种占位符也只 resolve 一次，替换后两处值一致（D8）', async () => {
    let issued = 0;
    const resolver: WatcherCredentialResolver = {
      async resolve() {
        issued += 1;
        return `tok-${issued}`;
      },
    };
    const out = await resolveProbeHeaders({ 'X-A': '{{MAO_TOKEN}} {{MAO_TOKEN}}' }, 7, resolver);
    expect(issued).toBe(1);
    expect(out).toEqual({ 'X-A': 'tok-1 tok-1' });
  });

  it('不同 kind 并发解析，互不影响', async () => {
    const resolver = fakeResolver({ MAO_TOKEN: 'mao-1', ECP_TOKEN: 'ecp-1' });
    const out = await resolveProbeHeaders(
      { 'X-A': '{{MAO_TOKEN}}', 'X-B': 'E {{ECP_TOKEN}}' },
      7,
      resolver,
    );
    expect(out).toEqual({ 'X-A': 'mao-1', 'X-B': 'E ecp-1' });
    expect(resolver.calls.map((c) => c.kind).sort()).toEqual(['ECP_TOKEN', 'MAO_TOKEN']);
  });

  it('kind 解析失败（null）→ 含该 kind 的整个头被丢弃，其余头保留（D2/D3）', async () => {
    const resolver = fakeResolver({ MAO_TOKEN: null, ECP_TOKEN: 'ecp-1' });
    const out = await resolveProbeHeaders(
      { Authorization: 'Bearer {{MAO_TOKEN}}', 'X-Ecp': '{{ECP_TOKEN}}', Accept: 'json' },
      7,
      resolver,
    );
    expect(out).toEqual({ 'X-Ecp': 'ecp-1', Accept: 'json' });
  });

  it('resolver 抛错与返回 null 同口径：丢头、不冒泡（§5.1.2 异常口径）', async () => {
    const resolver = fakeResolver({ MAO_TOKEN: new Error('db down') });
    const out = await resolveProbeHeaders({ Authorization: '{{MAO_TOKEN}}', Accept: 'json' }, 7, resolver);
    expect(out).toEqual({ Accept: 'json' });
  });

  it('混合多 kind 的头：MAO 成功 ECP 失败 → 整头丢弃（任一失败即丢头）', async () => {
    const resolver = fakeResolver({ MAO_TOKEN: 'mao-1', ECP_TOKEN: null });
    const out = await resolveProbeHeaders({ 'X-A': '{{MAO_TOKEN}} {{ECP_TOKEN}}' }, 7, resolver);
    expect(out).toEqual({});
  });

  it('resolver 未装配（缺省路径）：值原样直发（D6 的「缺省不解析」）', async () => {
    const headers = { Authorization: 'Bearer {{MAO_TOKEN}}', Accept: 'json' };
    expect(await resolveProbeHeaders(headers, 7, null)).toEqual(headers);
    expect(await resolveProbeHeaders(headers, 7, undefined)).toEqual(headers);
  });
});

describe('createWatcherCredentialResolver（生产签发/读取链）', () => {
  it('MAO_TOKEN：以 userId 查用户并用 username 签发 shell token', async () => {
    const generateShellToken = vi.fn(() => 'jwt-token');
    const findById = vi.fn(async () => ({ id: 7, username: 'alice' }));
    const resolver = createWatcherCredentialResolver({
      tokenIssuer: { generateShellToken },
      userLookup: { findById },
      ecpInjector: { injectForUser: vi.fn(async () => 'should-not-be-called') },
    });
    await expect(resolver.resolve(7, 'MAO_TOKEN')).resolves.toBe('jwt-token');
    expect(findById).toHaveBeenCalledWith(7);
    expect(generateShellToken).toHaveBeenCalledWith(7, 'alice');
  });

  it('MAO_TOKEN：用户不存在 / 用户名为空 → null（对齐 shell-session-tool 跳过口径）', async () => {
    const generateShellToken = vi.fn(() => 'jwt-token');
    const resolver = createWatcherCredentialResolver({
      tokenIssuer: { generateShellToken },
      userLookup: { findById: vi.fn(async () => null) },
      ecpInjector: { injectForUser: vi.fn(async () => null) },
    });
    await expect(resolver.resolve(7, 'MAO_TOKEN')).resolves.toBeNull();
    expect(generateShellToken).not.toHaveBeenCalled();

    const blank = createWatcherCredentialResolver({
      tokenIssuer: { generateShellToken },
      userLookup: { findById: vi.fn(async () => ({ id: 7, username: '   ' })) },
      ecpInjector: { injectForUser: vi.fn(async () => null) },
    });
    await expect(blank.resolve(7, 'MAO_TOKEN')).resolves.toBeNull();
    expect(generateShellToken).not.toHaveBeenCalled();
  });

  it('ECP_TOKEN：委托只读 injector.injectForUser（无票/过期等由 injector 返回 null）', async () => {
    const injectForUser = vi.fn(async (userId: number) => (userId === 7 ? 'ecp-token' : null));
    const resolver = createWatcherCredentialResolver({
      tokenIssuer: { generateShellToken: vi.fn() },
      userLookup: { findById: vi.fn(async () => null) },
      ecpInjector: { injectForUser },
    });
    await expect(resolver.resolve(7, 'ECP_TOKEN')).resolves.toBe('ecp-token');
    await expect(resolver.resolve(8, 'ECP_TOKEN')).resolves.toBeNull();
    expect(injectForUser).toHaveBeenCalledWith(7);
    expect(injectForUser).toHaveBeenCalledWith(8);
  });
});
