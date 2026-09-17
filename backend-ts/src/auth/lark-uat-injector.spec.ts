import { describe, expect, it, vi } from 'vitest';
import { createLarkUatInjector } from './lark-uat-injector.js';
import { defaultEcpConfig } from './ecp.config.js';

function enabledConfig(larkAppId = 'cli_lark') {
  return { ...defaultEcpConfig(), enabled: true, larkAppId };
}

describe('createLarkUatInjector', () => {
  it('returns null when ECP is disabled', async () => {
    const injector = createLarkUatInjector({
      ecpInjector: { injectForUser: vi.fn(async () => 'ecp-tok') },
      ecpClient: { getUserAccessToken: vi.fn() },
      getConfig: async () => defaultEcpConfig(),
    });
    expect(await injector.injectForUser(1)).toBeNull();
  });

  it('returns null when larkAppId is empty', async () => {
    const injector = createLarkUatInjector({
      ecpInjector: { injectForUser: vi.fn(async () => 'ecp-tok') },
      ecpClient: { getUserAccessToken: vi.fn() },
      getConfig: async () => ({ ...defaultEcpConfig(), enabled: true, larkAppId: '' }),
    });
    expect(await injector.injectForUser(1)).toBeNull();
  });

  it('returns null when user has no usable ECP session', async () => {
    const injector = createLarkUatInjector({
      ecpInjector: { injectForUser: vi.fn(async () => null) },
      ecpClient: { getUserAccessToken: vi.fn() },
      getConfig: async () => enabledConfig(),
    });
    expect(await injector.injectForUser(1)).toBeNull();
  });

  it('fetches UAT once and serves subsequent calls from cache', async () => {
    const getUserAccessToken = vi.fn(async () => ({
      accessToken: 'u-1',
      expiresAt: new Date(Date.now() + 3600_000),
    }));
    const injector = createLarkUatInjector({
      ecpInjector: { injectForUser: vi.fn(async () => 'ecp-tok') },
      ecpClient: { getUserAccessToken },
      getConfig: async () => enabledConfig(),
    });
    const first = await injector.injectForUser(7);
    const second = await injector.injectForUser(7);
    expect(first).toEqual({ uat: 'u-1', appId: 'cli_lark' });
    expect(second).toEqual({ uat: 'u-1', appId: 'cli_lark' });
    expect(getUserAccessToken).toHaveBeenCalledTimes(1);
  });

  it('re-fetches when entry enters the 5-minute refresh window', async () => {
    const getUserAccessToken = vi.fn()
      .mockResolvedValueOnce({ accessToken: 'u-old', expiresAt: new Date(Date.now() + 4 * 60 * 1000) })
      .mockResolvedValueOnce({ accessToken: 'u-new', expiresAt: new Date(Date.now() + 3600_000) });
    const injector = createLarkUatInjector({
      ecpInjector: { injectForUser: vi.fn(async () => 'ecp-tok') },
      ecpClient: { getUserAccessToken },
      getConfig: async () => enabledConfig(),
    });
    expect((await injector.injectForUser(3))?.uat).toBe('u-old');
    expect((await injector.injectForUser(3))?.uat).toBe('u-new');
    expect(getUserAccessToken).toHaveBeenCalledTimes(2);
  });

  it('invalidates cache when ECP token fingerprint changes', async () => {
    let ecpToken = 'ecp-a';
    const getUserAccessToken = vi.fn(async () => ({
      accessToken: `u-${ecpToken}`,
      expiresAt: new Date(Date.now() + 3600_000),
    }));
    const injector = createLarkUatInjector({
      ecpInjector: { injectForUser: vi.fn(async () => ecpToken) },
      ecpClient: { getUserAccessToken },
      getConfig: async () => enabledConfig(),
    });
    expect((await injector.injectForUser(9))?.uat).toBe('u-ecp-a');
    ecpToken = 'ecp-b';
    expect((await injector.injectForUser(9))?.uat).toBe('u-ecp-b');
    expect(getUserAccessToken).toHaveBeenCalledTimes(2);
  });

  it('re-fetches when larkAppId changes so UAT is not paired with a new app', async () => {
    let larkAppId = 'cli_app_a';
    const getUserAccessToken = vi.fn(async () => ({
      accessToken: `u-for-${larkAppId}`,
      expiresAt: new Date(Date.now() + 3600_000),
    }));
    const injector = createLarkUatInjector({
      ecpInjector: { injectForUser: vi.fn(async () => 'ecp-tok') },
      ecpClient: { getUserAccessToken },
      getConfig: async () => enabledConfig(larkAppId),
    });
    expect(await injector.injectForUser(12)).toEqual({ uat: 'u-for-cli_app_a', appId: 'cli_app_a' });
    larkAppId = 'cli_app_b';
    expect(await injector.injectForUser(12)).toEqual({ uat: 'u-for-cli_app_b', appId: 'cli_app_b' });
    expect(getUserAccessToken).toHaveBeenCalledTimes(2);
  });

  it('does not fall back to cached UAT from another appId when refresh fails', async () => {
    let larkAppId = 'cli_app_a';
    const getUserAccessToken = vi.fn()
      .mockResolvedValueOnce({ accessToken: 'u-for-a', expiresAt: new Date(Date.now() + 3600_000) })
      .mockRejectedValueOnce(new Error('ecp down'));
    const injector = createLarkUatInjector({
      ecpInjector: { injectForUser: vi.fn(async () => 'ecp-tok') },
      ecpClient: { getUserAccessToken },
      getConfig: async () => enabledConfig(larkAppId),
    });
    expect(await injector.injectForUser(13)).toEqual({ uat: 'u-for-a', appId: 'cli_app_a' });
    larkAppId = 'cli_app_b';
    expect(await injector.injectForUser(13)).toBeNull();
    expect(getUserAccessToken).toHaveBeenCalledTimes(2);
  });

  it('falls back to unexpired cached UAT when refresh fails', async () => {
    const getUserAccessToken = vi.fn()
      .mockResolvedValueOnce({ accessToken: 'u-keep', expiresAt: new Date(Date.now() + 4 * 60 * 1000) })
      .mockRejectedValueOnce(new Error('ecp down'));
    const injector = createLarkUatInjector({
      ecpInjector: { injectForUser: vi.fn(async () => 'ecp-tok') },
      ecpClient: { getUserAccessToken },
      getConfig: async () => enabledConfig(),
    });
    expect((await injector.injectForUser(4))?.uat).toBe('u-keep');
    expect((await injector.injectForUser(4))?.uat).toBe('u-keep');
    expect(getUserAccessToken).toHaveBeenCalledTimes(2);
  });

  it('clears cache when ECP session becomes unusable', async () => {
    let ecpOk = true;
    const getUserAccessToken = vi.fn(async () => ({
      accessToken: 'u-1',
      expiresAt: new Date(Date.now() + 3600_000),
    }));
    const injector = createLarkUatInjector({
      ecpInjector: { injectForUser: vi.fn(async () => (ecpOk ? 'ecp-tok' : null)) },
      ecpClient: { getUserAccessToken },
      getConfig: async () => enabledConfig(),
    });
    expect(await injector.injectForUser(5)).not.toBeNull();
    ecpOk = false;
    expect(await injector.injectForUser(5)).toBeNull();
    ecpOk = true;
    expect(await injector.injectForUser(5)).not.toBeNull();
    expect(getUserAccessToken).toHaveBeenCalledTimes(2);
  });

  it('merges concurrent inject calls for the same user', async () => {
    let resolveFetch: (value: { accessToken: string; expiresAt: Date }) => void;
    const getUserAccessToken = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const injector = createLarkUatInjector({
      ecpInjector: { injectForUser: vi.fn(async () => 'ecp-tok') },
      ecpClient: { getUserAccessToken },
      getConfig: async () => enabledConfig(),
    });
    const p1 = injector.injectForUser(11);
    const p2 = injector.injectForUser(11);
    await vi.waitFor(() => { expect(getUserAccessToken).toHaveBeenCalledTimes(1); });
    resolveFetch!({ accessToken: 'u-conc', expiresAt: new Date(Date.now() + 3600_000) });
    expect(await p1).toEqual({ uat: 'u-conc', appId: 'cli_lark' });
    expect(await p2).toEqual({ uat: 'u-conc', appId: 'cli_lark' });
    expect(getUserAccessToken).toHaveBeenCalledTimes(1);
  });
});
