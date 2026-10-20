import type { Db } from '../db/db.js';
import type {
  AdminUserToolQuery, AdminUserToolRow, UserTool, UserToolParam, UserToolRepository,
} from './types.js';

/** 转义 LIKE 通配符（与 command.repository 语义一致），配合默认反斜杠转义。 */
function escapeLike(keyword: string): string {
  return keyword.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export class MysqlUserToolRepository implements UserToolRepository {
  constructor(private readonly db: Db) {}

  listByUserId(userId: number): Promise<UserTool[]> {
    return this.db.query<UserTool>(
      `SELECT * FROM user_tool WHERE user_id = ? ORDER BY name ASC`,
      [userId],
    );
  }

  listEnabledByUserId(userId: number): Promise<UserTool[]> {
    return this.db.query<UserTool>(
      `SELECT * FROM user_tool WHERE user_id = ? AND enabled = 1 ORDER BY name ASC`,
      [userId],
    );
  }

  findById(id: number): Promise<UserTool | null> {
    return this.db.queryOne<UserTool>(`SELECT * FROM user_tool WHERE id = ?`, [id]);
  }

  findByIdAndUserId(id: number, userId: number): Promise<UserTool | null> {
    return this.db.queryOne<UserTool>(
      `SELECT * FROM user_tool WHERE id = ? AND user_id = ?`,
      [id, userId],
    );
  }

  findByUserIdAndName(userId: number, name: string): Promise<UserTool | null> {
    return this.db.queryOne<UserTool>(
      `SELECT * FROM user_tool WHERE user_id = ? AND name = ?`,
      [userId, name],
    );
  }

  countEnabledByUserId(userId: number): Promise<number> {
    return this.db.queryOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM user_tool WHERE user_id = ? AND enabled = 1`,
      [userId],
    ).then((row) => Number(row?.c ?? 0));
  }

  listParamsByToolId(toolId: number): Promise<UserToolParam[]> {
    return this.db.query<UserToolParam>(
      `SELECT * FROM user_tool_param WHERE tool_id = ? ORDER BY sort_order ASC, id ASC`,
      [toolId],
    );
  }

  async insert(tool: UserTool): Promise<number> {
    const id = await this.db.insert('user_tool', {
      userId: tool.userId,
      name: tool.name,
      displayName: tool.displayName,
      description: tool.description,
      method: tool.method,
      url: tool.url,
      headersJson: tool.headersJson,
      bodyTemplate: tool.bodyTemplate,
      readOnly: tool.readOnly,
      timeoutMs: tool.timeoutMs,
      enabled: tool.enabled,
    });
    tool.id = id;
    return id;
  }

  async updateById(tool: UserTool): Promise<void> {
    if (tool.id == null) return;
    await this.db.updateById('user_tool', tool.id, {
      name: tool.name,
      displayName: tool.displayName,
      description: tool.description,
      method: tool.method,
      url: tool.url,
      headersJson: tool.headersJson,
      bodyTemplate: tool.bodyTemplate,
      readOnly: tool.readOnly,
      timeoutMs: tool.timeoutMs,
      enabled: tool.enabled,
    });
  }

  async deleteById(id: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(`DELETE FROM user_tool_param WHERE tool_id = ?`, [id]);
      await tx.execute(`DELETE FROM user_tool WHERE id = ?`, [id]);
    });
  }

  async insertParam(param: UserToolParam): Promise<number> {
    const id = await this.db.insert('user_tool_param', {
      toolId: param.toolId,
      name: param.name,
      label: param.label,
      type: param.type,
      required: param.required,
      defaultValue: param.defaultValue,
      sortOrder: param.sortOrder,
    });
    param.id = id;
    return id;
  }

  async deleteParamsByToolId(toolId: number): Promise<void> {
    // 写语句走 execute：query 的 toCamelList 会把 ResultSetHeader 当行数组 .map 而抛错
    await this.db.execute(`DELETE FROM user_tool_param WHERE tool_id = ?`, [toolId]);
  }

  transaction<T>(fn: (repo: UserToolRepository) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(new MysqlUserToolRepository(tx)));
  }

  /** 管理侧清单：keyword 匹配工具名/展示名，username 匹配属主账号，enabled 过滤启用态。 */
  async listForAdmin(
    page: number,
    size: number,
    query: AdminUserToolQuery,
  ): Promise<{ rows: AdminUserToolRow[]; total: number }> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const keyword = query.keyword?.trim();
    if (keyword) {
      const escaped = escapeLike(keyword);
      clauses.push('(t.name LIKE ? OR t.display_name LIKE ?)');
      params.push(`%${escaped}%`, `%${escaped}%`);
    }
    const username = query.username?.trim();
    if (username) {
      const escaped = escapeLike(username);
      clauses.push('(u.username LIKE ? OR u.display_name LIKE ?)');
      params.push(`%${escaped}%`, `%${escaped}%`);
    }
    if (query.enabled != null) {
      clauses.push('t.enabled = ?');
      params.push(query.enabled ? 1 : 0);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = await this.db.queryOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM user_tool t LEFT JOIN user u ON u.id = t.user_id ${whereSql}`,
      params,
    );
    const rows = await this.db.query<AdminUserToolRow>(
      `SELECT t.*, u.username, u.display_name AS userDisplayName
       FROM user_tool t LEFT JOIN user u ON u.id = t.user_id
       ${whereSql}
       ORDER BY t.id DESC LIMIT ? OFFSET ?`,
      [...params, size, (page - 1) * size],
    );
    return { rows, total: Number(totalRow?.c ?? 0) };
  }
}
