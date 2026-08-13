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
    const prev = process.env.MAO_TS_PORT;
    process.env.MAO_TS_PORT = '9081';
    const cfg = loadConfig();
    expect(cfg.server.port).toBe(9081);
    expect(cfg.server.servlet.contextPath).toBe('/api');
    expect(cfg.spring.flyway.enabled).toBe(false);
    expect(cfg.jwt.expiration).toBe(86400000);
    if (prev === undefined) {
      delete process.env.MAO_TS_PORT;
    } else {
      process.env.MAO_TS_PORT = prev;
    }
    resetConfigCache();
  });
});

describe('flyway files', () => {
  it('shares the same SQL files as Java', () => {
    const tsDir = join(process.cwd(), 'db/migration');
    const javaDir = join(process.cwd(), '../backend/src/main/resources/db/migration');
    expect(existsSync(tsDir)).toBe(true);
    const tsFiles = readdirSync(tsDir).filter((f) => f.endsWith('.sql')).sort();
    const javaFiles = readdirSync(javaDir).filter((f) => f.endsWith('.sql')).sort();
    expect(tsFiles).toEqual(javaFiles);
    expect(tsFiles.some((f) => f.startsWith('V074'))).toBe(true);
  });
});
