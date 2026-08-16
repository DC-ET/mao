import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseJdbcUrl, resetConfigCache } from './app-config.js';

describe('app-config', () => {
  it('parses jdbc url', () => {
    const p = parseJdbcUrl('jdbc:mysql://db.example:3307/mao?useSSL=false');
    expect(p).toEqual({ host: 'db.example', port: 3307, database: 'mao' });
  });

  it('loads defaults and respects MAO_TS_PORT', () => {
    resetConfigCache();
    const prevPort = process.env.MAO_TS_PORT;
    const prevFlyway = process.env.FLYWAY_ENABLED;
    process.env.MAO_TS_PORT = '9080';
    process.env.FLYWAY_ENABLED = 'true';
    const cfg = loadConfig();
    expect(cfg.server.port).toBe(9080);
    expect(cfg.server.servlet.contextPath).toBe('/api');
    expect(cfg.spring.flyway.enabled).toBe(true);
    expect(cfg.jwt.expiration).toBe(86400000);
    if (prevPort === undefined) {
      delete process.env.MAO_TS_PORT;
    } else {
      process.env.MAO_TS_PORT = prevPort;
    }
    if (prevFlyway === undefined) {
      delete process.env.FLYWAY_ENABLED;
    } else {
      process.env.FLYWAY_ENABLED = prevFlyway;
    }
    resetConfigCache();
  });

  it('FLYWAY_ENABLED=false disables schema migrate', () => {
    resetConfigCache();
    const prev = process.env.FLYWAY_ENABLED;
    process.env.FLYWAY_ENABLED = 'false';
    const cfg = loadConfig();
    expect(cfg.spring.flyway.enabled).toBe(false);
    if (prev === undefined) {
      delete process.env.FLYWAY_ENABLED;
    } else {
      process.env.FLYWAY_ENABLED = prev;
    }
    resetConfigCache();
  });
});

describe('flyway files', () => {
  it('contains the current migration set', () => {
    const tsDir = join(process.cwd(), 'db/migration');
    expect(existsSync(tsDir)).toBe(true);
    const tsFiles = readdirSync(tsDir).filter((f) => f.endsWith('.sql')).sort();
    expect(tsFiles.length).toBeGreaterThan(0);
    expect(tsFiles.some((f) => f.startsWith('V074'))).toBe(true);
  });
});
