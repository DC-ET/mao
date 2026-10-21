import { describe, expect, it } from 'vitest';
import { MysqlHttpToolRepository } from './http-tool.repository.js';
import { toSnakeRow } from '../common/case.js';
import type { Db } from '../db/db.js';
import type { HttpTool, HttpToolParam } from './types.js';

/**
 * 仓库层回归（曾因 DELETE 走 db.query 触发 rows.map is not a function 的 500）：
 * 假 Db 复刻 mysql2 契约——query 只接受 SELECT（写语句会被 toCamelList 当行数组 .map 而抛错），
 * 写语句一律走 execute。锁住「DELETE/UPDATE/INSERT 不得使用 query」这条约定。
 */
function makeDb(options: {
  rows?: Record<string, unknown>[];
  one?: Record<string, unknown> | null;
} = {}) {
  const calls: Array<{ kind: 'query' | 'execute'; sql: string; params: unknown[] }> = [];
  const db = {
    calls,
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      calls.push({ kind: 'query', sql, params });
      if (!/^\s*SELECT/i.test(sql)) {
        throw new TypeError('rows.map is not a function');
      }
      return (options.rows ?? []) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
      calls.push({ kind: 'query', sql, params });
      return (options.one ?? null) as T | null;
    },
    async execute(sql: string, params: unknown[] = []): Promise<never> {
      calls.push({ kind: 'execute', sql, params });
      return { affectedRows: 1 } as never;
    },
    async insert(table: string, data: object): Promise<number> {
      const rowData = toSnakeRow(data as Record<string, unknown>);
      calls.push({ kind: 'execute', sql: `INSERT INTO ${table}`, params: [rowData] });
      return 7;
    },
    async updateById(table: string, id: number, data: object): Promise<void> {
      const rowData = toSnakeRow(data as Record<string, unknown>);
      calls.push({ kind: 'execute', sql: `UPDATE ${table} WHERE id=${id}`, params: [rowData] });
    },
    async transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      return fn(db as unknown as Db);
    },
  };
  return db;
}

function row(overrides: Partial<HttpTool> = {}): HttpTool {
  return {
    id: 3,
    name: 'weather',
    displayName: '天气查询',
    description: '查天气',
    method: 'GET',
    url: 'https://api.example.com/weather',
    headersJson: null,
    bodyTemplate: null,
    readOnly: 1,
    timeoutMs: 15000,
    enabled: 1,
    createdAt: '2026-10-20 10:00:00',
    updatedAt: '2026-10-20 10:00:00',
    ...overrides,
  };
}

function paramRow(overrides: Partial<HttpToolParam> = {}): HttpToolParam {
  return { id: 1, toolId: 3, name: 'city', label: '城市', type: 'string', required: 1, defaultValue: null, sortOrder: 0, ...overrides };
}

describe('MysqlHttpToolRepository write statements', () => {
  it('deletes params and the row through execute (not query)', async () => {
    const db = makeDb();
    const repo = new MysqlHttpToolRepository(db as unknown as Db);
    await repo.deleteById(3);
    const sqls = db.calls.map((call) => call.sql);
    expect(sqls).toContain('DELETE FROM http_tool_param WHERE tool_id = ?');
    expect(sqls).toContain('DELETE FROM http_tool WHERE id = ?');
    // 参数行先删、主行后删（外键无约束，顺序仅保证语义清晰）
    expect(db.calls.map((call) => call.kind)).toEqual(['execute', 'execute']);
  });

  it('deleteParamsByToolId uses execute so the update path does not 500', async () => {
    const db = makeDb();
    const repo = new MysqlHttpToolRepository(db as unknown as Db);
    await repo.deleteParamsByToolId(3);
    expect(db.calls).toEqual([{ kind: 'execute', sql: 'DELETE FROM http_tool_param WHERE tool_id = ?', params: [3] }]);
  });

  it('insert maps camelCase fields to snake_case columns', async () => {
    const db = makeDb();
    const repo = new MysqlHttpToolRepository(db as unknown as Db);
    const id = await repo.insert(row());
    expect(id).toBe(7);
    const insertCall = db.calls.find((call) => call.sql.startsWith('INSERT INTO http_tool'));
    expect(insertCall).toBeDefined();
    const data = insertCall!.params[0] as Record<string, unknown>;
    expect(Object.keys(data)).toContain('display_name');
    expect(Object.keys(data)).toContain('headers_json');
    expect(Object.keys(data)).toContain('body_template');
    expect(Object.keys(data)).toContain('read_only');
    expect(Object.keys(data)).toContain('timeout_ms');
    expect(Object.keys(data)).not.toContain('displayName');
  });

  it('insertParam maps toolId / sortOrder to snake_case columns', async () => {
    const db = makeDb();
    const repo = new MysqlHttpToolRepository(db as unknown as Db);
    await repo.insertParam(paramRow());
    const insertCall = db.calls.find((call) => call.sql.startsWith('INSERT INTO http_tool_param'));
    const data = insertCall!.params[0] as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(expect.arrayContaining(['tool_id', 'sort_order', 'default_value']));
    expect(Object.keys(data)).not.toContain('toolId');
  });

  it('updateById writes the full mutable column set', async () => {
    const db = makeDb();
    const repo = new MysqlHttpToolRepository(db as unknown as Db);
    await repo.updateById(row({ displayName: '新名字' }));
    const updateCall = db.calls.find((call) => call.sql.startsWith('UPDATE http_tool'));
    const data = updateCall!.params[0] as Record<string, unknown>;
    expect(data.display_name).toBe('新名字');
    expect(data.headers_json).toBeNull();
    expect(data.enabled).toBe(1);
  });
});

