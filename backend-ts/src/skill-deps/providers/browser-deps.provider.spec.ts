import { describe, expect, it, vi } from 'vitest';
import type { BrowserDepsStatus } from '../../browser-deps/browser-deps.service.js';
import { BROWSER_DEPS_INSTALL_CONFIRM, browserDepsDetail, createBrowserDepsProvider } from './browser-deps.provider.js';

function status(overrides: Partial<BrowserDepsStatus> = {}): BrowserDepsStatus {
  return {
    phase: 'not_installed',
    mode: 'host',
    detail: null,
    chrome: { present: false, kind: null, version: null },
    cli: { present: false, version: null },
    updatedAt: '2026-11-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('browserDepsDetail', () => {
  it('优先用存量 detail', () => {
    expect(browserDepsDetail(status({ detail: '就绪：系统 Chrome + playwright-cli' }))).toBe('就绪：系统 Chrome + playwright-cli');
  });

  it('chromium 降级时在 detail 标注（已含 chromium 不重复）', () => {
    const chromium = { present: true, kind: 'chromium' as const, version: '120' };
    expect(browserDepsDetail(status({ detail: '就绪', chrome: chromium }))).toBe('就绪（chromium）');
    expect(browserDepsDetail(status({ detail: '就绪：chromium（playwright 缓存）', chrome: chromium }))).toBe('就绪：chromium（playwright 缓存）');
  });

  it('无 detail 时按实况拼装，全无则 null', () => {
    expect(browserDepsDetail(status({
      chrome: { present: true, kind: 'system', version: 'Google Chrome 131' },
      cli: { present: true, version: '0.1.0' },
    }))).toBe('Chrome Google Chrome 131 + playwright-cli 0.1.0');
    expect(browserDepsDetail(status())).toBeNull();
  });
});

describe('createBrowserDepsProvider', () => {
  it('status 映射为单个 install 条目并带安装确认文案', async () => {
    const service = { getStatus: vi.fn(async () => status({ phase: 'installing', detail: '下载 chromium' })), install: vi.fn(), ensureForSkills: vi.fn() };
    const provider = createBrowserDepsProvider(service as never);
    expect(provider.skillName).toBe('browser-use');
    expect(await provider.status()).toEqual([{
      id: 'browser', label: '浏览器依赖', kind: 'install', phase: 'installing', detail: '下载 chromium',
      installConfirm: BROWSER_DEPS_INSTALL_CONFIRM,
    }]);
  });

  it('install 只透出 started；ensureForSkills 原样直通', async () => {
    const service = {
      getStatus: vi.fn(),
      install: vi.fn(async () => ({ started: false, status: status({ phase: 'ready' }) })),
      ensureForSkills: vi.fn(),
    };
    const provider = createBrowserDepsProvider(service as never);
    expect(await provider.install!()).toEqual({ started: false });
    provider.ensureForSkills!(['git', 'browser-use']);
    expect(service.ensureForSkills).toHaveBeenCalledWith(['git', 'browser-use']);
  });
});
