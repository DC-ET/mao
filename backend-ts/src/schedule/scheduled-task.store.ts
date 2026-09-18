import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import type { ScheduledTask, ScheduledTaskListFilter, ScheduledTaskStore } from './scheduled-task.service.js';

export class ScheduledTaskDbStore implements ScheduledTaskStore {
  constructor(private readonly db: Db) {}

  insert(task: ScheduledTask): Promise<number> {
    return this.db.insert('scheduled_task', task);
  }

  updateById(task: Partial<ScheduledTask> & { id: number }): Promise<void> {
    return this.db.updateById('scheduled_task', task.id, task);
  }

  async deleteById(id: number): Promise<void> {
    await this.db.execute('UPDATE scheduled_task SET deleted = 1 WHERE id = ?', [id]);
  }

  selectById(id: number): Promise<ScheduledTask | null> {
    return this.db.queryOne(`SELECT * FROM scheduled_task WHERE id = ? AND ${notDeleted()}`, [id]);
  }

  listByUser(userId: number): Promise<ScheduledTask[]> {
    return this.db.query(
      `SELECT * FROM scheduled_task WHERE user_id = ? AND ${notDeleted()} ORDER BY created_at DESC`,
      [userId],
    );
  }

  private buildListAllWhere(filter: ScheduledTaskListFilter = {}): { whereSql: string; params: unknown[] } {
    const clauses = [notDeleted()];
    const params: unknown[] = [];
    if (filter.userId != null) {
      clauses.push('user_id = ?');
      params.push(filter.userId);
    }
    if (filter.agentId != null) {
      clauses.push('agent_id = ?');
      params.push(filter.agentId);
    }
    if (filter.status != null && filter.status.length > 0) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.finished != null) {
      clauses.push('finished = ?');
      params.push(filter.finished ? 1 : 0);
    }
    const keyword = filter.keyword?.trim();
    if (keyword) {
      clauses.push('(name LIKE ? OR prompt LIKE ?)');
      params.push(`%${keyword}%`, `%${keyword}%`);
    }
    return { whereSql: clauses.join(' AND '), params };
  }

  async listAll(pageNum: number, pageSize: number, filter?: ScheduledTaskListFilter): Promise<{ records: ScheduledTask[]; total: number }> {
    const { whereSql, params } = this.buildListAllWhere(filter);
    const totalRow = await this.db.queryOne<{ c: number }>(`SELECT COUNT(*) AS c FROM scheduled_task WHERE ${whereSql}`, params);
    const records = await this.db.query<ScheduledTask>(
      `SELECT * FROM scheduled_task WHERE ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (pageNum - 1) * pageSize],
    );
    return { records, total: Number(totalRow?.c ?? 0) };
  }

  listDue(now: string): Promise<ScheduledTask[]> {
    return this.db.query(
      `SELECT * FROM scheduled_task WHERE status = 'ACTIVE' AND next_fire_time <= ? AND ${notDeleted()}`,
      [now],
    );
  }
}
