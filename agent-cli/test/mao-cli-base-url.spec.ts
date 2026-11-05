import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * mao-cli 不再内置默认站点地址：未设置时应报错并给出设置指引，
 * 不再静默回落到开源示例域名；logout 仍应可用（仅本地清理）。
 */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'skills', 'mao-cli', 'lib', 'args.js'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('未找到仓库根目录（skills/mao-cli）');
}

const root = findRepoRoot();
const req = createRequire(path.join(root, 'noop.js'));
const httpPath = path.join(root, 'skills', 'mao-cli', 'lib', 'http.js');
const authStorePath = path.join(root, 'skills', 'mao-cli', 'lib', 'auth-store.js');
const authCommandPath = path.join(root, 'skills', 'mao-cli', 'lib', 'commands', 'auth.js');

/** auth-store 的路径在模块加载时绑定 os.homedir()，测试换 HOME 后必须重载。 */
const RELOAD_FILES = [httpPath, authStorePath, authCommandPath];

const envKeys = ['HOME', 'USERPROFILE', 'MAO_BASE_URL', 'MAO_USER_BASE_URL', 'MAO_ADMIN_BASE_URL'] as const;
let saved: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};
let home = '';

beforeEach(() => {
  saved = {};
  for (const k of envKeys) saved[k] = process.env[k];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-cli-baseurl-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.MAO_BASE_URL;
  delete process.env.MAO_USER_BASE_URL;
  delete process.env.MAO_ADMIN_BASE_URL;
});

afterEach(() => {
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function load<T>(file: string): T {
  for (const f of RELOAD_FILES) delete req.cache[f];
  return req(file) as T;
}

type HttpModule = {
  BASE_URL_SETUP_HINT: string;
  normalizeCliBaseUrl: (raw: string) => string;
  hasConfiguredBaseUrl: (cliBaseUrl?: string) => boolean;
  resolveBaseUrl: (cliBaseUrl?: string) => string;
  get: (ctx: Record<string, unknown>, apiPath: string) => Promise<unknown>;
};

describe('mao-cli 站点地址不再内置默认', () => {
  it('throws the setup hint when nothing is configured', () => {
    const http = load<HttpModule>(httpPath);
    expect(http.hasConfiguredBaseUrl()).toBe(false);
    expect(() => http.resolveBaseUrl()).toThrow(/未配置站点地址/);
    expect(http.BASE_URL_SETUP_HINT).toContain('MAO_BASE_URL');
  });

  it('reads MAO_BASE_URL and normalizes to /api/v1', () => {
    process.env.MAO_BASE_URL = 'https://mao.example.com';
    const http = load<HttpModule>(httpPath);
    expect(http.hasConfiguredBaseUrl()).toBe(true);
    expect(http.resolveBaseUrl()).toBe('https://mao.example.com/api/v1');
  });

  it('lets --base-url win over env and accepts /api and /api/v1 forms', () => {
    process.env.MAO_BASE_URL = 'https://env.example.com';
    const http = load<HttpModule>(httpPath);
    expect(http.resolveBaseUrl('https://cli.example.com/api')).toBe('https://cli.example.com/api/v1');
    expect(http.resolveBaseUrl('http://10.0.0.1:9080/api/v1/')).toBe('http://10.0.0.1:9080/api/v1');
  });

  it('rejects requests instead of falling back to a default domain', async () => {
    const http = load<HttpModule>(httpPath);
    await expect(http.get({}, '/users/me')).rejects.toThrow(/未配置站点地址/);
  });

  it('logout still clears the local auth cache when nothing is configured', async () => {
    fs.mkdirSync(path.join(home, '.mao'), { recursive: true });
    fs.writeFileSync(path.join(home, '.mao', 'auth.json'), JSON.stringify({ accessToken: 'stale' }));
    const auth = load<{ handle: (ctx: Record<string, unknown>) => Promise<void> }>(authCommandPath);
    await expect(
      auth.handle({
        subcommand: 'logout',
        flags: {},
        globals: { baseUrl: undefined, token: undefined, timeoutMs: undefined, json: false, raw: false },
      }),
    ).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(home, '.mao', 'auth.json'))).toBe(false);
  });
});
