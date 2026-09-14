import { describe, expect, it } from 'vitest';
import { defaultEcpConfig, parseEcpConfig, validateEcpConfig } from './ecp.config.js';

describe('ecp.config', () => {
  it('parses default config', () => {
    expect(parseEcpConfig(null).enabled).toBe(false);
    expect(parseEcpConfig(JSON.stringify(defaultEcpConfig())).appCode).toBe('EK6301');
  });

  it('rejects invalid timeout', () => {
    expect(() => validateEcpConfig({ ...defaultEcpConfig(), timeoutMs: 50 })).toThrow();
  });

  it('rejects unknown fields', () => {
    expect(() => validateEcpConfig({ ...defaultEcpConfig(), extra: true })).toThrow(/未知字段/);
  });
});
