import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  compareVersions,
  flywayChecksum,
  listMigrations,
  migrateWithDb,
  parseMigrationName,
  resolveMigrationDir,
  runFlywayIfEnabled,
  type FlywayDb,
} from './flyway.js';
import { notDeleted } from './db.js';
import type { AppConfig } from '../config/app-config.js';

describe('Flyway contract', () => {
  it('migration files are well-formed with stable checksums', () => {
    const tsDir = resolve(process.cwd(), 'db/migration');
    expect(existsSync(tsDir)).toBe(true);
    const files = readdirSync(tsDir).filter((f) => f.endsWith('.sql')).sort();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(parseMigrationName(file), file).not.toBeNull();
      const sql = readFileSync(resolve(tsDir, file), 'utf8');
      expect(sql.length, file).toBeGreaterThan(0);
      expect(typeof flywayChecksum(sql), file).toBe('number');
    }
  });

  it('runFlywayIfEnabled noops when disabled', async () => {
    const cfg = { spring: { flyway: { enabled: false } } } as AppConfig;
    await expect(runFlywayIfEnabled(cfg)).resolves.toBeUndefined();
  });

  it('notDeleted helper', () => {
    expect(notDeleted()).toBe('deleted = 0');
    expect(notDeleted('s')).toBe('s.deleted = 0');
  });
});

describe('Flyway checksum and filenames', () => {
  it('ignores line endings and BOM', () => {
    const unix = flywayChecksum('hello\nworld\n');
    const windows = flywayChecksum('hello\r\nworld\r\n');
    const bom = flywayChecksum('\uFEFFhello\nworld\n');
    expect(unix).toBe(windows);
    expect(unix).toBe(bom);
    expect(unix).not.toBe(0);
  });

  it('parses V001 filenames', () => {
    expect(parseMigrationName('V001__init_schema.sql')).toEqual({
      version: '001',
      description: 'init schema',
    });
    expect(parseMigrationName('readme.txt')).toBeNull();
  });

  it('compares dotted versions numerically', () => {
    expect(compareVersions('9', '10')).toBeLessThan(0);
    expect(compareVersions('001', '012')).toBeLessThan(0);
    expect(compareVersions('075', '075')).toBe(0);
  });

  it('lists shared SQL migrations in version order', () => {
    const dir = resolveMigrationDir();
    const migrations = listMigrations(dir);
    expect(migrations[0]?.script).toBe('V001__init_schema.sql');
    expect(migrations.some((m) => m.script.startsWith('V075'))).toBe(true);
    for (let i = 1; i < migrations.length; i += 1) {
      expect(compareVersions(migrations[i - 1].version, migrations[i].version)).toBeLessThan(0);
    }
  });
});

class FakeFlywayDb implements FlywayDb {
  tables = new Set<string>();
  history: Array<Record<string, unknown>> = [];
  executed: string[] = [];
  lock = 1;
  failScript?: string;

  async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT GET_LOCK')) {
      return [{ acquired: this.lock } as unknown as T];
    }
    if (s.startsWith('SELECT RELEASE_LOCK')) {
      return [{ released: 1 } as unknown as T];
    }
    if (s.includes('information_schema.tables') && s.includes('AND table_name =')) {
      return (this.tables.has(HISTORY) ? [{ c: 1 }] : []) as T[];
    }
    if (s.includes('information_schema.tables') && s.includes('table_name <>')) {
      return [...this.tables]
        .filter((t) => t !== HISTORY)
        .map((tableName) => ({ tableName })) as T[];
    }
    if (s.startsWith('CREATE TABLE') && s.includes(HISTORY)) {
      this.tables.add(HISTORY);
      return [] as T[];
    }
    if (s.startsWith('DELETE FROM')) {
      this.history = this.history.filter((r) => Number(r.success) !== 0);
      return [] as T[];
    }
    if (s.startsWith('SELECT installed_rank')) {
      return this.history as T[];
    }
    if (s.startsWith('INSERT INTO')) {
      this.history.push({
        installed_rank: params[0],
        version: params[1],
        description: params[2],
        type: params[3],
        script: params[4],
        checksum: params[5],
        installed_by: params[6],
        execution_time: params[7],
        success: params[8],
      });
      return [] as T[];
    }
    this.executed.push(sql);
    if (this.failScript && sql.includes(this.failScript)) {
      throw new Error('syntax error');
    }
    return [] as T[];
  }
}

