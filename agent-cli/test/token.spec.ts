import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginVO } from '../src/rest/types';

/**
 * auth-store 在模块加载时把 ~/.mao 绑定到 os.homedir()，
 * 所以每个用例换一个临时 HOME 并重新导入模块。
 */
let home = '';
const envKeys = [
  'HOME',
  'USERPROFILE',
  'MAO_TOKEN',
  'MAO_ADMIN_TOKEN',
  'MAO_USER_TOKEN',
  'MAO_REFRESH_TOKEN',
  'MAO_ADMIN_REFRESH_TOKEN',
  'MAO_USER_REFRESH_TOKEN',
] as const;
let saved: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

beforeEach(() => {
  saved = {};
  for (const k of envKeys) {
    saved[k] = process.env[k];
    if (k !== 'HOME' && k !== 'USERPROFILE') delete process.env[k];
  }
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-agent-tok-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  vi.resetModules();
});

afterEach(() => {
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

async function tokenMod() {
  return import('../src/auth/token');
}

/** 造一个只带 exp 的 JWT（签名部分无所谓，代码只解 payload）。 */
function jwt(expMs: number): string {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ sub: '1', exp: Math.floor(expMs / 1000) })).toString('base64url');
  return `${head}.${body}.sig`;
}

function writeAuth(record: Record<string, unknown>): void {
  const dir = path.join(home, '.mao');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(record));
}

function loginVo(over: Partial<LoginVO> = {}): LoginVO {
  return {
    accessToken: 'fresh-access',
    refreshToken: 'fresh-refresh',
    expiresIn: 7200,
    user: { id: 1, username: 'tester' },
    ...over,
  };
}

describe('decodeJwtExpMs', () => {
  it('reads exp from the payload', async () => {
    const { decodeJwtExpMs } = await tokenMod();
    const exp = Date.now() + 3600_000;
    const got = decodeJwtExpMs(jwt(exp));
    expect(got).not.toBeNull();
    // exp 只有秒级精度
    expect(Math.abs((got as number) - exp)).toBeLessThan(1000);
  });

  it('returns null for opaque tokens', async () => {
    const { decodeJwtExpMs } = await tokenMod();
    expect(decodeJwtExpMs('not-a-jwt')).toBeNull();
  });

  it('returns null when the payload is not JSON', async () => {
    const { decodeJwtExpMs } = await tokenMod();
    expect(decodeJwtExpMs('a.@@@@.c')).toBeNull();
  });

  it('returns null when exp is missing or not a number', async () => {
    const { decodeJwtExpMs } = await tokenMod();
    const body = Buffer.from(JSON.stringify({ sub: '1', exp: 'soon' })).toString('base64url');
    expect(decodeJwtExpMs(`h.${body}.s`)).toBeNull();
    const noExp = Buffer.from(JSON.stringify({ sub: '1' })).toString('base64url');
    expect(decodeJwtExpMs(`h.${noExp}.s`)).toBeNull();
  });
});

describe('remainingMs', () => {
  it('is null without a token', async () => {
    const { remainingMs } = await tokenMod();
    expect(remainingMs(null)).toBeNull();
  });

  it('prefers the JWT exp', async () => {
    const { remainingMs } = await tokenMod();
    const left = remainingMs(jwt(Date.now() + 600_000), new Date(0).toISOString(), 1);
    expect(left).not.toBeNull();
    expect(left as number).toBeGreaterThan(590_000);
    expect(left as number).toBeLessThanOrEqual(600_000);
  });

  it('falls back to savedAt + expiresIn for opaque tokens', async () => {
    const { remainingMs } = await tokenMod();
    const savedAt = new Date(Date.now() - 60_000).toISOString();
    const left = remainingMs('opaque', savedAt, 3600) as number;
    expect(left).toBeGreaterThan(3_530_000);
    expect(left).toBeLessThanOrEqual(3_540_000);
  });

  it('is null when the fallback inputs are unusable', async () => {
    const { remainingMs } = await tokenMod();
    expect(remainingMs('opaque')).toBeNull();
    expect(remainingMs('opaque', 'not-a-date', 3600)).toBeNull();
    expect(remainingMs('opaque', new Date().toISOString(), null)).toBeNull();
  });

  it('goes negative for an expired token', async () => {
    const { remainingMs } = await tokenMod();
    expect(remainingMs(jwt(Date.now() - 10_000)) as number).toBeLessThan(0);
  });
});

describe('needsRefresh', () => {
  it('is true inside the 5 minute skew', async () => {
    const { needsRefresh } = await tokenMod();
    expect(needsRefresh(jwt(Date.now() + 60_000))).toBe(true);
  });

  it('is false with plenty of time left', async () => {
    const { needsRefresh } = await tokenMod();
    expect(needsRefresh(jwt(Date.now() + 3600_000))).toBe(false);
  });

  it('is false when the deadline is unknown', async () => {
    const { needsRefresh } = await tokenMod();
    expect(needsRefresh('opaque')).toBe(false);
    expect(needsRefresh(null)).toBe(false);
  });
});

describe('formatRemaining', () => {
  it('renders the coarse buckets', async () => {
    const { formatRemaining } = await tokenMod();
    expect(formatRemaining(null)).toBe('未知');
    expect(formatRemaining(0)).toBe('已过期');
    expect(formatRemaining(-1)).toBe('已过期');
    expect(formatRemaining(42_000)).toBe('42 秒');
    expect(formatRemaining(9 * 60_000)).toBe('9 分钟');
    expect(formatRemaining((2 * 60 + 3) * 60_000)).toBe('2 小时 3 分钟');
  });
});

