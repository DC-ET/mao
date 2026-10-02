import type { Db } from '../db/db.js';
import { nowSql } from '../common/datetime.js';
import { hasText } from '../common/case.js';
import type { MemoryItemRow, MemoryListQuery, UserMemoryPreferenceRow } from './types.js';

/** 捕获 uk_memory_dedup 唯一键冲突（并发抽取同事实时转为更新分支）。 */
export function isDuplicateKeyError(e: unknown): boolean {
  return typeof e === 'object' && e != null && (e as { errno?: number }).errno === 1062;
}

export class MemoryRepository {
  constructor(private readonly db: Db) {}

  transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  async page(query: MemoryListQuery & { userId: number }): Promise<MemoryItemRow[]> {
    const { where, params } = this.buildFilter(query);
    const offset = (query.page - 1) * query.pageSize;
    return this.db.query<MemoryItemRow>(
      `SELECT * FROM \`memory_item\` WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, query.pageSize, offset],
    );
  }

  async count(query: MemoryListQuery & { userId: number }): Promise<number> {
    const { where, params } = this.buildFilter(query);
    const row = await this.db.queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM \`memory_item\` WHERE ${where}`,
      params,
    );
    return row?.total ?? 0;
  }

  /** 该用户 ACTIVE 状态记忆总量（D7 限额口径，含 DISMISSED 之外的全部 scope）。 */
  async countActive(userId: number): Promise<number> {
    const row = await this.db.queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM \`memory_item\` WHERE user_id = ? AND status = 'ACTIVE'`,
      [userId],
    );
    return row?.total ?? 0;
  }

  findById(id: number): Promise<MemoryItemRow | null> {
    return this.db.queryOne<MemoryItemRow>('SELECT * FROM `memory_item` WHERE id = ?', [id]);
  }

  findByHash(userId: number, dedupHash: string): Promise<MemoryItemRow | null> {
    return this.db.queryOne<MemoryItemRow>(
      'SELECT * FROM `memory_item` WHERE user_id = ? AND dedup_hash = ?',
      [userId, dedupHash],
    );
  }

  async insert(row: MemoryItemRow): Promise<number> {
    return this.db.insert('memory_item', {
      userId: row.userId,
      scope: row.scope,
      projectKey: row.projectKey ?? '',
      content: row.content,
      source: row.source ?? 'MANUAL',
      status: row.status ?? 'ACTIVE',
      dedupHash: row.dedupHash,
      originSessionId: row.originSessionId ?? null,
    });
  }

  async updateContent(id: number, content: string, dedupHash: string, db?: Db): Promise<void> {
    await (db ?? this.db).execute(
      'UPDATE `memory_item` SET content = ?, dedup_hash = ? WHERE id = ?',
      [content, dedupHash, id],
    );
  }

  async updateStatus(id: number, status: string, db?: Db): Promise<void> {
    await (db ?? this.db).execute('UPDATE `memory_item` SET status = ? WHERE id = ?', [status, id]);
  }

  /** 再次确认：仅刷新 updated_at，让高频事实在注入排序中稳定占据名额。 */
  async touch(id: number): Promise<void> {
    await this.db.execute('UPDATE `memory_item` SET updated_at = ? WHERE id = ?', [nowSql(), id]);
  }

  async deleteById(id: number): Promise<void> {
    await this.db.execute('DELETE FROM `memory_item` WHERE id = ?', [id]);
  }

  /** 注入查询：USER 级 ACTIVE 按 updated_at DESC 截断（D7 上限 8 条）。 */
  listActiveUser(userId: number, limit: number): Promise<MemoryItemRow[]> {
    return this.db.query<MemoryItemRow>(
      `SELECT * FROM \`memory_item\` WHERE user_id = ? AND scope = 'USER' AND status = 'ACTIVE'
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
      [userId, limit],
    );
  }

  /** 注入查询：PROJECT 级 ACTIVE 按 (userId, projectKey) 定位，同序截断（D7 上限 12 条）。 */
  listActiveProject(userId: number, projectKey: string, limit: number): Promise<MemoryItemRow[]> {
    return this.db.query<MemoryItemRow>(
      `SELECT * FROM \`memory_item\` WHERE user_id = ? AND scope = 'PROJECT' AND project_key = ? AND status = 'ACTIVE'
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
      [userId, projectKey, limit],
    );
  }

  findPreference(userId: number): Promise<UserMemoryPreferenceRow | null> {
    return this.db.queryOne<UserMemoryPreferenceRow>(
      'SELECT * FROM `user_memory_preference` WHERE user_id = ?',
      [userId],
    );
  }

  async insertPreference(userId: number, enabled: boolean): Promise<void> {
    await this.db.insert('user_memory_preference', {
      userId,
      autoCaptureEnabled: enabled ? 1 : 0,
    });
  }

  async updatePreference(userId: number, enabled: boolean): Promise<void> {
    await this.db.execute(
      'UPDATE `user_memory_preference` SET auto_capture_enabled = ? WHERE user_id = ?',
      [enabled ? 1 : 0, userId],
    );
  }

  /** D13 比较集：某分组的 AUTO ACTIVE 行（USER 组 projectKey 传 null）。 */
  listActiveForDedup(userId: number, scope: string, projectKey?: string | null): Promise<MemoryItemRow[]> {
    const conditions = ['user_id = ?', 'scope = ?', "status = 'ACTIVE'", "source = 'AUTO'"];
    const params: unknown[] = [userId, scope];
    if (hasText(projectKey)) {
      conditions.push('project_key = ?');
      params.push(projectKey);
    }
    return this.db.query<MemoryItemRow>(
      `SELECT id, scope, project_key, content FROM \`memory_item\` WHERE ${conditions.join(' AND ')}
       ORDER BY updated_at DESC, id DESC`,
      params,
    );
  }

  /** D14 溢出淘汰源：某分组最旧的 AUTO ACTIVE 行（排除刚被本轮回改的行，其 updated_at 已刷新排在后面）。 */
  listStaleAuto(userId: number, scope: string, projectKey: string | null, limit: number): Promise<MemoryItemRow[]> {
    const conditions = ['user_id = ?', 'scope = ?', "status = 'ACTIVE'", "source = 'AUTO'"];
    const params: unknown[] = [userId, scope];
    if (hasText(projectKey)) {
      conditions.push('project_key = ?');
      params.push(projectKey);
    }
    return this.db.query<MemoryItemRow>(
      `SELECT id FROM \`memory_item\` WHERE ${conditions.join(' AND ')}
       ORDER BY updated_at ASC, id ASC LIMIT ?`,
      [...params, limit],
    );
  }

  /** D13 负面约束集：最近忽略的 content 列表（MANUAL/AUTO 均含——用户显式忽略过的内容都不该再被抽出）。 */
  listDismissedContents(userId: number, limit: number): Promise<MemoryItemRow[]> {
    return this.db.query<MemoryItemRow>(
      `SELECT content FROM \`memory_item\` WHERE user_id = ? AND status = 'DISMISSED'
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
      [userId, limit],
    );
  }

  private buildFilter(query: MemoryListQuery & { userId: number }): { where: string; params: unknown[] } {
    const conditions = ['user_id = ?'];
    const params: unknown[] = [query.userId];
    if (query.scope) {
      conditions.push('scope = ?');
      params.push(query.scope);
    }
    if (query.projectKey) {
      conditions.push('project_key = ?');
      params.push(query.projectKey);
    }
    if (query.status) {
      conditions.push('status = ?');
      params.push(query.status);
    }
    return { where: conditions.join(' AND '), params };
  }
}
