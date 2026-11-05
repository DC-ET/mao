import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * baseUrl 的解析在模块加载时绑定 os.homedir()（config-store 的 CONFIG_FILE），
 * 每个用例换一个临时 HOME 并重新导入模块，避免碰到真实用户配置。
 */
const envKeys = ['HOME', 'USERPROFILE', 'MAO_BASE_URL', 'MAO_TOKEN', 'MAO_REFRESH_TOKEN'] as const;
let saved: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};
let home = '';

beforeEach(() => {
  saved = {};
  for (const k of envKeys) saved[k] = process.env[k];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-agent-baseurl-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.MAO_BASE_URL;
  delete process.env.MAO_TOKEN;
  delete process.env.MAO_REFRESH_TOKEN;
  vi.resetModules();
});

afterEach(() => {
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

async function baseUrlModule() {
  return import('../src/config/base-url');
}

/** 捕获某个输出流写入的文本（按 chunk 拼接）。 */
function captureStream(stream: NodeJS.WriteStream): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(stream, 'write').mockImplementation(((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof stream.write);
  return { text: () => chunks.join(''), restore: () => spy.mockRestore() };
}

describe('parseSiteUrlInput', () => {
  it('accepts site roots and normalizes to /api', async () => {
    const { parseSiteUrlInput } = await baseUrlModule();
    expect(parseSiteUrlInput('https://mao.example.com')).toBe('https://mao.example.com/api');
    expect(parseSiteUrlInput('  http://10.0.0.1:8080  ')).toBe('http://10.0.0.1:8080/api');
    expect(parseSiteUrlInput('https://mao.example.com/api')).toBe('https://mao.example.com/api');
    expect(parseSiteUrlInput('https://mao.example.com/api/v1/')).toBe('https://mao.example.com/api');
  });

  it('rejects empty, protocol-less, non-http(s) and deep-path inputs', async () => {
    const { parseSiteUrlInput } = await baseUrlModule();
    expect(parseSiteUrlInput('')).toBeNull();
    expect(parseSiteUrlInput('mao.example.com')).toBeNull();
    expect(parseSiteUrlInput('ftp://mao.example.com')).toBeNull();
    expect(parseSiteUrlInput('https://mao.example.com/admin')).toBeNull();
    expect(parseSiteUrlInput('https://mao.example.com/api/v2')).toBeNull();
    expect(parseSiteUrlInput('https://mao.example.com?x=1')).toBeNull();
  });
});

describe('setupBaseUrlInteractive', () => {
  it('saves the trimmed input and returns the normalized baseUrl', async () => {
    const { setupBaseUrlInteractive } = await baseUrlModule();
    const savedPatch: Array<{ baseUrl: string }> = [];
    const out: string[] = [];
    const result = await setupBaseUrlInteractive({
      prompt: async () => '  https://mao.example.com/ ',
      save: (patch) => savedPatch.push(patch),
      out: (msg) => out.push(msg),
    });
    expect(result).toBe('https://mao.example.com/api');
    expect(savedPatch).toEqual([{ baseUrl: 'https://mao.example.com' }]);
    expect(out.join('')).toContain('已保存');
  });

  it('re-prompts on invalid input then succeeds', async () => {
    const { setupBaseUrlInteractive } = await baseUrlModule();
    const answers = ['mao.example.com', 'https://ok.example.com'];
    const savedPatch: Array<{ baseUrl: string }> = [];
    const out: string[] = [];
    const result = await setupBaseUrlInteractive({
      prompt: async () => answers.shift() as string,
      save: (patch) => savedPatch.push(patch),
      out: (msg) => out.push(msg),
    });
    expect(result).toBe('https://ok.example.com/api');
    expect(savedPatch).toEqual([{ baseUrl: 'https://ok.example.com' }]);
    expect(out.join('')).toContain('格式不正确');
  });

  it('treats an empty answer as cancel: prints hint, throws, saves nothing', async () => {
    const { setupBaseUrlInteractive } = await baseUrlModule();
    const savedPatch: Array<{ baseUrl: string }> = [];
    const out: string[] = [];
    await expect(
      setupBaseUrlInteractive({
        prompt: async () => '',
        save: (patch) => savedPatch.push(patch),
        out: (msg) => out.push(msg),
      }),
    ).rejects.toThrow('已取消');
    expect(savedPatch).toEqual([]);
    expect(out.join('')).toContain('未配置站点地址');
  });
});

describe('warnIfTransientBaseUrl', () => {
  it('warns when the address only came from --base-url / MAO_BASE_URL', async () => {
    const { warnIfTransientBaseUrl } = await baseUrlModule();
    const stderr = captureStream(process.stderr);
    try {
      warnIfTransientBaseUrl(true);
    } finally {
      stderr.restore();
    }
    expect(stderr.text()).toContain('未写入配置');
  });

  it('stays silent when the address came from config files', async () => {
    const { warnIfTransientBaseUrl } = await baseUrlModule();
    fs.mkdirSync(path.join(home, '.mao', 'agent-cli'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.mao', 'agent-cli', 'config.json'),
      JSON.stringify({ baseUrl: 'https://persisted.example.com' }),
    );
    const stderr = captureStream(process.stderr);
    try {
      // loadUserConfig() 每次调用都重新读文件，先落盘再调用即可命中「已持久化」分支。
      warnIfTransientBaseUrl(true);
    } finally {
      stderr.restore();
    }
    expect(stderr.text()).toBe('');
  });

  it('stays silent when fromCliOrEnv is false', async () => {
    const { warnIfTransientBaseUrl } = await baseUrlModule();
    const stderr = captureStream(process.stderr);
    try {
      warnIfTransientBaseUrl(false);
    } finally {
      stderr.restore();
    }
    expect(stderr.text()).toBe('');
  });
});

describe('main 未配置 baseUrl', () => {
  it('status 显示 (未设置) 并给出提示', async () => {
    const { main } = await import('../src/main');
    const stdout = captureStream(process.stdout);
    try {
      expect(await main(['status'])).toBe(0);
    } finally {
      stdout.restore();
    }
    expect(stdout.text()).toContain('baseUrl:     (未设置)');
    expect(stdout.text()).toContain('未设置站点地址');
  });

  it('非 TTY 下 login 不发起网络请求，直接输出设置指引并以 1 退出', async () => {
    const { main } = await import('../src/main');
    const stderr = captureStream(process.stderr);
    try {
      expect(await main(['login'])).toBe(1);
    } finally {
      stderr.restore();
    }
    expect(stderr.text()).toContain('未配置站点地址（baseUrl）');
    expect(stderr.text()).toContain('MAO_BASE_URL');
  });

  it('ls 同样直接报设置指引', async () => {
    const { main } = await import('../src/main');
    const stderr = captureStream(process.stderr);
    try {
      expect(await main(['ls'])).toBe(1);
    } finally {
      stderr.restore();
    }
    expect(stderr.text()).toContain('未配置站点地址（baseUrl）');
  });

  it('logout 未配置时仍可用：跳过服务端调用，只做本地清理', async () => {
    fs.mkdirSync(path.join(home, '.mao'), { recursive: true });
    fs.writeFileSync(path.join(home, '.mao', 'auth.json'), JSON.stringify({ accessToken: 'stale' }));
    const { main } = await import('../src/main');
    const stderr = captureStream(process.stderr);
    try {
      expect(await main(['logout'])).toBe(0);
    } finally {
      stderr.restore();
    }
    expect(fs.existsSync(path.join(home, '.mao', 'auth.json'))).toBe(false);
    expect(stderr.text()).toContain('已退出登录');
  });
});
