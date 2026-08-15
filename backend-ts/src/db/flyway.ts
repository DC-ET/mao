import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import mysql from 'mysql2/promise';
import type { AppConfig } from '../config/app-config.js';
import { parseJdbcUrl } from '../config/app-config.js';

const HISTORY_TABLE = 'flyway_schema_history';
const LOCK_NAME = 'Flyway';
const FILE_RE = /^V(\d+(?:\.\d+)*)__(.+)\.sql$/i;

export interface FlywayDb {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface FlywayMigration {
  version: string;
  versionRank: number[];
  description: string;
  script: string;
  checksum: number;
  sql: string;
}

interface HistoryRow {
  installedRank: number;
  version: string | null;
  description: string;
  type: string;
  script: string;
  checksum: number | null;
  success: number;
}

/**
 * Flyway CRC32: hash each line without line endings (UTF-8), signed int32.
 * Matches org.flywaydb.core.internal.resolver.ChecksumCalculator.
 */
export function flywayChecksum(content: string): number {
  let hash = 0;
  const normalized = content.replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r\n|\n|\r/);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  for (const line of lines) {
    hash = crc32(Buffer.from(line, 'utf8'), hash);
  }
  return hash | 0;
}

export function parseMigrationName(filename: string): { version: string; description: string } | null {
  const m = FILE_RE.exec(filename);
  if (!m) {
    return null;
  }
  return { version: m[1], description: m[2].replace(/_/g, ' ') };
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0);
  const pb = b.split('.').map((n) => Number(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
}

function hasSqlFiles(dir: string): boolean {
  return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.sql'));
}

export function resolveMigrationDir(cwd = process.cwd(), locations = 'filesystem:db/migration'): string {
  const loc = locations.replace(/^filesystem:/, '');
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(cwd, loc),
    resolve(here, '../../db/migration'),
  ];
  for (const dir of candidates) {
    if (hasSqlFiles(dir)) {
      return dir;
    }
  }
  throw new Error(`Flyway locations not found: ${candidates[0]}`);
}

export function listMigrations(dir: string): FlywayMigration[] {
  return readdirSync(dir)
    .map((script) => {
      const parsed = parseMigrationName(script);
      if (!parsed) {
        return null;
      }
      const sql = readFileSync(resolve(dir, script), 'utf8');
      return {
        version: parsed.version,
        versionRank: parsed.version.split('.').map((n) => Number(n) || 0),
        description: parsed.description,
        script,
        checksum: flywayChecksum(sql),
        sql,
      } satisfies FlywayMigration;
    })
    .filter((m): m is FlywayMigration => m !== null)
    .sort((a, b) => compareVersions(a.version, b.version));
}

async function createHistoryTable(db: FlywayDb): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS \`${HISTORY_TABLE}\` (
      \`installed_rank\` INT NOT NULL,
      \`version\` VARCHAR(50) DEFAULT NULL,
      \`description\` VARCHAR(200) NOT NULL,
      \`type\` VARCHAR(20) NOT NULL,
      \`script\` VARCHAR(1000) NOT NULL,
      \`checksum\` INT DEFAULT NULL,
      \`installed_by\` VARCHAR(100) NOT NULL,
      \`installed_on\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`execution_time\` INT NOT NULL,
      \`success\` TINYINT(1) NOT NULL,
      PRIMARY KEY (\`installed_rank\`),
      INDEX \`flyway_schema_history_s_idx\` (\`success\`)
    ) ENGINE=InnoDB
  `);
}

async function loadHistory(db: FlywayDb): Promise<HistoryRow[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT installed_rank, version, description, type, script, checksum, success FROM \`${HISTORY_TABLE}\` ORDER BY installed_rank`,
  );
  return rows.map((r) => ({
    installedRank: Number(r.installedRank ?? r.installed_rank),
    version: r.version == null ? null : String(r.version),
    description: String(r.description ?? ''),
    type: String(r.type ?? ''),
    script: String(r.script ?? ''),
    checksum: r.checksum == null ? null : Number(r.checksum),
    success: Number(r.success),
  }));
}

