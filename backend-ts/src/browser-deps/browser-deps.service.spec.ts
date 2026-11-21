import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserDepsService,
  BROWSER_DEPS_SKILL_NAME,
  needsWin32Shell,
  resolveChromiumCacheRoot,
  win32ChromeCandidates,
  type BrowserDepsStatus,
} from './browser-deps.service.js';
import type { SystemSetting, SystemSettingRepository } from '../settings/types.js';

/**
 * 浏览器依赖按需安装（方案 2026-11-20 v2 D7 按需化）：
 * 状态机流转、host 降级链（apt 失败 → chromium）、docker 镜像重建分支、
 * 单飞守卫、ensureForSkills 触发口径、installing 孤儿降级、
 * win32 分支（chrome.exe 候选 / chrome-win 缓存布局 / winget 降级 / .cmd shim shell 化，
 * 方案 2026-11-21 D2）。
 */

// 本文件所有用例都注入 execImpl（不走真实 execFile）；仅在 win32 shell 化用例中
// 让 execFile 落到 mock，捕获 execFile 选项（shell 化与否）而不真正 spawn。
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: execFileMock };
});

let execFileCalls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
beforeEach(() => {
  execFileCalls = [];
  execFileMock.mockReset();
  execFileMock.mockImplementation((cmd: string, args: string[], opts: Record<string, unknown>, cb: (e: unknown, o?: string, s?: string) => void) => {
    execFileCalls.push({ cmd, args, opts });
    cb({ code: 'ENOENT', message: 'spawn ENOENT' });
  });
});

interface StoreRow {
  settingKey: string;
  value: string;
  editable: number;
  id?: number;
}

function memoryRepo(initial: StoreRow[] = []): SystemSettingRepository & { rows: StoreRow[] } {
  const rows = [...initial];
  return {
    rows,
    async list() { return rows as unknown as SystemSetting[]; },
    async findByKey(key: string) {
      const row = rows.find((r) => r.settingKey === key);
      return row ? (row as unknown as SystemSetting) : null;
    },
    async updateById(setting: SystemSetting) {
      const row = rows.find((r) => r.settingKey === setting.settingKey);
      if (row) row.value = setting.value ?? '';
    },
    async transaction(fn) { return fn(this); },
  } as unknown as SystemSettingRepository & { rows: StoreRow[] };
}

type ExecCall = { cmd: string; args: string[]; env?: NodeJS.ProcessEnv };

function makeService(options: {
  rows?: StoreRow[];
  mode?: 'host' | 'docker';
  platform?: NodeJS.Platform;
  exec?: (call: ExecCall) => { ok: boolean; output: string };
} = {}) {
  const repo = memoryRepo(options.rows ?? [
    { settingKey: 'browser_deps.status', value: '{"phase":"not_installed"}', editable: 0 },
  ]);
  const cacheRoot = mkdtempSync(path.join(os.tmpdir(), 'mao-bd-cache-'));
  const calls: ExecCall[] = [];
  const service = new BrowserDepsService({
    settingRepo: repo,
    getRuntimeMode: async () => options.mode ?? 'host',
    repoRoot: '/opt/mao',
    image: 'mao-runtime:latest',
    platform: (options.platform ?? 'linux') as NodeJS.Platform,
    chromiumCacheRoot: cacheRoot,
    execImpl: (cmd, args, _timeout, env) => {
      const call: ExecCall = { cmd, args, ...(env ? { env } : {}) };
      calls.push(call);
      return options.exec ? options.exec(call) : { ok: false, output: `${cmd} not found` };
    },
  });
  return { service, repo, calls, cacheRoot };
}

const storedPhase = (repo: { rows: StoreRow[] }): BrowserDepsStatus =>
  JSON.parse(repo.rows[0].value) as BrowserDepsStatus;

