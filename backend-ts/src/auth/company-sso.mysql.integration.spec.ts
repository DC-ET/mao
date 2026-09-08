import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Db } from '../db/db.js';
import { MysqlUserRepository } from '../user/user.repository.js';
import { CompanySsoIdentityRepository } from './company-sso-identity.repository.js';

// Explicit isolated Unix socket only; never load application DB config or default sockets.
const socket = process.env.SSO_TEST_MYSQL_SOCKET;
const database = `sso_test_${randomUUID().replaceAll('-', '')}`;
const migration = (name: string) => readFileSync(new URL(`../../db/migration/${name}`, import.meta.url), 'utf8');
const identity = (subject = '3089', email = 'Synthetic@example.test') => ({ subject, email, displayName: 'Synthetic', expiresAt: Date.now() + 3600000 });

describe.skipIf(!socket)('company SSO isolated MySQL integration', () => {
  let admin: mysql.Connection | undefined;
  let db: Db;
  let users: MysqlUserRepository;
  let identities: CompanySsoIdentityRepository;

  beforeAll(async () => {
    if (!socket || !/^\/.*\/sso-mysql-[A-Za-z0-9_-]+\/mysql\.sock$/.test(socket)
      || realpathSync(socket) !== socket) throw new Error('SSO tests require an explicitly isolated sso-mysql-* socket');
    admin = await mysql.createConnection({ socketPath: socket, user: 'root', password: '' });
    const [rows] = await admin.query<mysql.RowDataPacket[]>('SELECT @@socket AS socket, @@skip_networking AS isolated');
    expect(rows[0]).toMatchObject({ socket, isolated: 1 });
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const pool = mysql.createPool({ socketPath: socket, user: 'root', password: '', database, connectionLimit: 16 });
    db = new Db(pool);
    const initial = migration('V001__init_schema.sql');
    for (const table of ['user', 'role', 'user_role']) {
      const statement = initial.match(new RegExp('CREATE TABLE IF NOT EXISTS `' + table + '` \\([\\s\\S]*?;'))?.[0];
      if (!statement) throw new Error(`Missing original schema: ${table}`);
      await db.execute(statement);
    }
    await db.execute(migration('V030__drop_auth_type.sql'));
    const deletion = migration('V052__add_logical_delete_to_agent_user_command_file_session_todo_llm_model_role_user.sql');
    for (const table of ['role', 'user']) {
      const statement = deletion.match(new RegExp('ALTER TABLE `' + table + '`[\\s\\S]*?;'))?.[0];
      if (!statement) throw new Error(`Missing deletion migration: ${table}`);
      await db.execute(statement);
    }
    for (const statement of migration('V106__company_sso_identity.sql').split(';').filter((sql) => sql.trim())) await db.execute(statement);
    await db.insert('role', { id: 1, name: 'Administrator', code: 'ADMIN' });
    await db.insert('role', { id: 2, name: 'Ordinary', code: 'USER' });
    users = new MysqlUserRepository(db);
    identities = new CompanySsoIdentityRepository(db);
  });

  afterAll(async () => {
    await db?.close();
    if (admin) {
      try { await admin.query(`DROP DATABASE IF EXISTS \`${database}\``); }
      finally { await admin.end(); }
    }
  });

  beforeEach(async () => {
    await db.execute('DROP TRIGGER IF EXISTS reject_sso_binding');
    await db.execute('DELETE FROM user_external_identity');
    await db.execute('DELETE FROM user_role');
    await db.execute('DELETE FROM `user`');
  });

  const createUser = async (email = identity().email, status = 1, deleted = 0) => db.insert('user', {
    username: `test_${randomUUID().replaceAll('-', '')}`, displayName: 'Local name', email, status, deleted, passwordHash: 'synthetic-hash',
  });
  const count = async (table: string) => Number((await db.queryOne<{ count: number }>(`SELECT COUNT(*) AS count FROM \`${table}\``))!.count);

  it('concurrent same subject creates exactly one user, role and binding', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => identities.resolve(identity())));
    expect(new Set(results.map((result) => result.user.id)).size).toBe(1);
    expect(results.filter((result) => result.action === 'created')).toHaveLength(1);
    expect(await count('user')).toBe(1);
    expect(await count('user_role')).toBe(1);
    expect(await count('user_external_identity')).toBe(1);
    expect(await db.query('SELECT role_id FROM user_role')).toEqual([{ roleId: 2 }]);
  });

  it('concurrent different subjects sharing an email have one winner and no orphan', async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => identities.resolve(identity(String(i + 1)))));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 409 });
    expect(await count('user')).toBe(1);
    expect(await count('user_role')).toBe(1);
    expect(await count('user_external_identity')).toBe(1);
  });

  it.each([1, 2])('binds unique email without changing password, display name or role_id=%s; binding wins later', async (roleId) => {
    const id = await createUser();
    await db.insert('user_role', { userId: id, roleId });
    expect(await identities.resolve(identity())).toMatchObject({ action: 'bound', user: { id, displayName: 'Local name', passwordHash: 'synthetic-hash' } });
    expect(await identities.resolve(identity('3089', 'Changed@example.test'))).toMatchObject({ action: 'existing', user: { id } });
    expect(await db.query('SELECT role_id FROM user_role')).toEqual([{ roleId }]);
  });

  it.each(['disabled', 'deleted', 'duplicate'] as const)('refuses %s email without new users or bindings', async (kind) => {
    const id = await createUser(undefined, kind === 'disabled' ? 0 : 1, kind === 'deleted' ? 1 : 0);
    if (kind === 'duplicate') await createUser();
    await expect(identities.resolve(identity())).rejects.toMatchObject({ status: kind === 'duplicate' ? 409 : 403 });
    expect(await count('user_external_identity')).toBe(0);
    expect(await count('user')).toBe(kind === 'duplicate' ? 2 : 1);
  });

  it('rolls back inserted user and role after actual SQL binding failure', async () => {
    await db.execute("CREATE TRIGGER reject_sso_binding BEFORE INSERT ON user_external_identity FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic failure'");
    await expect(identities.resolve(identity())).rejects.toThrow('synthetic failure');
    expect(await count('user')).toBe(0);
    expect(await count('user_role')).toBe(0);
    expect(await count('user_external_identity')).toBe(0);
  });

  it.each(['insert', 'updateFields', 'updateById'] as const)('serializes concurrent repository %s email write with SSO', async (method) => {
    const id = method === 'insert' ? undefined : await createUser('Old@example.test');
    const write = () => method === 'insert'
      ? users.insert({ username: 'local_racer', displayName: 'Local racer', email: identity().email })
      : method === 'updateFields'
        ? users.updateFields(id!, { email: identity().email })
        : users.updateById({ id, username: 'local_racer', displayName: 'Local racer', email: identity().email, status: 1 });
    const [sso, local] = await Promise.allSettled([identities.resolve(identity()), write()]);
    expect(sso.status).toBe('fulfilled');
    const matching = await db.query<{ id: number }>('SELECT id FROM `user` WHERE BINARY email = BINARY ?', [identity().email]);
    expect(matching).toHaveLength(1);
    const binding = await db.queryOne<{ userId: number }>('SELECT user_id FROM user_external_identity');
    expect(binding!.userId).toBe(matching[0].id);
    if (local.status === 'rejected') expect(local.reason.message).toContain('该邮箱已被其他用户使用');
    expect(await count('user')).toBe(method === 'insert' || local.status === 'fulfilled' ? 1 : 2);
  });

  it('email writer holding the transaction lock blocks SSO until commit', async () => {
    const id = await createUser('Old@example.test');
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const writer = db.transaction(async (tx) => {
      await tx.queryOne('SELECT id FROM user_identity_write_lock WHERE id = 1 FOR UPDATE');
      await tx.updateById('user', id, { email: identity().email });
      acquired();
      await gate;
    });
    await ready;
    let settled = false;
    const exchange = identities.resolve(identity()).finally(() => { settled = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
    } finally { release(); }
    await writer;
    expect(await exchange).toMatchObject({ action: 'bound', user: { id } });
    expect(await count('user')).toBe(1);
  });
});