const HISTORY = 'flyway_schema_history';

describe('migrateWithDb', () => {
  const sample = [
    {
      version: '001',
      versionRank: [1],
      description: 'init',
      script: 'V001__init.sql',
      checksum: 11,
      sql: 'CREATE TABLE t (id INT);',
    },
    {
      version: '002',
      versionRank: [2],
      description: 'next',
      script: 'V002__next.sql',
      checksum: 22,
      sql: 'ALTER TABLE t ADD COLUMN n INT;',
    },
  ];

  it('applies pending SQL and records history', async () => {
    const db = new FakeFlywayDb();
    const result = await migrateWithDb(db, sample, {
      baselineOnMigrate: true,
      baselineVersion: '12',
      validateOnMigrate: false,
      installedBy: 'mao',
    });
    expect(result.applied).toEqual(['V001__init.sql', 'V002__next.sql']);
    expect(db.history).toHaveLength(2);
    expect(db.history[0]?.success).toBe(1);
    expect(db.history[0]?.script).toBe('V001__init.sql');
  });

  it('baselines a non-empty schema and skips versions up to baseline', async () => {
    const db = new FakeFlywayDb();
    db.tables.add('user');
    const result = await migrateWithDb(db, sample, {
      baselineOnMigrate: true,
      baselineVersion: '001',
      validateOnMigrate: false,
      installedBy: 'mao',
    });
    expect(db.history[0]?.type).toBe('BASELINE');
    expect(result.applied).toEqual(['V002__next.sql']);
  });

  it('skips already applied versions', async () => {
    const db = new FakeFlywayDb();
    db.tables.add(HISTORY);
    db.history.push({
      installed_rank: 1,
      version: '001',
      description: 'init',
      type: 'SQL',
      script: 'V001__init.sql',
      checksum: 11,
      success: 1,
    });
    const result = await migrateWithDb(db, sample, {
      baselineOnMigrate: true,
      baselineVersion: '12',
      validateOnMigrate: false,
      installedBy: 'mao',
    });
    expect(result.applied).toEqual(['V002__next.sql']);
  });

  it('records failed migrations and throws', async () => {
    const db = new FakeFlywayDb();
    db.failScript = 'CREATE TABLE t';
    await expect(
      migrateWithDb(db, sample, {
        baselineOnMigrate: false,
        baselineVersion: '12',
        validateOnMigrate: false,
        installedBy: 'mao',
      }),
    ).rejects.toThrow(/V001__init.sql/);
    expect(db.history.some((r) => Number(r.success) === 0)).toBe(true);
  });

  it('validateOnMigrate rejects checksum mismatch', async () => {
    const db = new FakeFlywayDb();
    db.tables.add(HISTORY);
    db.history.push({
      installed_rank: 1,
      version: '001',
      description: 'init',
      type: 'SQL',
      script: 'V001__init.sql',
      checksum: 999,
      success: 1,
    });
    await expect(
      migrateWithDb(db, sample, {
        baselineOnMigrate: false,
        baselineVersion: '12',
        validateOnMigrate: true,
        installedBy: 'mao',
      }),
    ).rejects.toThrow(/checksum mismatch/);
  });
});

describe('runFlywayIfEnabled with injected db', () => {
  it('migrates using resolved SQL files', async () => {
    const db = new FakeFlywayDb();
    const close = vi.fn(async () => undefined);
    const cfg = {
      spring: {
        datasource: { url: 'jdbc:mysql://127.0.0.1:3306/mao', username: 'root', password: '' },
        flyway: {
          enabled: true,
          baselineOnMigrate: true,
          baselineVersion: '12',
          validateOnMigrate: false,
          locations: 'filesystem:db/migration',
        },
      },
    } as AppConfig;
    await runFlywayIfEnabled(cfg, process.cwd(), async () => ({ db, close }));
    expect(close).toHaveBeenCalled();
    expect(db.history.length).toBeGreaterThan(0);
    expect(String(db.history[0]?.script)).toMatch(/^V001__/);
  });
});