describe('BrowserDepsService detect', () => {
  it('detectChrome 命中系统 Chrome', async () => {
    const { service, calls } = makeService({
      exec: ({ cmd, args }) => (cmd === 'google-chrome' && args[0] === '--version'
        ? { ok: true, output: 'Google Chrome 158.0.8127.36' }
        : { ok: false, output: '' }),
    });
    const status = await service.getStatus();
    expect(status.phase).toBe('not_installed');
    expect(status.chrome.present).toBe(true);
    expect(status.chrome.kind).toBe('system');
    expect(status.chrome.version).toContain('158');
    expect(status.cli.present).toBe(false);
    // 首个 chrome 候选即命中，不再探测其余路径
    expect(calls.filter((c) => c.cmd.startsWith('/opt/google'))).toHaveLength(0);
  });

  it('系统 Chrome 缺失时探测 playwright chromium 缓存', async () => {
    const { service, cacheRoot } = makeService({
      // 匹配走平台无关口径：Windows 宿主上 path.join 产出反斜杠路径，不能按 /chrome-linux/chrome 字面匹配
      exec: ({ cmd, args }) => (cmd.includes('chrome-linux') && cmd.endsWith('chrome') && args[0] === '--version'
        ? { ok: true, output: 'Chromium 141.0' }
        : { ok: false, output: '' }),
    });
    mkdirSync(path.join(cacheRoot, 'chromium-1200', 'chrome-linux'), { recursive: true });
    const status = await service.getStatus();
    expect(status.chrome.present).toBe(true);
    expect(status.chrome.kind).toBe('chromium');
    expect(status.chrome.version).toContain('Chromium');
  });
});

describe('BrowserDepsService host 安装链', () => {
  it('Chrome 已就绪时只装 CLI，直接 ready', async () => {
    const { service, repo, calls } = makeService({
      exec: ({ cmd, args }) => {
        if (cmd === 'google-chrome' && args[0] === '--version') return { ok: true, output: 'Google Chrome 158' };
        if (cmd === 'npm') return { ok: true, output: 'added 1 package' };
        if (cmd === 'playwright-cli' && args[0] === '--version') return { ok: true, output: '0.1.25' };
        return { ok: false, output: '' };
      },
    });
    const { started } = await service.install();
    expect(started).toBe(true);
    // 等待后台任务收敛
    await vi.waitFor(() => expect(storedPhase(repo).phase).toBe('ready'));
    expect(storedPhase(repo).chrome.kind).toBe('system');
    expect(storedPhase(repo).cli.present).toBe(true);
    // 不应有 apt/curl/install-browser 调用
    expect(calls.some((c) => c.cmd === 'apt-get' || c.cmd === 'curl' || c.args.includes('install-browser'))).toBe(false);
  });

  it('apt 下载失败降级 chromium（npmmirror 镜像源）', async () => {
    // chromium 缓存条目先布置（探测走 readdir）；downloaded 标志控制下载前探测不到、下载后命中
    let chromiumDownloaded = false;
    const { service, repo, calls, cacheRoot } = makeService({
      exec: ({ cmd, args }) => {
        if (cmd === 'google-chrome' && args[0] === '--version') return { ok: false, output: 'not found' };
        if (cmd === 'uname') return { ok: true, output: 'x86_64' };
        if (cmd === 'which' && args[0] === 'apt-get') return { ok: true, output: '/usr/bin/apt-get' };
        if (cmd === 'curl') return { ok: false, output: 'curl: (7) Failed to connect' };
        if (cmd === 'npm') return { ok: true, output: 'added 1 package' };
        if (cmd === 'playwright-cli' && args[0] === 'install-browser') { chromiumDownloaded = true; return { ok: true, output: 'chromium downloaded' }; }
        if (cmd === 'playwright-cli' && args[0] === '--version') return { ok: true, output: '0.1.25' };
        if (cmd.includes('chrome-linux') && cmd.endsWith('chrome') && args[0] === '--version') {
          return chromiumDownloaded ? { ok: true, output: 'Chromium 141.0' } : { ok: false, output: '' };
        }
        return { ok: false, output: '' };
      },
    });
    mkdirSync(path.join(cacheRoot, 'chromium-1200', 'chrome-linux'), { recursive: true });
    await service.install();
    await vi.waitFor(() => expect(storedPhase(repo).phase).toBe('ready'));
    expect(storedPhase(repo).chrome.kind).toBe('chromium');
    // 降级下载必须走镜像源
    const installBrowser = calls.find((c) => c.args.includes('install-browser'));
    expect(installBrowser?.env?.PLAYWRIGHT_DOWNLOAD_HOST).toContain('npmmirror');
    // apt 链必须先于 chromium 降级被尝试（curl 下载 deb 失败后才走降级）
    expect(calls.some((c) => c.cmd === 'curl')).toBe(true);
  });

  it('chromium 也失败时落 failed 并保留原因', async () => {
    const { service, repo } = makeService({
      exec: ({ cmd, args }) => {
        if (cmd === 'uname') return { ok: true, output: 'x86_64' };
        if (cmd === 'which' && args[0] === 'apt-get') return { ok: true, output: '/usr/bin/apt-get' };
        if (cmd === 'npm') return { ok: true, output: 'ok' };
        return { ok: false, output: 'boom' };
      },
    });
    await service.install();
    await vi.waitFor(() => expect(storedPhase(repo).phase).toBe('failed'));
    expect(storedPhase(repo).detail).toContain('浏览器内核下载失败');
  });
});

