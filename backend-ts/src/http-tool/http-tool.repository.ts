import type { Db } from '../db/db.js';
import type {
  AdminHttpToolQuery, AdminHttpToolRow, HttpTool, HttpToolParam, HttpToolRepository,
} from './types.js';

/** 转义 LIKE 通配符（与 command.repository 语义一致），配合默认反斜杠转义。 */
function escapeLike(keyword: string): string {
  return keyword.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export class MysqlHttpToolRepository implements HttpToolRepository {
  constructor(private readonly db: Db) {}

  /** Agent 装配：按关联 id 集合取启用工具；调用方保证 ids 非空（空集合零查库）。 */
  listEnabledByIds(ids: number[]): Promise<HttpTool[]> {
    const placeholders = ids.map(() => '?').join(',');
    return this.db.query<HttpTool>(
      `SELECT * FROM http_tool WHERE enabled = 1 AND id IN (${placeholders}) ORDER BY name ASC`,
      ids,
    );
  }

  findById(id: number): Promise<HttpTool | null> {
    return this.db.queryOne<HttpTool>(`SELECT * FROM http_tool WHERE id = ?`, [id]);
  }

  findByName(name: string): Promise<HttpTool | null> {
    return this.db.queryOne<HttpTool>(`SELECT * FROM http_tool WHERE name = ?`, [name]);
  }

  listParamsByToolId(toolId: number): Promise<HttpToolParam[]> {
    return this.db.query<HttpToolParam>(
      `SELECT * FROM http_tool_param WHERE tool_id = ? ORDER BY sort_order ASC, id ASC`,
      [toolId],
    );
  }

  async insert(tool: HttpTool): Promise<number> {
    const id = await this.db.insert('http_tool', {
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

  async updateById(tool: HttpTool): Promise<void> {
    if (tool.id == null) return;
    await this.db.updateById('http_tool', tool.id, {
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
      await tx.execute(`DELETE FROM http_tool_param WHERE tool_id = ?`, [id]);
      await tx.execute(`DELETE FROM http_tool WHERE id = ?`, [id]);
    });
  }

  async insertParam(param: HttpToolParam): Promise<number> {
    const id = await this.db.insert('http_tool_param', {
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
    await this.db.execute(`DELETE FROM http_tool_param WHERE tool_id = ?`, [toolId]);
  }

  transaction<T>(fn: (repo: HttpToolRepository) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(new MysqlHttpToolRepository(tx)));
  }

  /** 管理侧清单：keyword 匹配工具名/展示名，enabled 过滤启用态（无属主维度）。 */
  async listForAdmin(
    page: number,
    size: number,
    query: AdminHttpToolQuery,
  ): Promise<{ rows: AdminHttpToolRow[]; total: number }> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const keyword = query.keyword?.trim();
    if (keyword) {
      const escaped = escapeLike(keyword);
      clauses.push('(name LIKE ? OR display_name LIKE ?)');
      params.push(`%${escaped}%`, `%${escaped}%`);
    }
    if (query.enabled != null) {
      clauses.push('enabled = ?');
      params.push(query.enabled ? 1 : 0);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = await this.db.queryOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM http_tool ${whereSql}`,
      params,
    );
    const rows = await this.db.query<AdminHttpToolRow>(
      `SELECT * FROM http_tool ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, size, (page - 1) * size],
    );
    return { rows, total: Number(totalRow?.c ?? 0) };
  }

  /** 启用工具轻量列表（Agent 表单下拉用；按 name ASC 稳定序）。 */
  listEnabledBrief(): Promise<Array<Pick<HttpTool, 'id' | 'name' | 'displayName' | 'method' | 'readOnly'>>> {
    return this.db.query<Pick<HttpTool, 'id' | 'name' | 'displayName' | 'method' | 'readOnly'>>(
      `SELECT id, name, display_name, method, read_only FROM http_tool WHERE enabled = 1 ORDER BY name ASC`,
    );
  }
}