describe('currentTokenSource', () => {
  it('marks a CLI token', async () => {
    const { currentTokenSource } = await tokenMod();
    const src = currentTokenSource('cli-token');
    expect(src).toMatchObject({ accessToken: 'cli-token', fromCli: true, fromEnv: false });
  });

  it('marks an env token', async () => {
    process.env.MAO_TOKEN = 'env-token';
    process.env.MAO_REFRESH_TOKEN = 'env-refresh';
    const { currentTokenSource } = await tokenMod();
    expect(currentTokenSource()).toMatchObject({
      accessToken: 'env-token',
      refreshToken: 'env-refresh',
      fromEnv: true,
      fromCli: false,
    });
  });

  it('falls back to the persisted auth file', async () => {
    writeAuth({ accessToken: 'file-access', refreshToken: 'file-refresh' });
    const { currentTokenSource } = await tokenMod();
    expect(currentTokenSource()).toMatchObject({
      accessToken: 'file-access',
      refreshToken: 'file-refresh',
      fromEnv: false,
      fromCli: false,
    });
  });
});

describe('createTokenResolver', () => {
  it('never refreshes a CLI token', async () => {
    const { createTokenResolver } = await tokenMod();
    const refresh = vi.fn(async (_refreshToken: string): Promise<LoginVO> => loginVo());
    const r = createTokenResolver({ cliToken: 'cli-token', refresh });
    await expect(r.getAccessToken()).resolves.toBe('cli-token');
    await expect(r.onUnauthorized()).resolves.toBe('cli-token');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('never refreshes an env token', async () => {
    process.env.MAO_TOKEN = 'env-token';
    const { createTokenResolver } = await tokenMod();
    const refresh = vi.fn(async (_refreshToken: string): Promise<LoginVO> => loginVo());
    const r = createTokenResolver({ refresh });
    await expect(r.getAccessToken()).resolves.toBe('env-token');
    await expect(r.onUnauthorized()).resolves.toBe('env-token');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('reuses a still-valid persisted token', async () => {
    writeAuth({
      accessToken: jwt(Date.now() + 3600_000),
      refreshToken: 'file-refresh',
      savedAt: new Date().toISOString(),
    });
    const { createTokenResolver } = await tokenMod();
    const refresh = vi.fn(async (_refreshToken: string): Promise<LoginVO> => loginVo());
    const r = createTokenResolver({ refresh });
    await expect(r.getAccessToken()).resolves.toContain('.');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes and persists when the token is about to expire', async () => {
    writeAuth({
      accessToken: jwt(Date.now() + 30_000),
      refreshToken: 'file-refresh',
      savedAt: new Date().toISOString(),
    });
    const { createTokenResolver } = await tokenMod();
    const { loadAuth } = await import('../src/auth/auth-store');
    const refresh = vi.fn(async () => loginVo());
    const r = createTokenResolver({ refresh });
    await expect(r.getAccessToken()).resolves.toBe('fresh-access');
    expect(refresh).toHaveBeenCalledWith('file-refresh');
    expect(loadAuth()).toMatchObject({ accessToken: 'fresh-access', refreshToken: 'fresh-refresh' });
  });

  it('keeps the old refresh token when the server omits one', async () => {
    writeAuth({ accessToken: jwt(Date.now() + 30_000), refreshToken: 'file-refresh' });
    const { createTokenResolver } = await tokenMod();
    const { loadAuth } = await import('../src/auth/auth-store');
    const r = createTokenResolver({ refresh: async () => loginVo({ refreshToken: '' }) });
    await r.getAccessToken();
    expect(loadAuth()).toMatchObject({ refreshToken: 'file-refresh' });
  });

  it('forces a refresh on 401 even when the token still looks fresh', async () => {
    writeAuth({ accessToken: jwt(Date.now() + 3600_000), refreshToken: 'file-refresh' });
    const { createTokenResolver } = await tokenMod();
    const refresh = vi.fn(async () => loginVo());
    const r = createTokenResolver({ refresh });
    await expect(r.onUnauthorized()).resolves.toBe('fresh-access');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('returns the stale token when there is nothing to refresh with', async () => {
    writeAuth({ accessToken: 'stale-access', refreshToken: null });
    const { createTokenResolver } = await tokenMod();
    const refresh = vi.fn(async (_refreshToken: string): Promise<LoginVO> => loginVo());
    const r = createTokenResolver({ refresh });
    await expect(r.onUnauthorized()).resolves.toBe('stale-access');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('returns null when there is no auth at all', async () => {
    const { createTokenResolver } = await tokenMod();
    const r = createTokenResolver({ refresh: async () => loginVo() });
    await expect(r.getAccessToken()).resolves.toBeNull();
  });

  it('refreshes with the env refresh token when only that is set', async () => {
    process.env.MAO_REFRESH_TOKEN = 'env-refresh';
    writeAuth({ accessToken: jwt(Date.now() + 30_000), refreshToken: 'file-refresh' });
    const { createTokenResolver } = await tokenMod();
    const { loadAuth } = await import('../src/auth/auth-store');
    const refresh = vi.fn(async () => loginVo());
    const r = createTokenResolver({ refresh });
    // MAO_TOKEN 未设置，所以 access token 仍来自文件，会走刷新分支并允许落盘
    await expect(r.getAccessToken()).resolves.toBe('fresh-access');
    expect(refresh).toHaveBeenCalledWith('env-refresh');
    expect(loadAuth()).toMatchObject({ refreshToken: 'fresh-refresh' });
  });
});