describe('BrowserDepsService docker 分支', () => {
  it('触发镜像重建并验证镜像内依赖', async () => {
    const { service, repo, calls } = makeService({
      mode: 'docker',
      exec: ({ cmd, args }) => {
        if (cmd === 'bash' && args[0]?.includes('build-runtime-image.sh')) return { ok: true, output: '完成：mao-runtime:latest' };
        if (cmd === 'docker' && args[0] === 'run') return { ok: true, output: 'Google Chrome 158' };
        return { ok: false, output: '' };
      },
    });
    await service.install();
    await vi.waitFor(() => expect(storedPhase(repo).phase).toBe('ready'));
    expect(storedPhase(repo).mode).toBe('docker');
    const build = calls.find((c) => c.cmd === 'bash');
    expect(build?.args[0]).toContain('build-runtime-image.sh');
    expect(build?.env?.INSTALL_CHROME).toBe('1');
    const verify = calls.find((c) => c.cmd === 'docker' && c.args[0] === 'run');
    expect(verify?.args).toContain('mao-runtime:latest');
  });

  it('构建失败落 failed 并提示手动重建', async () => {
    const { service, repo } = makeService({
      mode: 'docker',
      exec: ({ cmd }) => (cmd === 'bash' ? { ok: false, output: 'docker build exited 1: no space left' } : { ok: false, output: '' }),
    });
    await service.install();
    await vi.waitFor(() => expect(storedPhase(repo).phase).toBe('failed'));
    expect(storedPhase(repo).detail).toContain('build-runtime-image.sh');
  });
});

describe('BrowserDepsService 单飞与孤儿', () => {
  it('installing 期间重复 install 拒绝启动', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { service, repo } = makeService({
      // 只 gate npm（runInstall 内首个 exec；getStatus 的检测不触发 npm，不会被挂起）
      exec: ({ cmd }) => (cmd === 'npm'
        ? gate.then(() => ({ ok: false, output: 'aborted' }))
        : { ok: false, output: '' }),
    });
    const first = service.install();
    await vi.waitFor(() => expect(storedPhase(repo).phase).toBe('installing'));
    const second = await service.install();
    expect(second.started).toBe(false);
    release?.();
    await first;
  });

  it('installing 超时孤儿在读取时降级 failed', async () => {
    const stale = new Date(Date.now() - 40 * 60_000).toISOString();
    const { service } = makeService({
      rows: [{ settingKey: 'browser_deps.status', value: JSON.stringify({ phase: 'installing', mode: 'host', detail: 'x', updatedAt: stale, chrome: { present: false }, cli: { present: false } }), editable: 0 }],
    });
    const status = await service.getStatus();
    expect(status.phase).toBe('failed');
    expect(status.detail).toContain('安装中断');
  });

  it('ready 但实况全没了：以检测实况降级 not_installed', async () => {
    const { service } = makeService({
      rows: [{ settingKey: 'browser_deps.status', value: JSON.stringify({ phase: 'ready', mode: 'host', updatedAt: new Date().toISOString(), chrome: { present: true }, cli: { present: true } }), editable: 0 }],
    });
    const status = await service.getStatus();
    expect(status.phase).toBe('not_installed');
    expect(status.detail).toContain('已不存在');
  });
});

