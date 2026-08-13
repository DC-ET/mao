import mysql from 'mysql2/promise';
import { loadConfig, parseJdbcUrl, type AppConfig } from '../config/app-config.js';
import { toCamel, toCamelList, toSnakeRow } from '../common/case.js';

export class Db {
  constructor(private readonly pool: mysql.Pool) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await this.pool.query(sql, params);
    return toCamelList<T>(rows as Record<string, unknown>[]);
  }

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<mysql.ResultSetHeader> {
    const [result] = await this.pool.execute(sql, params as never);
    return result as mysql.ResultSetHeader;
  }

  async insert(table: string, data: object): Promise<number> {
    const row = toSnakeRow(data as Record<string, unknown>);
    const keys = Object.keys(row);
    const sql = `INSERT INTO \`${table}\` (${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    const result = await this.execute(sql, Object.values(row));
    return Number(result.insertId);
  }

  async updateById(table: string, id: number, data: object): Promise<void> {
    const row = toSnakeRow(data as Record<string, unknown>);
    const keys = Object.keys(row);
    if (keys.length === 0) {
      return;
    }
    const sql = `UPDATE \`${table}\` SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`;
    await this.execute(sql, [...Object.values(row), id]);
  }

  async transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    const tx = new Db(conn as unknown as mysql.Pool);
    try {
      await conn.beginTransaction();
      const result = await fn(tx);
      await conn.commit();
      return result;
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createPool(cfg: AppConfig = loadConfig()): mysql.Pool {
  const jdbc = parseJdbcUrl(cfg.spring.datasource.url);
  return mysql.createPool({
    host: jdbc.host,
    port: jdbc.port,
    user: cfg.spring.datasource.username,
    password: cfg.spring.datasource.password,
    database: jdbc.database,
    waitForConnections: true,
    connectionLimit: cfg.spring.datasource.hikari.maximumPoolSize,
    queueLimit: 0,
    connectTimeout: cfg.spring.datasource.hikari.connectionTimeout,
    dateStrings: true,
    // Keep MySQL JSON columns as strings so parsers match Java/MyBatis.
    jsonStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    decimalNumbers: true,
    charset: 'utf8mb4',
    timezone: '+08:00',
  });
}

export function notDeleted(alias?: string): string {
  return alias ? `${alias}.deleted = 0` : 'deleted = 0';
}
