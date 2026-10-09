import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import type { ScheduledTask, ScheduledTaskListFilter, ScheduledTaskRun, ScheduledTaskStore, TaskFailureOutcome } from './scheduled-task.service.js';

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

  async deleteBySessionId(sessionId: number): Promise<void> {
    await this.db.execute(
      'UPDATE scheduled_task SET deleted = 1 WHERE session_id = ? AND deleted = 0',
      [sessionId],
    );
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
      `SELECT * FROM scheduled_task WHERE status = 'ACTIVE' AND finished = 0 AND next_fire_time <= ? AND ${notDeleted()}`,
      [now],
    );
  }

  selectRunById(id: number): Promise<ScheduledTaskRun | null> {
    return this.db.queryOne('SELECT * FROM scheduled_task_run WHERE id = ?', [id]);
  }

  selectRunByFire(taskId: number, fireTime: string): Promise<ScheduledTaskRun | null> {
    return this.db.queryOne('SELECT * FROM scheduled_task_run WHERE task_id = ? AND fire_time = ?', [taskId, fireTime]);
  }

  insertRun(run: ScheduledTaskRun): Promise<number> {
    return this.db.insert('scheduled_task_run', {
      taskId: run.taskId,
      fireTime: run.fireTime,
      attempt: run.attempt,
      status: run.status,
      sessionId: run.sessionId,
      messageId: run.messageId ?? null,
      startedAt: run.startedAt ?? null,
      finishedAt: run.finishedAt ?? null,
      durationMs: run.durationMs ?? null,
      costMicros: run.costMicros ?? null,
      errorSummary: run.errorSummary ?? null,
      nextRetryAt: run.nextRetryAt ?? null,
      queueSeq: run.queueSeq ?? null,
    });
  }

  updateRun(run: Partial<ScheduledTaskRun> & { id: number }): Promise<void> {
    const { id, ...rest } = run;
    return this.db.updateById('scheduled_task_run', id, rest);
  }

  async deleteUnstartedRun(taskId: number, fireTime: string): Promise<void> {
    await this.db.execute(
      `DELETE FROM scheduled_task_run WHERE task_id = ? AND fire_time = ? AND status = 'RUNNING' AND started_at IS NULL`,
      [taskId, fireTime],
    );
  }

  async beginRetry(runId: number): Promise<ScheduledTaskRun | null> {
    const result = await this.db.execute(
      `UPDATE scheduled_task_run
          SET attempt = attempt + 1, status = 'RUNNING', message_id = NULL, started_at = NULL,
              finished_at = NULL, duration_ms = NULL, cost_micros = NULL, error_summary = NULL, next_retry_at = NULL
        WHERE id = ? AND status = 'FAILED' AND next_retry_at IS NOT NULL`,
      [runId],
    );
    if (result.affectedRows !== 1) return null;
    return this.selectRunById(runId);
  }

  async clearRunRetry(runId: number): Promise<void> {
    await this.db.execute(
      `UPDATE scheduled_task_run SET next_retry_at = NULL WHERE id = ? AND status = 'FAILED'`,
      [runId],
    );
  }

  async clearPendingRetries(taskId: number): Promise<void> {
    await this.db.execute(
      `UPDATE scheduled_task_run SET next_retry_at = NULL WHERE task_id = ? AND next_retry_at IS NOT NULL`,
      [taskId],
    );
  }

  oldestQueuedRun(taskId: number): Promise<ScheduledTaskRun | null> {
    return this.db.queryOne(
      `SELECT * FROM scheduled_task_run
        WHERE task_id = ? AND status = 'QUEUED'
        ORDER BY queue_seq IS NULL, queue_seq ASC, id ASC
        LIMIT 1`,
      [taskId],
    );
  }

  async hasPendingRetry(taskId: number): Promise<boolean> {
    const row = await this.db.queryOne<{ id: number }>(
      `SELECT id FROM scheduled_task_run WHERE task_id = ? AND next_retry_at IS NOT NULL LIMIT 1`,
      [taskId],
    );
    return row != null;
  }

  listRuns(taskId: number, limit: number): Promise<ScheduledTaskRun[]> {
    return this.db.query(
      `SELECT * FROM scheduled_task_run WHERE task_id = ? ORDER BY fire_time DESC LIMIT ?`,
      [taskId, limit],
    );
  }

  listDueRetries(now: string): Promise<ScheduledTaskRun[]> {
    return this.db.query(
      `SELECT r.* FROM scheduled_task_run r
         JOIN scheduled_task t ON t.id = r.task_id
        WHERE r.status = 'FAILED' AND r.next_retry_at IS NOT NULL AND r.next_retry_at <= ?
          AND t.status = 'ACTIVE' AND t.finished = 0 AND t.deleted = 0
        ORDER BY r.next_retry_at ASC`,
      [now],
    );
  }

  listMissedTasks(before: string): Promise<ScheduledTask[]> {
    return this.db.query(
      `SELECT * FROM scheduled_task
        WHERE status = 'ACTIVE' AND finished = 0 AND next_fire_time < ? AND ${notDeleted()}`,
      [before],
    );
  }

  async insertMissedIgnore(run: Pick<ScheduledTaskRun, 'taskId' | 'fireTime' | 'sessionId'>): Promise<void> {
    await this.db.execute(
      `INSERT IGNORE INTO scheduled_task_run (task_id, fire_time, attempt, status, session_id)
       VALUES (?, ?, 1, 'MISSED', ?)`,
      [run.taskId, run.fireTime, run.sessionId],
    );
  }

  async casNextFire(id: number, expectedNextFireTime: string, nextFireTime: string | null, finish?: { finishedAt: string }): Promise<boolean> {
    if (finish != null) {
      const result = await this.db.execute(
        `UPDATE scheduled_task
            SET next_fire_time = NULL, finished = 1, finished_at = ?
          WHERE id = ? AND next_fire_time = ? AND ${notDeleted()}`,
        [finish.finishedAt, id, expectedNextFireTime],
      );
      return result.affectedRows === 1;
    }
    const result = await this.db.execute(
      `UPDATE scheduled_task SET next_fire_time = ? WHERE id = ? AND next_fire_time = ? AND ${notDeleted()}`,
      [nextFireTime, id, expectedNextFireTime],
    );
    return result.affectedRows === 1;
  }

  listOpenRuns(): Promise<ScheduledTaskRun[]> {
    return this.db.query(`SELECT * FROM scheduled_task_run WHERE status IN ('RUNNING', 'QUEUED')`);
  }

  listOpenRunsBySession(sessionId: number): Promise<ScheduledTaskRun[]> {
    return this.db.query(
      `SELECT * FROM scheduled_task_run WHERE session_id = ? AND status IN ('RUNNING', 'QUEUED') ORDER BY id ASC`,
      [sessionId],
    );
  }

  listStaleRuns(runningBefore: string, queuedBefore: string): Promise<ScheduledTaskRun[]> {
    return this.db.query(
      `SELECT * FROM scheduled_task_run
        WHERE (status = 'RUNNING' AND started_at IS NOT NULL AND updated_at < ?)
           OR (status = 'QUEUED' AND updated_at < ?)`,
      [runningBefore, queuedBefore],
    );
  }

  async deleteRunsBefore(cutoff: string): Promise<void> {
    await this.db.execute('DELETE FROM scheduled_task_run WHERE created_at < ?', [cutoff]);
  }

  async recordTaskOutcome(taskId: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED', pauseAfter: number, now: string): Promise<TaskFailureOutcome | null> {
    if (phase === 'CANCELLED') return null;
    if (phase === 'COMPLETED') {
      await this.db.execute(
        `UPDATE scheduled_task SET consecutive_failures = 0 WHERE id = ? AND ${notDeleted()}`,
        [taskId],
      );
      return { consecutiveFailures: 0, paused: false };
    }
    return this.db.transaction(async (tx) => {
      const row = await tx.queryOne<{ consecutiveFailures: number; status: string; finished: number }>(
        `SELECT consecutive_failures, status, finished FROM scheduled_task WHERE id = ? AND ${notDeleted()} FOR UPDATE`,
        [taskId],
      );
      if (row == null || row.status !== 'ACTIVE' || Number(row.finished) === 1) return null;
      const next = Number(row.consecutiveFailures ?? 0) + 1;
      const paused = next >= pauseAfter;
      await tx.execute(
        `UPDATE scheduled_task SET consecutive_failures = ?, status = ? WHERE id = ?`,
        [next, paused ? 'PAUSED' : 'ACTIVE', taskId],
      );
      return { consecutiveFailures: next, paused };
    });
  }
}
