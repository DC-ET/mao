import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * config-store / input-history 的路径在模块加载时就绑定到 os.homedir()，
 * 因此每个用例都换一个临时 HOME 并重新导入模块，避免碰到真实用户配置。
 */
let home = '';
const envKeys = [
  'HOME',
  'USERPROFILE',
  'MAO_AGENT_BASE_URL',
  'MAO_AGENT_OUTPUT_FORMAT',
  'MAO_AGENT_VERBOSE',
] as const;
let saved: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

beforeEach(() => {
  saved = {};
  for (const k of envKeys) saved[k] = process.env[k];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-agent-cfg-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.MAO_AGENT_BASE_URL;
  delete process.env.MAO_AGENT_OUTPUT_FORMAT;
  delete process.env.MAO_AGENT_VERBOSE;
  vi.resetModules();
});

afterEach(() => {
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

async function store() {
  return import('../src/config/config-store');
}

function writeUserConfig(content: unknown): void {
  const dir = path.join(home, '.mao', 'agent-cli');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(content));
}

describe('resolveConfig precedence', () => {
  it('falls back to the built-in default', async () => {
    const { resolveConfig } = await store();
    const { DEFAULT_BASE_URL } = await import('../src/args');
    const cfg = resolveConfig({});
    expect(cfg.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(cfg.permissionLevel).toBe('READ_WRITE');
    expect(cfg.outputFormat).toBe('text');
    expect(cfg.ui).toEqual({
      verboseTools: false,
      showTurnDividers: true,
      asciiOnly: false,
      queuedInput: true,
    });
  });

  it('reads the user config file', async () => {
    writeUserConfig({
      baseUrl: 'https://user.example/api',
      permissionLevel: 'FULL',
      outputFormat: 'json',
      lastSessionId: 42,
      defaultAgentId: 3,
      ui: { verboseTools: true, showTurnDividers: false, asciiOnly: true, queuedInput: false },
    });
    const { resolveConfig } = await store();
    const cfg = resolveConfig({});
    expect(cfg.baseUrl).toBe('https://user.example/api');
    expect(cfg.permissionLevel).toBe('FULL');
    expect(cfg.outputFormat).toBe('json');
    expect(cfg.lastSessionId).toBe(42);
    expect(cfg.defaultAgentId).toBe(3);
    expect(cfg.ui).toEqual({
      verboseTools: true,
      showTurnDividers: false,
      asciiOnly: true,
      queuedInput: false,
    });
  });

  it('lets the environment override the user config', async () => {
    writeUserConfig({ baseUrl: 'https://user.example/api', outputFormat: 'json' });
    process.env.MAO_AGENT_BASE_URL = 'https://env.example/api';
    process.env.MAO_AGENT_OUTPUT_FORMAT = 'stream-json';
    process.env.MAO_AGENT_VERBOSE = '1';
    const { resolveConfig } = await store();
    const cfg = resolveConfig({});
    expect(cfg.baseUrl).toBe('https://env.example/api');
    expect(cfg.outputFormat).toBe('stream-json');
    expect(cfg.ui.verboseTools).toBe(true);
  });

  it('lets CLI flags win over everything', async () => {
    writeUserConfig({ baseUrl: 'https://user.example/api', ui: { asciiOnly: false, queuedInput: true } });
    process.env.MAO_AGENT_BASE_URL = 'https://env.example/api';
    const { resolveConfig } = await store();
    const cfg = resolveConfig({
      baseUrl: 'https://cli.example/api',
      permissionLevel: 'READ_ONLY',
      outputFormat: 'json',
      asciiOnly: true,
      queuedInput: false,
    });
    expect(cfg.baseUrl).toBe('https://cli.example/api');
    expect(cfg.permissionLevel).toBe('READ_ONLY');
    expect(cfg.outputFormat).toBe('json');
    expect(cfg.ui.asciiOnly).toBe(true);
    expect(cfg.ui.queuedInput).toBe(false);
  });

  it('ignores a corrupt config file instead of crashing', async () => {
    const dir = path.join(home, '.mao', 'agent-cli');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');
    const { resolveConfig } = await store();
    expect(() => resolveConfig({})).not.toThrow();
  });
});

describe('saveUserConfig', () => {
  it('merges patches and keeps the file owner-only', async () => {
    const { saveUserConfig, loadUserConfig, CONFIG_FILE } = await store();
    saveUserConfig({ baseUrl: 'https://a/api' });
    saveUserConfig({ lastSessionId: 9 });
    expect(loadUserConfig()).toMatchObject({ baseUrl: 'https://a/api', lastSessionId: 9 });
    const mode = fs.statSync(CONFIG_FILE).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('rememberLastSession only touches lastSessionId', async () => {
    const { saveUserConfig, rememberLastSession, loadUserConfig } = await store();
    saveUserConfig({ baseUrl: 'https://a/api' });
    rememberLastSession(77);
    expect(loadUserConfig()).toMatchObject({ baseUrl: 'https://a/api', lastSessionId: 77 });
  });
});

describe('findProjectConfig', () => {
  it('walks up to the git root and stops there', async () => {
    const root = path.join(home, 'proj');
    const nested = path.join(root, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, '.mao'), { recursive: true });
    fs.writeFileSync(path.join(root, '.mao', 'agent.json'), JSON.stringify({ defaultAgentId: 5 }));
    const { findProjectConfig } = await store();
    expect(findProjectConfig(nested)?.defaultAgentId).toBe(5);
  });

  it('returns null when there is no project config', async () => {
    const dir = path.join(home, 'empty');
    fs.mkdirSync(dir, { recursive: true });
    const { findProjectConfig } = await store();
    expect(findProjectConfig(dir)).toBeNull();
  });

  it('sits between env and the user config in precedence', async () => {
    const root = path.join(home, 'proj2');
    fs.mkdirSync(path.join(root, '.mao'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.mao', 'agent.json'),
      JSON.stringify({ baseUrl: 'https://project/api', permissionLevel: 'SMART' }),
    );
    writeUserConfig({ baseUrl: 'https://user/api', permissionLevel: 'FULL' });
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      const { resolveConfig } = await store();
      const cfg = resolveConfig({});
      expect(cfg.baseUrl).toBe('https://project/api');
      expect(cfg.permissionLevel).toBe('SMART');
    } finally {
      cwd.mockRestore();
    }
  });
});

describe('cleanupRuntimeDir', () => {
  it('keeps the newest sessions and drops the overflow', async () => {
    const { RUNTIME_DIR, cleanupRuntimeDir } = await store();
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    for (let i = 0; i < 25; i++) {
      const dir = path.join(RUNTIME_DIR, `s${i}`);
      fs.mkdirSync(dir);
      const t = new Date(Date.now() - i * 60_000);
      fs.utimesSync(dir, t, t);
    }
    cleanupRuntimeDir();
    const left = fs.readdirSync(RUNTIME_DIR);
    expect(left).toHaveLength(20);
    expect(left).toContain('s0');
    expect(left).not.toContain('s24');
  });

  it('drops directories older than the age limit', async () => {
    const { RUNTIME_DIR, cleanupRuntimeDir } = await store();
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const old = path.join(RUNTIME_DIR, 'stale');
    fs.mkdirSync(old);
    const t = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    fs.utimesSync(old, t, t);
    cleanupRuntimeDir();
    expect(fs.existsSync(old)).toBe(false);
  });

  it('is a no-op when the runtime dir does not exist', async () => {
    const { cleanupRuntimeDir } = await store();
    expect(() => cleanupRuntimeDir()).not.toThrow();
  });
});

describe('input history', () => {
  it('round-trips single and multi-line entries', async () => {
    const { appendInputHistory, loadInputHistory, HISTORY_FILE } = await import('../src/config/input-history');
    expect(loadInputHistory()).toEqual([]);
    appendInputHistory('第一条');
    appendInputHistory('多行\n第二行');
    expect(loadInputHistory()).toEqual(['第一条', '多行\n第二行']);
    expect(fs.statSync(HISTORY_FILE).mode & 0o777).toBe(0o600);
  });

  it('skips blank entries', async () => {
    const { appendInputHistory, loadInputHistory } = await import('../src/config/input-history');
    appendInputHistory('   ');
    appendInputHistory('');
    expect(loadInputHistory()).toEqual([]);
  });

  it('reads legacy bare-text lines', async () => {
    const dir = path.join(home, '.mao', 'agent-cli');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'history'), 'legacy line\n"json line"\n');
    const { loadInputHistory } = await import('../src/config/input-history');
    expect(loadInputHistory()).toEqual(['legacy line', 'json line']);
  });

  it('returns only the last N entries', async () => {
    const { appendInputHistory, loadInputHistory } = await import('../src/config/input-history');
    for (let i = 0; i < 10; i++) appendInputHistory(`e${i}`);
    expect(loadInputHistory(3)).toEqual(['e7', 'e8', 'e9']);
  });

  it('trims the file once it grows past twice the cap', async () => {
    const { appendInputHistory, HISTORY_FILE } = await import('../src/config/input-history');
    for (let i = 0; i < 12; i++) appendInputHistory(`e${i}`, 5);
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines[lines.length - 1]).toBe(JSON.stringify('e11'));
  });
});