describe('BrowserDepsService ensureForSkills', () => {
  it('勾选 browser-use 且未就绪时自动安装；ready 时 no-op', async () => {
    const calls: ExecCall[] = [];
    let chromePresent = false;
    const repo = memoryRepo([{ settingKey: 'browser_deps.status', value: '{"phase":"not_installed"}', editable: 0 }]);
    const service = new BrowserDepsService({
      settingRepo: repo,
      getRuntimeMode: async () => 'host',
      repoRoot: '/opt/mao',
      image: 'mao-runtime:latest',
      platform: 'linux' as NodeJS.Platform,
      execImpl: (cmd, args) => {
        const call: ExecCall = { cmd, args };
        calls.push(call);
        if (cmd === 'google-chrome' && args[0] === '--version') return { ok: chromePresent, output: chromePresent ? 'Chrome 158' : '' };
        if (cmd === 'npm') { chromePresent = true; return { ok: true, output: 'ok' }; }
        if (cmd === 'playwright-cli' && args[0] === '--version') return { ok: true, output: '0.1.25' };
        return { ok: false, output: '' };
      },
    });
    // 无关技能不触发（不产生任何安装动作）
    service.ensureForSkills(['mao-cli']);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.cmd === 'npm')).toHaveLength(0);
    // 勾选 browser-use → 自动安装
    service.ensureForSkills([BROWSER_DEPS_SKILL_NAME]);
    await vi.waitFor(() => expect(storedPhase(repo).phase).toBe('ready'));
    const npmCallsAfterInstall = calls.filter((c) => c.cmd === 'npm').length;
    // 再次保存（已 ready）→ no-op：不重复安装（npm 调用数不涨）
    service.ensureForSkills([BROWSER_DEPS_SKILL_NAME]);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.cmd === 'npm')).toHaveLength(npmCallsAfterInstall);
  });
});

