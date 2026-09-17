import { describe, expect, it } from 'vitest';
import { defaultEcpConfig, parseEcpConfig, validateEcpConfig } from './ecp.config.js';

describe('ecp.config', () => {
  it('parses default config', () => {
    expect(parseEcpConfig(null).enabled).toBe(false);
    expect(parseEcpConfig(JSON.stringify(defaultEcpConfig())).appCode).toBe('EK6301');
    expect(parseEcpConfig(JSON.stringify(defaultEcpConfig())).larkAppId).toBe('');
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
});
