import type { CommandVisibility } from '@mao/contracts';
import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import type { CommandRoleGrant, CommandRoleOption, UserCommand, UserCommandRepository } from './types.js';

/**
 * 可见系统指令。脏 visibility 不走 EXISTS，避免列被写成别的值、又残留角色行时变成全员可见。
 * 占位符是当前用户 id。
 */
const VISIBLE_SYSTEM_PREDICATE = `
  (
    c.visibility = 'all'
    OR (
      c.visibility = 'roles'
      AND EXISTS (
        SELECT 1 FROM user_command_role cr
        INNER JOIN user_role ur ON ur.role_id = cr.role_id
        INNER JOIN role r ON r.id = cr.role_id AND r.deleted = 0
        WHERE cr.command_id = c.id AND ur.user_id = ?
      )
    )
  )
`;

/** 转义 LIKE 通配符（与 session.service escapeLike 语义一致），配合默认反斜杠转义。 */
function escapeLike(keyword: string): string {
  return keyword.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export class MysqlUserCommandRepository implements UserCommandRepository {
  constructor(private readonly db: Db) {}

  listByUserId(userId: number): Promise<UserCommand[]> {
    return this.db.query<UserCommand>(
      `SELECT * FROM user_command WHERE user_id = ? AND ${notDeleted()} ORDER BY created_at DESC, id DESC`,
      [userId],
    );
  }

  listVisibleSystemForUser(userId: number): Promise<UserCommand[]> {
    return this.db.query<UserCommand>(
      `SELECT c.* FROM user_command c
       WHERE c.user_id = 0 AND c.deleted = 0 AND ${VISIBLE_SYSTEM_PREDICATE}
       ORDER BY c.created_at DESC, c.id DESC`,
      [userId],
    );
  }

  listIllegalSystemVisibilities(): Promise<Array<{ id: number; visibility: string | null }>> {
    return this.db.query(
      `SELECT id, visibility FROM user_command
       WHERE user_id = 0 AND ${notDeleted()} AND visibility NOT IN ('all', 'roles')`,
    );
  }

  async isVisibleToUser(commandId: number, userId: number): Promise<boolean> {
    const row = await this.db.queryOne<{ id: number }>(
      `SELECT c.id FROM user_command c
       WHERE c.id = ? AND c.user_id = 0 AND c.deleted = 0 AND ${VISIBLE_SYSTEM_PREDICATE}`,
      [commandId, userId],
    );
    return row != null;
  }

  listActiveRoles(): Promise<CommandRoleOption[]> {
    return this.db.query<CommandRoleOption>(
      `SELECT id, name, code FROM role WHERE ${notDeleted()} ORDER BY name ASC, id ASC`,
    );
  }

  findActiveRolesByIds(ids: number[]): Promise<CommandRoleOption[]> {
    if (ids.length === 0) return Promise.resolve([]);
    const ph = ids.map(() => '?').join(',');
    return this.db.query<CommandRoleOption>(
      `SELECT id, name, code FROM role WHERE ${notDeleted()} AND id IN (${ph})`,
      ids,
    );
  }

  listActiveRoleGrants(commandIds: number[]): Promise<CommandRoleGrant[]> {
    if (commandIds.length === 0) return Promise.resolve([]);
    const ph = commandIds.map(() => '?').join(',');
    return this.db.query<CommandRoleGrant>(
      `SELECT cr.command_id, cr.role_id, r.name AS role_name
       FROM user_command_role cr
       INNER JOIN role r ON r.id = cr.role_id AND r.deleted = 0
       WHERE cr.command_id IN (${ph})
       ORDER BY r.name ASC, cr.role_id ASC`,
      commandIds,
    );
  }

  listPersonalAll(): Promise<UserCommand[]> {
    return this.db.query<UserCommand>(
      `SELECT * FROM user_command WHERE user_id > 0 AND ${notDeleted()} ORDER BY created_at DESC, id DESC`,
    );
  }

  private buildPersonalWhere(keyword?: string, userId?: number): { whereSql: string; params: unknown[] } {
    const clauses = ['user_id > 0', notDeleted()];
    const params: unknown[] = [];
    if (userId != null && Number.isInteger(userId) && userId > 0) {
      clauses.push('user_id = ?');
      params.push(userId);
    }
    const trimmed = keyword?.trim();
    if (trimmed) {
      const escaped = escapeLike(trimmed);
      clauses.push('(name LIKE ? OR content LIKE ?)');
      params.push(`%${escaped}%`, `%${escaped}%`);
    }
    return { whereSql: clauses.join(' AND '), params };
  }

  listPersonalFiltered(keyword?: string, userId?: number): Promise<UserCommand[]> {
    const { whereSql, params } = this.buildPersonalWhere(keyword, userId);
    return this.db.query<UserCommand>(
      `SELECT * FROM user_command WHERE ${whereSql} ORDER BY created_at DESC, id DESC`,
      params,
    );
  }

  async listPersonalPaged(pageNum: number, pageSize: number, keyword?: string, userId?: number): Promise<{ records: UserCommand[]; total: number }> {
    const { whereSql, params } = this.buildPersonalWhere(keyword, userId);
    const totalRow = await this.db.queryOne<{ c: number }>(`SELECT COUNT(*) AS c FROM user_command WHERE ${whereSql}`, params);
    const records = await this.db.query<UserCommand>(
      `SELECT * FROM user_command WHERE ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (pageNum - 1) * pageSize],
    );
    return { records, total: Number(totalRow?.c ?? 0) };
  }

  findByIdAndUserId(id: number, userId: number): Promise<UserCommand | null> {
    return this.db.queryOne<UserCommand>(
      `SELECT * FROM user_command WHERE id = ? AND user_id = ? AND ${notDeleted()}`,
      [id, userId],
    );
  }

  findByUserIdAndName(userId: number, name: string): Promise<UserCommand | null> {
    return this.db.queryOne<UserCommand>(
      `SELECT * FROM user_command WHERE user_id = ? AND name = ? AND ${notDeleted()}`,
      [userId, name],
    );
  }

  async insert(command: UserCommand): Promise<number> {
    const id = await this.db.insert('user_command', {
      userId: command.userId,
      name: command.name,
      content: command.content,
      deleted: 0,
    });
    command.id = id;
    return id;
  }

  async insertWithVisibility(command: UserCommand, visibility: CommandVisibility, roleIds: number[]): Promise<number> {
    return this.db.transaction(async (tx) => {
      const id = await tx.insert('user_command', {
        userId: command.userId,
        name: command.name,
        content: command.content,
        visibility,
        deleted: 0,
      });
      command.id = id;
      command.visibility = visibility;
      if (visibility === 'roles') {
        for (const roleId of roleIds) {
          await tx.insert('user_command_role', { commandId: id, roleId });
        }
      }
      return id;
    });
  }

  async updateById(command: UserCommand): Promise<void> {
    if (command.id == null) {
      return;
    }
    // 不写 visibility。用户侧更新个人指令时不能改范围。
    await this.db.updateById('user_command', command.id, {
      userId: command.userId,
      name: command.name,
      content: command.content,
    });
  }

  async updateWithVisibility(command: UserCommand, visibility: CommandVisibility, roleIds: number[]): Promise<void> {
    if (command.id == null) return;
    const commandId = command.id;
    await this.db.transaction(async (tx) => {
      await tx.updateById('user_command', commandId, {
        userId: command.userId,
        name: command.name,
        content: command.content,
        visibility,
      });
      await tx.execute('DELETE FROM user_command_role WHERE command_id = ?', [commandId]);
      if (visibility === 'roles') {
        for (const roleId of roleIds) {
          await tx.insert('user_command_role', { commandId, roleId });
        }
      }
    });
    command.visibility = visibility;
  }

  async deleteById(id: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute('DELETE FROM user_command_role WHERE command_id = ?', [id]);
      await tx.updateById('user_command', id, { deleted: 1 });
    });
  }
}