async function insertHistory(
  db: FlywayDb,
  row: {
    installedRank: number;
    version: string | null;
    description: string;
    type: string;
    script: string;
    checksum: number | null;
    installedBy: string;
    executionTime: number;
    success: boolean;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO \`${HISTORY_TABLE}\`
      (installed_rank, version, description, type, script, checksum, installed_by, execution_time, success)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.installedRank,
      row.version,
      row.description,
      row.type,
      row.script,
      row.checksum,
      row.installedBy,
      row.executionTime,
      row.success ? 1 : 0,
    ],
  );
}

export async function migrateWithDb(
  db: FlywayDb,
  migrations: FlywayMigration[],
  opts: {
    baselineOnMigrate: boolean;
    baselineVersion: string;
    validateOnMigrate: boolean;
    installedBy: string;
  },
): Promise<{ applied: string[] }> {
  const lockRows = await db.query<{ acquired?: number }>(`SELECT GET_LOCK(?, 60) AS acquired`, [LOCK_NAME]);
  if (Number(lockRows[0]?.acquired) !== 1) {
    throw new Error('Flyway migrate failed: could not acquire MySQL GET_LOCK(Flyway)');
  }
  const applied: string[] = [];
  try {
    const existing = await db.query<{ c?: number }>(
      `SELECT 1 AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
      [HISTORY_TABLE],
    );
    if (existing.length === 0) {
      await createHistoryTable(db);
      const others = await db.query<{ tableName?: string }>(
        `SELECT table_name AS tableName FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name <> ?`,
        [HISTORY_TABLE],
      );
      if (opts.baselineOnMigrate && others.length > 0) {
        await insertHistory(db, {
          installedRank: 1,
          version: opts.baselineVersion,
          description: '<< Flyway Baseline >>',
          type: 'BASELINE',
          script: '<< Flyway Baseline >>',
          checksum: null,
          installedBy: opts.installedBy,
          executionTime: 0,
          success: true,
        });
      }
    }

    await db.query(`DELETE FROM \`${HISTORY_TABLE}\` WHERE success = 0`);
    const history = await loadHistory(db);

    if (opts.validateOnMigrate) {
      const byVersion = new Map(migrations.map((m) => [m.version, m]));
      for (const row of history) {
        if (row.type !== 'SQL' || row.version == null) {
          continue;
        }
        const file = byVersion.get(row.version);
        if (file && row.checksum != null && file.checksum !== row.checksum) {
          throw new Error(`Flyway validate failed: checksum mismatch for ${file.script}`);
        }
      }
    }

    const appliedVersions = new Set(history.filter((r) => r.success === 1 && r.version).map((r) => r.version as string));
    let baseline: string | null = null;
    for (const row of history) {
      if (row.type === 'BASELINE' && row.version) {
        baseline = row.version;
      }
    }
    let nextRank = history.reduce((max, r) => Math.max(max, r.installedRank), 0) + 1;

    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }
      if (baseline && compareVersions(migration.version, baseline) <= 0) {
        continue;
      }
      const started = Date.now();
      try {
        await db.query(migration.sql);
        await insertHistory(db, {
          installedRank: nextRank,
          version: migration.version,
          description: migration.description,
          type: 'SQL',
          script: migration.script,
          checksum: migration.checksum,
          installedBy: opts.installedBy,
          executionTime: Date.now() - started,
          success: true,
        });
        applied.push(migration.script);
        nextRank += 1;
        console.info(`Flyway migrated ${migration.script}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          await insertHistory(db, {
            installedRank: nextRank,
            version: migration.version,
            description: migration.description,
            type: 'SQL',
            script: migration.script,
            checksum: migration.checksum,
            installedBy: opts.installedBy,
            executionTime: Date.now() - started,
            success: false,
          });
        } catch {
          // history insert after failure is best-effort
        }
        throw new Error(`Flyway migrate failed: ${migration.script}: ${message}`);
      }
    }
    return { applied };
  } finally {
    await db.query(`SELECT RELEASE_LOCK(?) AS released`, [LOCK_NAME]).catch(() => undefined);
  }
}

async function connectFlywayDb(cfg: AppConfig): Promise<{ db: FlywayDb; close: () => Promise<void> }> {
  const jdbc = parseJdbcUrl(cfg.spring.datasource.url);
  const conn = await mysql.createConnection({
    host: jdbc.host,
    port: jdbc.port,
    user: cfg.spring.datasource.username,
    password: cfg.spring.datasource.password,
    database: jdbc.database,
    multipleStatements: true,
    charset: 'utf8mb4',
    timezone: '+08:00',
  });
  return {
    db: {
      async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
        const [rows] = await conn.query(sql, params);
        return rows as T[];
      },
    },
    close: () => conn.end(),
  };
}

/**
 * Schema owner: TypeScript backend.
 * Uses the SQL files in db/migration and the shared flyway_schema_history table.
 */
export async function runFlywayIfEnabled(
  cfg: AppConfig,
  cwd = process.cwd(),
  dbFactory: (cfg: AppConfig) => Promise<{ db: FlywayDb; close: () => Promise<void> }> = connectFlywayDb,
): Promise<void> {
  if (!cfg.spring.flyway.enabled) {
    return;
  }
  const dir = resolveMigrationDir(cwd, cfg.spring.flyway.locations);
  const migrations = listMigrations(dir);
  const { db, close } = await dbFactory(cfg);
  try {
    await migrateWithDb(db, migrations, {
      baselineOnMigrate: cfg.spring.flyway.baselineOnMigrate,
      baselineVersion: cfg.spring.flyway.baselineVersion,
      validateOnMigrate: cfg.spring.flyway.validateOnMigrate,
      installedBy: cfg.spring.datasource.username,
    });
  } finally {
    await close();
  }
}
