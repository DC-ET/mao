import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import type { SessionActivity, SessionTodo, SubagentExecution } from './types.js';

export class SessionActivityRepository {
  constructor(private readonly db: Db) {}

  async insert(activity: SessionActivity): Promise<number> {
    const id = await this.db.insert('session_activity', {
      sessionId: activity.sessionId,
      type: activity.type,
      target: activity.target,
      summary: activity.summary,
      detailJson: activity.detailJson,
      status: activity.status,
      durationMs: activity.durationMs,
    });
    activity.id = id;
    return id;
  }

  listBySession(sessionId: number, limit: number): Promise<SessionActivity[]> {
    return this.db.query<SessionActivity>(
      `SELECT * FROM session_activity WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
      [sessionId, limit],
    );
  }
}

export class SessionTodoRepository {
  constructor(private readonly db: Db) {}

  async insert(todo: SessionTodo): Promise<number> {
    const id = await this.db.insert('session_todo', {
      sessionId: todo.sessionId,
      content: todo.content ?? '',
      description: todo.description ?? '',
      activeForm: todo.activeForm ?? '',
      status: todo.status ?? 'pending',
      sortOrder: todo.sortOrder ?? 0,
      owner: todo.owner ?? null,
      claimedAt: todo.claimedAt ?? null,
      blockedBy: todo.blockedBy ?? null,
    });
    todo.id = id;
    return id;
  }

  listBySession(sessionId: number): Promise<SessionTodo[]> {
    return this.db.query<SessionTodo>(
      `SELECT * FROM session_todo WHERE session_id = ? AND ${notDeleted()} ORDER BY sort_order ASC, id ASC`,
      [sessionId],
    );
  }

  async resetInProgressExcept(sessionId: number, todoId: number): Promise<void> {
    await this.db.execute(
      `UPDATE session_todo SET status = 'pending' WHERE session_id = ? AND status = 'in_progress' AND id <> ? AND ${notDeleted()}`,
      [sessionId, todoId],
    );
  }

  async updateFields(todoId: number, sessionId: number, fields: Record<string, unknown>): Promise<void> {
    const row: Record<string, unknown> = {};
    if (fields.status !== undefined) row.status = fields.status;
    if (fields.content !== undefined) row.content = fields.content;
    if (Object.keys(row).length === 0) {
      return;
    }
    const keys = Object.keys(row);
    await this.db.execute(
      `UPDATE session_todo SET ${keys.map((k) => `\`${camelToSnake(k)}\` = ?`).join(', ')} WHERE id = ? AND session_id = ? AND ${notDeleted()}`,
      [...Object.values(row), todoId, sessionId],
    );
  }

  async logicalDelete(todoId: number, sessionId: number): Promise<void> {
    await this.db.execute(
      `UPDATE session_todo SET deleted = 1 WHERE id = ? AND session_id = ? AND ${notDeleted()}`,
      [todoId, sessionId],
    );
  }
}

export class SubagentExecutionRepository {
  constructor(private readonly db: Db) {}

  findByChildSessionIds(childIds: number[]): Promise<SubagentExecution[]> {
    if (childIds.length === 0) {
      return Promise.resolve([]);
    }
    const placeholders = childIds.map(() => '?').join(',');
    return this.db.query<SubagentExecution>(
      `SELECT * FROM subagent_execution WHERE child_session_id IN (${placeholders}) ORDER BY id DESC`,
      childIds,
    );
  }
}

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