describe('MysqlHttpToolRepository read statements', () => {
  it('lists enabled tools by id set ordered by name', async () => {
    const db = makeDb({ rows: [row()] });
    const repo = new MysqlHttpToolRepository(db as unknown as Db);
    const list = await repo.listEnabledByIds([3, 4]);
    expect(list).toHaveLength(1);
    expect(db.calls[0]!.sql).toContain('enabled = 1');
    expect(db.calls[0]!.sql).toContain('id IN (?,?)');
    expect(db.calls[0]!.sql).toContain('ORDER BY name ASC');
    expect(db.calls[0]!.params).toEqual([3, 4]);
  });

  it('looks up by id and by globally unique name', async () => {
    const db = makeDb({ one: row() });
    const repo = new MysqlHttpToolRepository(db as unknown as Db);
    await repo.findById(3);
    await repo.findByName('weather');
    expect(db.calls[0]!.sql).toContain('WHERE id = ?');
    expect(db.calls[1]!.sql).toContain('WHERE name = ?');
    expect(db.calls[1]!.params).toEqual(['weather']);
  });

  it('orders params by sort_order then id', async () => {
    const db = makeDb({ rows: [paramRow()] });
    const repo = new MysqlHttpToolRepository(db as unknown as Db);
    await repo.listParamsByToolId(3);
    expect(db.calls[0]!.sql).toContain('ORDER BY sort_order ASC, id ASC');
    expect(db.calls[0]!.params).toEqual([3]);
  });

  it('lists enabled brief rows for the agent form select', async () => {
    const db = makeDb({ rows: [row()] });
    const repo = new MysqlHttpToolRepository(db as unknown as Db);
    await repo.listEnabledBrief();
    expect(db.calls[0]!.sql).toContain('WHERE enabled = 1');
    expect(db.calls[0]!.sql).toContain('ORDER BY name ASC');
  });
});

describe('MysqlHttpToolRepository admin listing', () => {
  it('escapes LIKE wildcards in keyword filter', async () => {
    const db = makeDb({ rows: [], one: { c: 0 } });
    const repo = new MysqlHttpToolRepository(db as unknown as Db);
    await repo.listForAdmin(2, 50, { keyword: '100%_x' });
    const countSql = db.calls[0]!.sql;
    expect(countSql).toContain('name LIKE ?');
    expect(countSql).toContain('display_name LIKE ?');
    expect(db.calls[0]!.params).toEqual(['%100\\%\\_x%', '%100\\%\\_x%']);
  });

  it('applies LIMIT / OFFSET from page and size', async () => {
    const db = makeDb({ rows: [], one: { c: 0 } });
    const repo = new MysqlHttpToolRepository(db as unknown as Db);
    await repo.listForAdmin(3, 20, {});
    const listCall = db.calls[1]!;
    expect(listCall.sql).toContain('LIMIT ? OFFSET ?');
    expect(listCall.params).toEqual([20, 40]);
  });

  it('filters by enabled state with a boolean flag', async () => {
    const db = makeDb({ rows: [], one: { c: 0 } });
    const repo = new MysqlHttpToolRepository(db as unknown as Db);
    await repo.listForAdmin(1, 20, { enabled: false });
    expect(db.calls[0]!.sql).toContain('enabled = ?');
    expect(db.calls[0]!.params).toContain(0);
  });

  it('omits the WHERE clause when no filter is given', async () => {
    const db = makeDb({ rows: [], one: { c: 0 } });
    const repo = new MysqlHttpToolRepository(db as unknown as Db);
    const result = await repo.listForAdmin(1, 20, {});
    expect(db.calls[0]!.sql).not.toContain('WHERE');
    expect(result).toEqual({ rows: [], total: 0 });
  });

  it('returns total as a number', async () => {
    const db = makeDb({ rows: [], one: { c: '12' } });
    const repo = new MysqlHttpToolRepository(db as unknown as Db);
    const result = await repo.listForAdmin(1, 20, {});
    expect(result.total).toBe(12);
  });
});
