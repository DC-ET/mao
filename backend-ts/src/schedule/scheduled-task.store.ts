import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import type { ScheduledTask, ScheduledTaskStore } from './scheduled-task.service.js';

export class ScheduledTaskDbStore implements ScheduledTaskStore {
  constructor(private readonly db: Db) {}

  insert(task: ScheduledTask): Promise<number> {
    return this.db.insert('scheduled_task', task);
  }

  updateById(task: ScheduledTask): Promise<void> {
    return this.db.updateById('scheduled_task', task.id!, task);
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

  async listAll(pageNum: number, pageSize: number): Promise<{ records: ScheduledTask[]; total: number }> {
    const totalRow = await this.db.queryOne<{ c: number }>(`SELECT COUNT(*) AS c FROM scheduled_task WHERE ${notDeleted()}`);
    const records = await this.db.query<ScheduledTask>(
      `SELECT * FROM scheduled_task WHERE ${notDeleted()} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [pageSize, (pageNum - 1) * pageSize],
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