describe('BrowserDepsService win32 分支', () => {
  it('detectChrome 命中系统 Chrome（win32 候选，chrome.exe）', async () => {
    const { service, calls } = makeService({
      platform: 'win32',
      exec: ({ cmd, args }) => (cmd.endsWith('chrome.exe') && args[0] === '--version'
        ? { ok: true, output: 'Google Chrome 158.0.8127.36' }
        : { ok: false, output: '' }),
    });
    const status = await service.getStatus();
    expect(status.chrome.present).toBe(true);
    expect(status.chrome.kind).toBe('system');
    expect(status.chrome.version).toContain('158');
    // 首个候选即 %ProgramFiles% 根下的 chrome.exe（Linux/macOS CI 无该环境变量时走缺省根，路径形态确定）
    expect(calls[0].cmd.endsWith(path.join('Google', 'Chrome', 'Application', 'chrome.exe'))).toBe(true);
    // 候选口径：env 命中与缺省回退
    expect(win32ChromeCandidates({ ProgramFiles: 'D:\\PF', 'ProgramFiles(x86)': 'D:\\PF86', LOCALAPPDATA: 'D:\\LAD' }, '')).toEqual([
      path.join('D:\\PF', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join('D:\\PF86', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join('D:\\LAD', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]);
    expect(win32ChromeCandidates({}, '/home/u')).toEqual([
      path.join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join('C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join('/home/u', 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]);
  });

  it('win32 chromium 缓存检测命中 chrome-win 布局', async () => {
    const { service, cacheRoot } = makeService({
      platform: 'win32',
      exec: ({ cmd, args }) => (cmd.includes('chromium-1200') && cmd.endsWith('chrome.exe') && args[0] === '--version'
        ? { ok: true, output: 'Chromium 141.0' }
        : { ok: false, output: '' }),
    });
    mkdirSync(path.join(cacheRoot, 'chromium-1200', 'chrome-win', 'chrome.exe'), { recursive: true });
    const status = await service.getStatus();
    expect(status.chrome.present).toBe(true);
    expect(status.chrome.kind).toBe('chromium');
    expect(status.chrome.version).toContain('Chromium');
  });

  it('resolveChromiumCacheRoot 平台口径', () => {
    expect(resolveChromiumCacheRoot('win32', { PLAYWRIGHT_BROWSERS_PATH: 'D:\\pw' })).toBe('D:\\pw');
    expect(resolveChromiumCacheRoot('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })).toBe(path.join('C:\\Users\\u\\AppData\\Local', 'ms-playwright'));
    expect(resolveChromiumCacheRoot('win32', {}, '/home/u')).toBe(path.join('/home/u', 'AppData', 'Local', 'ms-playwright'));
    // 期望值同样经 path.join 归一化：Windows 宿主上实现与期望同用 path.win32，POSIX CI 上仍是 / 形态
    expect(resolveChromiumCacheRoot('linux', {}, '/root')).toBe(path.join('/root', '.cache', 'ms-playwright'));
    expect(resolveChromiumCacheRoot('darwin', {}, '/Users/u')).toBe(path.join('/Users/u', '.cache', 'ms-playwright'));
  });

  it('winget 失败静默降级 chromium（win32 安装链）', async () => {
    let chromiumDownloaded = false;
    const { service, repo, calls, cacheRoot } = makeService({
      platform: 'win32',
      exec: ({ cmd, args }) => {
        if (cmd === 'winget') return { ok: false, output: 'winget: not recognized' };
        if (cmd.endsWith('chrome.exe') && args[0] === '--version' && !cmd.includes('chromium-')) return { ok: false, output: 'not found' };
        if (cmd === 'npm') return { ok: true, output: 'added 1 package' };
        if (cmd === 'playwright-cli' && args[0] === 'install-browser') { chromiumDownloaded = true; return { ok: true, output: 'chromium downloaded' }; }
        if (cmd === 'playwright-cli' && args[0] === '--version') return { ok: true, output: '0.1.25' };
        if (cmd.includes('chromium-1200') && cmd.endsWith('chrome.exe') && args[0] === '--version') {
          return chromiumDownloaded ? { ok: true, output: 'Chromium 141.0' } : { ok: false, output: '' };
        }
        return { ok: false, output: '' };
      },
    });
    mkdirSync(path.join(cacheRoot, 'chromium-1200', 'chrome-win', 'chrome.exe'), { recursive: true });
    await service.install();
    await vi.waitFor(() => expect(storedPhase(repo).phase).toBe('ready'));
    expect(storedPhase(repo).chrome.kind).toBe('chromium');
    expect(calls.some((c) => c.cmd === 'winget')).toBe(true);
    const installBrowser = calls.find((c) => c.args.includes('install-browser'));
    expect(installBrowser?.env?.PLAYWRIGHT_DOWNLOAD_HOST).toContain('npmmirror');
  });

  it('winget 成功 → 系统 Chrome ready，不触发 chromium 下载', async () => {
    let wingetDone = false;
    const { service, repo, calls } = makeService({
      platform: 'win32',
      exec: ({ cmd, args }) => {
        if (cmd === 'winget') { wingetDone = true; return { ok: true, output: 'Successfully installed' }; }
        if (cmd.endsWith('chrome.exe') && args[0] === '--version' && !cmd.includes('chromium-')) return wingetDone ? { ok: true, output: 'Google Chrome 158' } : { ok: false, output: '' };
        if (cmd === 'npm') return { ok: true, output: 'added 1 package' };
        if (cmd === 'playwright-cli' && args[0] === '--version') return { ok: true, output: '0.1.25' };
        return { ok: false, output: '' };
      },
    });
    await service.install();
    await vi.waitFor(() => expect(storedPhase(repo).phase).toBe('ready'));
    expect(storedPhase(repo).chrome.kind).toBe('system');
    expect(calls.some((c) => c.args.includes('install-browser'))).toBe(false);
  });

  it('needsWin32Shell 口径：npm/npx/playwright-cli shell 化，winget/chrome.exe 与非 win32 不 shell 化', () => {
    expect(needsWin32Shell('win32', 'npm')).toBe(true);
    expect(needsWin32Shell('win32', 'npx')).toBe(true);
    expect(needsWin32Shell('win32', 'playwright-cli')).toBe(true);
    expect(needsWin32Shell('win32', 'npm.cmd')).toBe(true);
    expect(needsWin32Shell('win32', 'winget')).toBe(false);
    expect(needsWin32Shell('win32', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')).toBe(false);
    expect(needsWin32Shell('linux', 'npm')).toBe(false);
    expect(needsWin32Shell('darwin', 'npm')).toBe(false);
  });

  it('win32 无 execImpl 时 shim 命令走 shell 化 execFile，chrome.exe 维持直调', async () => {
    const repo = memoryRepo([{ settingKey: 'browser_deps.status', value: '{"phase":"not_installed"}', editable: 0 }]);
    const service = new BrowserDepsService({
      settingRepo: repo,
      getRuntimeMode: async () => 'host',
      repoRoot: '/opt/mao',
      image: 'mao-runtime:latest',
      platform: 'win32' as NodeJS.Platform,
      // 不注入 execImpl：走真实 exec() → 落到被 mock 的 execFile
    });
    const status = await service.detect();
    expect(status.cli.present).toBe(false);
    const cliCall = execFileCalls.find((c) => c.cmd === 'playwright-cli');
    expect(cliCall?.opts.shell).toBe(true); // .cmd shim → shell 化
    const chromeCall = execFileCalls.find((c) => c.cmd.endsWith('chrome.exe'));
    expect(chromeCall).toBeTruthy();
    expect(chromeCall?.opts.shell).toBeFalsy(); // 真 .exe 维持 execFile
  });
});
