import type { Db } from '../../db/db.js';
import { notDeleted } from '../../db/db.js';
import { camelToSnake } from '../../common/case.js';
import type { SessionTodo } from './entity/session-todo.js';

export class SessionTodoMapper {
  constructor(private readonly db: Db) {}

  listBySession(sessionId: number): Promise<SessionTodo[]> {
    return this.selectBySessionId(sessionId);
  }

  selectBySessionId(sessionId: number): Promise<SessionTodo[]> {
    return this.db.query<SessionTodo>(
      `SELECT * FROM session_todo WHERE session_id = ? AND ${notDeleted()} ORDER BY sort_order ASC, id ASC`,
      [sessionId],
    );
  }

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

  async resetInProgress(sessionId: number, exceptId?: number): Promise<void> {
    if (exceptId != null) {
      await this.db.execute(
        `UPDATE session_todo SET status = 'pending' WHERE session_id = ? AND status = 'in_progress' AND id <> ? AND ${notDeleted()}`,
        [sessionId, exceptId],
      );
    } else {
      await this.db.execute(
        `UPDATE session_todo SET status = 'pending' WHERE session_id = ? AND status = 'in_progress' AND ${notDeleted()}`,
        [sessionId],
      );
    }
  }

  async updateFields(todoId: number, sessionId: number, fields: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    await this.db.execute(
      `UPDATE session_todo SET ${keys.map((k) => `\`${camelToSnake(k)}\` = ?`).join(', ')} WHERE id = ? AND session_id = ? AND ${notDeleted()}`,
      [...Object.values(fields), todoId, sessionId],
    );
  }

  async logicalDelete(todoId: number, sessionId: number): Promise<void> {
    await this.db.execute(
      `UPDATE session_todo SET deleted = 1 WHERE id = ? AND session_id = ? AND ${notDeleted()}`,
      [todoId, sessionId],
    );
  }

  async delete(todoId: number, sessionId: number): Promise<void> {
    await this.logicalDelete(todoId, sessionId);
  }

  async deleteBySessionId(sessionId: number): Promise<void> {
    await this.db.execute(
      `UPDATE session_todo SET deleted = 1 WHERE session_id = ? AND ${notDeleted()}`,
      [sessionId],
    );
  }
}
