import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CLOUD_RUNTIME_MODE,
  RUNTIME_MODE_SETTING_KEY,
  RuntimeModeResolver,
  parseCloudRuntimeMode,
} from './runtime-mode.js';

describe('runtime mode resolver', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses host and docker case-insensitively, rejects unknown values', () => {
    expect(parseCloudRuntimeMode('host')).toBe('host');
    expect(parseCloudRuntimeMode(' DOCKER ')).toBe('docker');
    expect(parseCloudRuntimeMode('')).toBeNull();
    expect(parseCloudRuntimeMode(null)).toBeNull();
    expect(parseCloudRuntimeMode('container')).toBeNull();
  });

  it('prefers the system setting over the deployment fallback', async () => {
    const resolver = new RuntimeModeResolver({
      systemSettingService: { getValue: async (key) => (key === RUNTIME_MODE_SETTING_KEY ? 'docker' : null) },
      fallbackMode: 'host',
    });
    expect(await resolver.resolve()).toBe('docker');
  });

  it('falls back to MAO_CLOUD_RUNTIME when the row is missing or invalid', async () => {
    const missing = new RuntimeModeResolver({
      systemSettingService: { getValue: async () => null },
      fallbackMode: 'docker',
    });
    expect(await missing.resolve()).toBe('docker');

    const invalid = new RuntimeModeResolver({
      systemSettingService: { getValue: async () => 'container' },
      fallbackMode: 'host',
    });
    expect(await invalid.resolve()).toBe('host');
  });

  it('falls back when the settings lookup throws', async () => {
    const resolver = new RuntimeModeResolver({
      systemSettingService: { getValue: async () => { throw new Error('db down'); } },
      fallbackMode: 'host',
    });
    expect(await resolver.resolve()).toBe('host');
  });

  it('caches for a short ttl and invalidate() makes a switch visible immediately', async () => {
    vi.useFakeTimers();
    let stored = 'host';
    const getValue = vi.fn(async () => stored);
    const resolver = new RuntimeModeResolver({
      systemSettingService: { getValue },
      fallbackMode: 'host',
    });
    expect(await resolver.resolve()).toBe('host');
    expect(await resolver.resolve()).toBe('host');
    expect(getValue).toHaveBeenCalledTimes(1);

    stored = 'docker';
    // TTL 内仍是旧值
    expect(await resolver.resolve()).toBe('host');
    // 后台保存后主动失效 → 立即读到新值
    resolver.invalidate();
    expect(await resolver.resolve()).toBe('docker');
    expect(getValue).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(5_001);
    expect(await resolver.resolve()).toBe('docker');
    expect(getValue).toHaveBeenCalledTimes(3);
  });

  it('defaults to host', () => {
    expect(DEFAULT_CLOUD_RUNTIME_MODE).toBe('host');
  });
});
