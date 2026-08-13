import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runFlywayIfEnabled } from './flyway.js';
import { notDeleted } from './db.js';
import type { AppConfig } from '../config/app-config.js';

describe('Flyway contract', () => {
  it('TS migration files match Java checksums', () => {
    const javaDir = resolve(process.cwd(), '../backend/src/main/resources/db/migration');
    const tsDir = resolve(process.cwd(), 'db/migration');
    expect(existsSync(javaDir)).toBe(true);
    expect(existsSync(tsDir)).toBe(true);
    const java = readdirSync(javaDir).filter((f) => f.endsWith('.sql')).sort();
    const ts = readdirSync(tsDir).filter((f) => f.endsWith('.sql')).sort();
    expect(ts).toEqual(java);
    for (const file of java) {
      const j = createHash('sha256').update(readFileSync(resolve(javaDir, file))).digest('hex');
      const t = createHash('sha256').update(readFileSync(resolve(tsDir, file))).digest('hex');
      expect(t, file).toBe(j);
    }
  });

  it('runFlywayIfEnabled noops when disabled', () => {
    const cfg = { spring: { flyway: { enabled: false } } } as AppConfig;
    expect(() => runFlywayIfEnabled(cfg)).not.toThrow();
  });

  it('notDeleted helper', () => {
    expect(notDeleted()).toBe('deleted = 0');
    expect(notDeleted('s')).toBe('s.deleted = 0');
  });
});
