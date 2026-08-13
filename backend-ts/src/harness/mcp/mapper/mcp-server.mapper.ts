import type { Db } from '../../../db/db.js';
import { notDeleted } from '../../../db/db.js';
import { hasText } from '../../../common/case.js';
import { GLOBAL_USER_ID, STATUS_ENABLED, type McpServer, type UserMcpPreference } from '../entity/mcp-server.js';

export class McpServerMapper {
  constructor(private readonly db: Db) {}

  list(keyword?: string | null, status?: string | null): Promise<McpServer[]> {
    const params: unknown[] = [];
    let sql = `SELECT * FROM mcp_server WHERE ${notDeleted()}`;
    if (hasText(keyword)) {
      sql += ' AND (name LIKE ? OR description LIKE ?)';
      params.push(`%${keyword}%`, `%${keyword}%`);
    }
    if (hasText(status)) {
      sql += ' AND status = ?';
      params.push(status);
    }
    sql += ' ORDER BY user_id ASC, id ASC';
    return this.db.query<McpServer>(sql, params);
  }

  listEnabledGlobal(): Promise<McpServer[]> {
    return this.db.query<McpServer>(
      `SELECT * FROM mcp_server WHERE user_id = ? AND status = ? AND ${notDeleted()} ORDER BY id ASC`,
      [GLOBAL_USER_ID, STATUS_ENABLED],
    );
  }

  listMine(userId: number): Promise<McpServer[]> {
    return this.db.query<McpServer>(
      `SELECT * FROM mcp_server WHERE user_id = ? AND ${notDeleted()} ORDER BY id ASC`,
      [userId],
    );
  }

  selectById(id: number): Promise<McpServer | null> {
    return this.db.queryOne<McpServer>(
      `SELECT * FROM mcp_server WHERE id = ? AND ${notDeleted()}`,
      [id],
    );
  }

  selectByName(name: string, userId: number): Promise<McpServer | null> {
    return this.db.queryOne<McpServer>(
      `SELECT * FROM mcp_server WHERE name = ? AND user_id = ? AND ${notDeleted()}`,
      [name, userId],
    );
  }

  selectOneByName(name: string): Promise<McpServer | null> {
    return this.db.queryOne<McpServer>(
      `SELECT * FROM mcp_server WHERE name = ? AND ${notDeleted()} LIMIT 1`,
      [name],
    );
  }

  insert(server: McpServer): Promise<number> {
    return this.db.insert('mcp_server', {
      userId: server.userId ?? GLOBAL_USER_ID,
      name: server.name,
      description: server.description ?? null,
      serverType: server.serverType,
      command: server.command ?? null,
      argsJson: server.argsJson ?? null,
      url: server.url ?? null,
      envJson: server.envJson ?? null,
      status: server.status ?? STATUS_ENABLED,
    });
  }

  updateById(id: number, data: Partial<McpServer>): Promise<void> {
    return this.db.updateById('mcp_server', id, data);
  }

  async logicalDelete(id: number): Promise<void> {
    await this.db.execute(`UPDATE mcp_server SET deleted = 1 WHERE id = ?`, [id]);
  }

  async physicalDeleteById(id: number): Promise<void> {
    await this.db.execute('DELETE FROM mcp_server WHERE id = ?', [id]);
  }

  async countByUserIdAndName(userId: number, name: string): Promise<number> {
    const row = await this.db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM mcp_server WHERE user_id = ? AND name = ? AND ${notDeleted()}`,
      [userId, name],
    );
    return Number(row?.cnt ?? 0);
  }

  async countByNameWhereUserIdNot(name: string, userId: number): Promise<number> {
    const row = await this.db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM mcp_server WHERE user_id <> ? AND name = ? AND ${notDeleted()}`,
      [userId, name],
    );
    return Number(row?.cnt ?? 0);
  }
}

export class UserMcpPreferenceMapper {
  constructor(private readonly db: Db) {}

  listDisabledServerIds(userId: number): Promise<UserMcpPreference[]> {
    return this.db.query<UserMcpPreference>(
      'SELECT * FROM user_mcp_preference WHERE user_id = ? AND enabled = 0',
      [userId],
    );
  }

  get(userId: number, serverId: number): Promise<UserMcpPreference | null> {
    return this.db.queryOne<UserMcpPreference>(
      'SELECT * FROM user_mcp_preference WHERE user_id = ? AND server_id = ? LIMIT 1',
      [userId, serverId],
    );
  }

  listByUser(userId: number): Promise<UserMcpPreference[]> {
    return this.db.query<UserMcpPreference>(
      'SELECT * FROM user_mcp_preference WHERE user_id = ?',
      [userId],
    );
  }

  insert(row: UserMcpPreference): Promise<number> {
    return this.db.insert('user_mcp_preference', {
      userId: row.userId,
      serverId: row.serverId,
      enabled: row.enabled ?? 0,
    });
  }

  updateById(id: number, data: Partial<UserMcpPreference>): Promise<void> {
    return this.db.updateById('user_mcp_preference', id, data);
  }

  async deleteById(id: number): Promise<void> {
    await this.db.execute('DELETE FROM user_mcp_preference WHERE id = ?', [id]);
  }

  async deleteByServer(serverId: number): Promise<void> {
    await this.db.execute('DELETE FROM user_mcp_preference WHERE server_id = ?', [serverId]);
  }
}
