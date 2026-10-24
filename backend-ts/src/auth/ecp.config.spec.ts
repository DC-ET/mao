import { describe, expect, it } from 'vitest';
import { callbackUrlForTarget, defaultEcpConfig, parseEcpConfig, validateEcpConfig } from './ecp.config.js';

describe('ecp.config', () => {
  it('parses default config', () => {
    expect(parseEcpConfig(null).enabled).toBe(false);
    const parsed = parseEcpConfig(JSON.stringify(defaultEcpConfig()));
    expect(parsed.appCode).toBe('EK0001');
    expect(parsed.baseUrl).toBe('https://ecp.example.com/api/v1');
    expect(parsed.desktopCallbackUrl).toBe('https://mao.example.com/auth/ecp/feishu-callback');
    expect(parsed.adminCallbackUrl).toBe('https://mao.example.com/admin/auth/ecp/feishu-callback');
    expect(parsed.larkAppId).toBe('');
  });

  it('accepts legacy JSON without larkAppId', () => {
    const legacy = { ...defaultEcpConfig() } as Record<string, unknown>;
    delete legacy.larkAppId;
    expect(validateEcpConfig(legacy).larkAppId).toBe('');
  });

  it('rejects invalid larkAppId type', () => {
    expect(() => validateEcpConfig({ ...defaultEcpConfig(), larkAppId: 123 })).toThrow(/larkAppId/);
  });

  it('trims larkAppId', () => {
    expect(validateEcpConfig({ ...defaultEcpConfig(), larkAppId: '  cli_abc  ' }).larkAppId).toBe('cli_abc');
  });

  it('rejects invalid timeout', () => {
    expect(() => validateEcpConfig({ ...defaultEcpConfig(), timeoutMs: 50 })).toThrow();
  });

  it('rejects unknown fields', () => {
    expect(() => validateEcpConfig({ ...defaultEcpConfig(), extra: true })).toThrow(/未知字段/);
  });

  it('accepts legacy JSON without channelCallbackUrl', () => {
    const legacy = { ...defaultEcpConfig() } as Record<string, unknown>;
    delete legacy.channelCallbackUrl;
    expect(validateEcpConfig(legacy).channelCallbackUrl).toBe('');
  });

  it('validates channelCallbackUrl as an https url', () => {
    const url = 'https://apihub-test.danchuangglobal.com/api/mao/v1/auth/ecp/feishu/channel-callback';
    expect(validateEcpConfig({ ...defaultEcpConfig(), channelCallbackUrl: url }).channelCallbackUrl).toBe(url);
    expect(() => validateEcpConfig({ ...defaultEcpConfig(), channelCallbackUrl: 'http://apihub-test/cb' })).toThrow(/channelCallbackUrl/);
  });

  it('falls back to the desktop callback when the channel url is empty', () => {
    const cfg = defaultEcpConfig();
    expect(callbackUrlForTarget(cfg, 'channel')).toBe(cfg.desktopCallbackUrl);
    const withChannel = {
      ...cfg,
      channelCallbackUrl: 'https://apihub-test.danchuangglobal.com/api/mao/v1/auth/ecp/feishu/channel-callback',
    };
    expect(callbackUrlForTarget(withChannel, 'channel')).toBe(withChannel.channelCallbackUrl);
    expect(callbackUrlForTarget(withChannel, 'desktop')).toBe(cfg.desktopCallbackUrl);
    expect(callbackUrlForTarget(withChannel, 'admin')).toBe(cfg.adminCallbackUrl);
  });
});
