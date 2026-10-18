import type { Db } from '../db/db.js';
import type { EnvVariable, EnvVariablePatch, EnvVariableRepository } from './types.js';

const USER_TABLE = 'user_env_variable';
const WORKSPACE_TABLE = 'workspace_env_variable';
const SYSTEM_TABLE = 'system_env_variable';

/**
 * MySQL 实现：三个薄方法组共享泛型 helper，差异列（user_id / workspace_path）在
 * 各层显式写出，不在 SQL 里条件拼列。
 *
 * 所有删除 / 查询条件都带归属列（user_id、workspace_path），保证「猜到 id 也改不到
 * 别人的变量」；表名是内部常量，不接受外部输入。
 */
export class MysqlEnvVariableRepository implements EnvVariableRepository {
  constructor(private readonly db: Db) {}

  private listBy(table: string, where: string, params: unknown[]): Promise<EnvVariable[]> {
    return this.db.query<EnvVariable>(
      `SELECT * FROM \`${table}\` WHERE ${where} ORDER BY updated_at DESC, id DESC`,
      params,
    );
  }

  private findOneBy(table: string, where: string, params: unknown[]): Promise<EnvVariable | null> {
    return this.db.queryOne<EnvVariable>(`SELECT * FROM \`${table}\` WHERE ${where}`, params);
  }

  private async countBy(table: string, where: string, params: unknown[]): Promise<number> {
    const row = await this.db.queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM \`${table}\` WHERE ${where}`,
      params,
    );
    return Number(row?.total ?? 0);
  }

  private async updateBy(table: string, where: string, whereParams: unknown[], patch: EnvVariablePatch): Promise<void> {
    const columns: string[] = [];
    const values: unknown[] = [];
    if (patch.envKey !== undefined) {
      columns.push('`env_key` = ?');
      values.push(patch.envKey);
    }
    if (patch.envValue !== undefined) {
      columns.push('`env_value` = ?');
      values.push(patch.envValue);
    }
    if (patch.note !== undefined) {
      columns.push('`note` = ?');
      values.push(patch.note);
    }
    if (columns.length === 0) return;
    await this.db.execute(
      `UPDATE \`${table}\` SET ${columns.join(', ')} WHERE ${where}`,
      [...values, ...whereParams],
    );
  }

  // ---- 系统层 ----

  listSystem(): Promise<EnvVariable[]> {
    return this.listBy(SYSTEM_TABLE, '1 = 1', []);
  }

  findSystemById(id: number): Promise<EnvVariable | null> {
    return this.findOneBy(SYSTEM_TABLE, 'id = ?', [id]);
  }

  findSystemByKey(envKey: string): Promise<EnvVariable | null> {
    return this.findOneBy(SYSTEM_TABLE, 'env_key = ?', [envKey]);
  }

  countSystem(): Promise<number> {
    return this.countBy(SYSTEM_TABLE, '1 = 1', []);
  }

  insertSystem(row: EnvVariable): Promise<number> {
    return this.db.insert(SYSTEM_TABLE, {
      envKey: row.envKey,
      envValue: row.envValue,
      note: row.note ?? null,
    });
  }

  updateSystem(id: number, patch: EnvVariablePatch): Promise<void> {
    return this.updateBy(SYSTEM_TABLE, 'id = ?', [id], patch);
  }

  async deleteSystem(id: number): Promise<void> {
    await this.db.execute(`DELETE FROM \`${SYSTEM_TABLE}\` WHERE id = ?`, [id]);
  }

  // ---- 用户层 ----

  listUser(userId: number): Promise<EnvVariable[]> {
    return this.listBy(USER_TABLE, 'user_id = ?', [userId]);
  }

  findUserById(userId: number, id: number): Promise<EnvVariable | null> {
    return this.findOneBy(USER_TABLE, 'user_id = ? AND id = ?', [userId, id]);
  }

  findUserByKey(userId: number, envKey: string): Promise<EnvVariable | null> {
    return this.findOneBy(USER_TABLE, 'user_id = ? AND env_key = ?', [userId, envKey]);
  }

  countUser(userId: number): Promise<number> {
    return this.countBy(USER_TABLE, 'user_id = ?', [userId]);
  }

  insertUser(row: EnvVariable): Promise<number> {
    return this.db.insert(USER_TABLE, {
      userId: row.userId,
      envKey: row.envKey,
      envValue: row.envValue,
      note: row.note ?? null,
    });
  }

  updateUser(userId: number, id: number, patch: EnvVariablePatch): Promise<void> {
    return this.updateBy(USER_TABLE, 'user_id = ? AND id = ?', [userId, id], patch);
  }

  async deleteUser(userId: number, id: number): Promise<void> {
    await this.db.execute(`DELETE FROM \`${USER_TABLE}\` WHERE user_id = ? AND id = ?`, [userId, id]);
  }

  // ---- 工作区层 ----

  listWorkspace(userId: number, workspacePath: string): Promise<EnvVariable[]> {
    return this.listBy(WORKSPACE_TABLE, 'user_id = ? AND workspace_path = ?', [userId, workspacePath]);
  }

  listWorkspaceByUser(userId: number): Promise<EnvVariable[]> {
    return this.listBy(WORKSPACE_TABLE, 'user_id = ?', [userId]);
  }

  findWorkspaceById(userId: number, id: number): Promise<EnvVariable | null> {
    return this.findOneBy(WORKSPACE_TABLE, 'user_id = ? AND id = ?', [userId, id]);
  }

  findWorkspaceByKey(userId: number, workspacePath: string, envKey: string): Promise<EnvVariable | null> {
    return this.findOneBy(
      WORKSPACE_TABLE,
      'user_id = ? AND workspace_path = ? AND env_key = ?',
      [userId, workspacePath, envKey],
    );
  }

  countWorkspace(userId: number, workspacePath: string): Promise<number> {
    return this.countBy(WORKSPACE_TABLE, 'user_id = ? AND workspace_path = ?', [userId, workspacePath]);
  }

  insertWorkspace(row: EnvVariable): Promise<number> {
    return this.db.insert(WORKSPACE_TABLE, {
      workspacePath: row.workspacePath,
      userId: row.userId,
      envKey: row.envKey,
      envValue: row.envValue,
      note: row.note ?? null,
    });
  }

  updateWorkspace(userId: number, id: number, patch: EnvVariablePatch): Promise<void> {
    return this.updateBy(WORKSPACE_TABLE, 'user_id = ? AND id = ?', [userId, id], patch);
  }

  async deleteWorkspace(userId: number, id: number): Promise<void> {
    await this.db.execute(`DELETE FROM \`${WORKSPACE_TABLE}\` WHERE user_id = ? AND id = ?`, [userId, id]);
  }
}
