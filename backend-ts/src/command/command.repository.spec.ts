import { describe, expect, it, vi } from 'vitest';
import { Db } from '../db/db.js';
import { MysqlUserCommandRepository } from './command.repository.js';

describe('MysqlUserCommandRepository visibility', () => {
  it('visible query requires an active role overlap and rejects other visibility values', async () => {
    const query = vi.fn(async () => [[], []]);
    const repo = new MysqlUserCommandRepository(new Db({ query } as never));

    await repo.listVisibleSystemForUser(7);
    const [listSql, listParams] = query.mock.calls[0];
    expect(String(listSql)).toContain("c.visibility = 'all'");
    expect(String(listSql)).toContain("c.visibility = 'roles'");
    expect(String(listSql)).toContain('r.deleted = 0');
    expect(String(listSql)).toContain('ur.user_id = ?');
    expect(String(listSql)).not.toContain("visibility = 'all'\n    OR EXISTS");
    expect(listParams).toEqual([7]);

    await repo.isVisibleToUser(11, 7);
    const [oneSql, oneParams] = query.mock.calls[1];
    expect(String(oneSql)).toContain('c.id = ?');
    expect(String(oneSql)).toContain("c.visibility = 'roles'");
    expect(oneParams).toEqual([11, 7]);
  });

  it('role options and grants skip soft-deleted roles', async () => {
    const query = vi.fn(async () => [[], []]);
    const repo = new MysqlUserCommandRepository(new Db({ query } as never));
    await repo.listActiveRoles();
    expect(String(query.mock.calls[0][0])).toContain('deleted = 0');
    await repo.listActiveRoleGrants([3]);
    expect(String(query.mock.calls[1][0])).toContain('r.deleted = 0');
    expect(query.mock.calls[1][1]).toEqual([3]);
  });

  it('replaces role rows in one transaction and deletes them with the command', async () => {
    const calls: string[] = [];
    const tx = {
      execute: vi.fn(async (sql: string) => {
        calls.push(sql);
        return { insertId: 1 };
      }),
      insert: vi.fn(async (table: string) => {
        calls.push(`INSERT ${table}`);
        return 50;
      }),
      updateById: vi.fn(async (table: string, id: number, data: object) => {
        calls.push(`UPDATE ${table} ${id} ${JSON.stringify(data)}`);
      }),
      transaction: vi.fn(async (fn: (db: unknown) => Promise<unknown>) => fn(tx)),
    };
    const repo = new MysqlUserCommandRepository(tx as never);

    await repo.updateWithVisibility({ id: 9, userId: 0, name: 'review', content: 'x' }, 'all', [3]);
    expect(calls.some((sql) => sql.includes('DELETE FROM user_command_role'))).toBe(true);
    expect(calls.some((sql) => sql.startsWith('INSERT user_command_role'))).toBe(false);

    calls.length = 0;
    await repo.updateWithVisibility({ id: 9, userId: 0, name: 'review', content: 'x' }, 'roles', [3, 4]);
    expect(calls.filter((sql) => sql.startsWith('INSERT user_command_role'))).toHaveLength(2);

    calls.length = 0;
    await repo.deleteById(9);
    expect(calls[0]).toContain('DELETE FROM user_command_role');
    expect(calls.some((sql) => sql.includes('"deleted":1'))).toBe(true);
  });
});
