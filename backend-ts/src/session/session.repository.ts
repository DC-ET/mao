import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import { toSnakeRow } from '../common/case.js';
import type { FileChange, Message, Session } from './types.js';

export class SessionRepository {
  constructor(private readonly db: Db) {}

  transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  findById(id: number): Promise<Session | null> {
    return this.db.queryOne<Session>(`SELECT * FROM \`session\` WHERE id = ? AND ${notDeleted()}`, [id]);
  }

  findByIdForUpdate(id: number): Promise<Session | null> {
    return this.db.queryOne<Session>(`SELECT * FROM \`session\` WHERE id = ? AND ${notDeleted()} FOR UPDATE`, [id]);
  }

  selectById(id: number): Promise<Session | null> {
    return this.findById(id);
  }

  selectByPhase(phase: string): Promise<Session[]> {
    return this.list('phase = ?', [phase], '');
  }

  listSideTasks(parentSessionId: number): Promise<Session[]> {
    return this.list(
      `parent_session_id = ? AND session_type = 'SIDE_TASK' AND (status IS NULL OR status <> 'ARCHIVED')`,
      [parentSessionId],
      '',
    );
  }

  findActiveByUserAndProjectKey(userId: number, projectKey: string): Promise<Session | null> {
    return this.db.queryOne<Session>(
      `SELECT * FROM \`session\` WHERE user_id = ? AND project_key = ? AND status = 'ACTIVE' AND ${notDeleted()} LIMIT 1`,
      [userId, projectKey],
    );
  }

  async lockActiveSessionById(sessionId: number): Promise<number | null> {
    const row = await this.db.queryOne<{ id: number }>(
      `SELECT id FROM \`session\` WHERE id = ? AND ${notDeleted()} FOR UPDATE`,
      [sessionId],
    );
    return row?.id ?? null;
  }

  async insert(session: Session): Promise<number> {
    const id = await this.db.insert('session', {
      userId: session.userId,
      agentId: session.agentId,
      title: session.title,
      status: session.status ?? 'ACTIVE',
      isPinned: session.isPinned ?? 0,
      isFavorite: session.isFavorite ?? 0,
      executionMode: session.executionMode,
      workspace: session.workspace,
      permissionLevel: session.permissionLevel,
      modelId: session.modelId,
      isGit: session.isGit == null ? null : session.isGit ? 1 : 0,
      platform: session.platform,
      shellPath: session.shellPath,
      osVersion: session.osVersion,
      phase: session.phase ?? 'IDLE',
      summary: session.summary,
      startedAt: session.startedAt,
      elapsedMs: session.elapsedMs ?? 0,
      stepsJson: session.stepsJson,
      projectKey: session.projectKey,
      lastActivityAt: session.lastActivityAt,
      contextTokens: session.contextTokens,
      lastPromptTokens: session.lastPromptTokens,
      contextAnchorMsgId: session.contextAnchorMsgId,
      unread: session.unread ?? 0,
      parentSessionId: session.parentSessionId,
      sessionType: session.sessionType ?? 'NORMAL',
      runtimeStatusJson: session.runtimeStatusJson,
      deleted: 0,
    });
    session.id = id;
    return id;
  }

  async updateById(session: Session): Promise<void> {
    if (session.id == null) {
      return;
    }
    await this.db.updateById('session', session.id, {
      userId: session.userId,
      agentId: session.agentId,
      title: session.title,
      status: session.status,
      isPinned: session.isPinned,
      isFavorite: session.isFavorite,
      executionMode: session.executionMode,
      workspace: session.workspace,
      permissionLevel: session.permissionLevel,
      modelId: session.modelId,
      isGit: session.isGit == null ? null : session.isGit ? 1 : 0,
      platform: session.platform,
      shellPath: session.shellPath,
      osVersion: session.osVersion,
      phase: session.phase,
      summary: session.summary,
      startedAt: session.startedAt,
      elapsedMs: session.elapsedMs,
      stepsJson: session.stepsJson,
      projectKey: session.projectKey,
      lastActivityAt: session.lastActivityAt,
      contextTokens: session.contextTokens,
      lastPromptTokens: session.lastPromptTokens,
      contextAnchorMsgId: session.contextAnchorMsgId,
      unread: session.unread,
      parentSessionId: session.parentSessionId,
      sessionType: session.sessionType,
      runtimeStatusJson: session.runtimeStatusJson,
    });
  }

  async updateFields(id: number, fields: Record<string, unknown>): Promise<number> {
    const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
    if (keys.length === 0) {
      return 0;
    }
    await this.db.updateById('session', id, fields);
    return 1;
  }

  async updateWhere(fields: Record<string, unknown>, whereSql: string, params: unknown[]): Promise<number> {
    const row = toSnakeRow(fields);
    const keys = Object.keys(row);
    if (keys.length === 0) {
      return 0;
    }
    const sql = `UPDATE \`session\` SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE ${whereSql}`;
    const result = await this.db.execute(sql, [...Object.values(row), ...params]);
    return Number(result.affectedRows ?? 0);
  }

  /** Matches DelegateFollowupTool Java CAS: phase <> 'RUNNING' OR phase IS NULL. */
  claimRunningIfIdle(sessionId: number): Promise<number> {
    return this.updateWhere(
      { phase: 'RUNNING' },
      "id = ? AND (phase <> 'RUNNING' OR phase IS NULL) AND deleted = 0",
      [sessionId],
    );
  }

  updateTitleIfPlaceholder(
    sessionId: number,
    sessionType: string,
    placeholder: string,
    title: string,
    updatedAt: string,
  ): Promise<number> {
    return this.updateWhere(
      { title, updatedAt },
      "id = ? AND session_type = ? AND (title = ? OR title IS NULL OR TRIM(title) = '') AND deleted = 0",
      [sessionId, sessionType, placeholder],
    );
  }

  async logicalDelete(id: number): Promise<void> {
    await this.db.execute(`UPDATE \`session\` SET deleted = 1 WHERE id = ? AND ${notDeleted()}`, [id]);
  }

  list(whereSql: string, params: unknown[], orderSql: string): Promise<Session[]> {
    return this.db.query<Session>(
      `SELECT * FROM \`session\` WHERE ${whereSql} AND ${notDeleted()} ${orderSql}`,
      params,
    );
  }

  async count(whereSql: string, params: unknown[]): Promise<number> {
    const row = await this.db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM \`session\` WHERE ${whereSql} AND ${notDeleted()}`,
      params,
    );
    return Number(row?.cnt ?? 0);
  }

  async selectPage(
    page: number,
    size: number,
    whereSql: string,
    params: unknown[],
    orderSql: string,
  ): Promise<{ records: Session[]; total: number }> {
    const total = await this.count(whereSql, params);
    const offset = (page - 1) * size;
    const records = await this.db.query<Session>(
      `SELECT * FROM \`session\` WHERE ${whereSql} AND ${notDeleted()} ${orderSql} LIMIT ? OFFSET ?`,
      [...params, size, offset],
    );
    return { records, total };
  }

  selectMessageSearchCandidates(userId: number, escapedKeyword: string): Promise<Session[]> {
    return this.db.query<Session>(
      `SELECT DISTINCT s.id, s.title, s.session_type, s.parent_session_id, s.phase, s.updated_at, s.agent_id
       FROM session s
       JOIN message m ON m.session_id = s.id AND m.deleted = 0
       WHERE s.user_id = ? AND s.deleted = 0
         AND s.session_type IN ('NORMAL', 'SIDE_TASK')
         AND s.status = 'ACTIVE'
         AND m.role = 'USER'
         AND m.content LIKE CONCAT('%', ?, '%') ESCAPE '\\\\'
         AND (
           s.session_type = 'NORMAL'
           OR EXISTS (
             SELECT 1 FROM session p
             WHERE p.id = s.parent_session_id
               AND p.user_id = s.user_id
               AND p.deleted = 0
               AND p.status = 'ACTIVE'
               AND p.session_type = 'NORMAL'
           )
         )
       ORDER BY s.updated_at DESC, s.id DESC
       LIMIT 20`,
      [userId, escapedKeyword],
    );
  }
}

export class MessageRepository {
  constructor(private readonly db: Db) {}

  findById(id: number): Promise<Message | null> {
    return this.db.queryOne<Message>(`SELECT * FROM \`message\` WHERE id = ? AND ${notDeleted()}`, [id]);
  }

  async insert(message: Message): Promise<number> {
    const id = await this.db.insert('message', {
      sessionId: message.sessionId,
      role: message.role,
      content: message.content,
      thinkingContent: message.thinkingContent,
      toolCallId: message.toolCallId,
      toolCalls: message.toolCalls,
      tokenCount: message.tokenCount ?? 0,
      modelId: message.modelId,
      metadata: message.metadata,
      sourceSessionId: message.sourceSessionId,
      deleted: 0,
    });
    message.id = id;
    return id;
  }

  async updateById(message: Message): Promise<void> {
    if (message.id == null) {
      return;
    }
    await this.db.updateById('message', message.id, {
      content: message.content,
      thinkingContent: message.thinkingContent,
      toolCallId: message.toolCallId,
      toolCalls: message.toolCalls,
      tokenCount: message.tokenCount,
      modelId: message.modelId,
      metadata: message.metadata,
      updatedAt: message.updatedAt,
    });
  }

  listBySession(sessionId: number): Promise<Message[]> {
    return this.db.query<Message>(
      `SELECT * FROM \`message\` WHERE session_id = ? AND ${notDeleted()} ORDER BY created_at ASC, id ASC`,
      [sessionId],
    );
  }

  selectMessagesAfterId(sessionId: number, afterMessageId: number): Promise<Message[]> {
    return this.db.query<Message>(
      `SELECT * FROM \`message\` WHERE session_id = ? AND ${notDeleted()} AND id > ? ORDER BY id ASC`,
      [sessionId, afterMessageId],
    );
  }

  selectValidBoundaryMessage(sessionId: number, messageId: number): Promise<Message | null> {
    return this.db.queryOne<Message>(
      `SELECT * FROM \`message\` WHERE id = ? AND session_id = ? AND ${notDeleted()}`,
      [messageId, sessionId],
    );
  }

  async selectMaxMessageId(sessionId: number): Promise<number> {
    const row = await this.db.queryOne<{ mx: number }>(
      `SELECT COALESCE(MAX(id), 0) AS mx FROM \`message\` WHERE session_id = ? AND ${notDeleted()}`,
      [sessionId],
    );
    return Number(row?.mx ?? 0);
  }

  async hasEarlierUserMessage(sessionId: number, messageId: number): Promise<boolean> {
    const row = await this.db.queryOne<{ id: number }>(
      `SELECT id FROM \`message\` WHERE session_id = ? AND role = 'USER' AND id < ? AND ${notDeleted()} LIMIT 1`,
      [sessionId, messageId],
    );
    return row != null;
  }

  selectUserStarts(sessionId: number, beforeId: number | null, limit: number): Promise<Message[]> {
    if (beforeId != null) {
      return this.db.query<Message>(
        `SELECT * FROM \`message\` WHERE session_id = ? AND ${notDeleted()} AND role = 'USER' AND id < ? ORDER BY id DESC LIMIT ?`,
        [sessionId, beforeId, limit],
      );
    }
    return this.db.query<Message>(
      `SELECT * FROM \`message\` WHERE session_id = ? AND ${notDeleted()} AND role = 'USER' ORDER BY id DESC LIMIT ?`,
      [sessionId, limit],
    );
  }

  selectRange(sessionId: number, startId: number, beforeId: number | null): Promise<Message[]> {
    if (beforeId != null) {
      return this.db.query<Message>(
        `SELECT * FROM \`message\` WHERE session_id = ? AND ${notDeleted()} AND id >= ? AND id < ? ORDER BY created_at ASC, id ASC`,
        [sessionId, startId, beforeId],
      );
    }
    return this.db.query<Message>(
      `SELECT * FROM \`message\` WHERE session_id = ? AND ${notDeleted()} AND id >= ? ORDER BY created_at ASC, id ASC`,
      [sessionId, startId],
    );
  }

  async logicalDeleteById(id: number): Promise<void> {
    await this.db.execute(`UPDATE \`message\` SET deleted = 1 WHERE id = ? AND ${notDeleted()}`, [id]);
  }

  deleteById(id: number): Promise<void> {
    return this.logicalDeleteById(id);
  }

  async logicalDeleteBySession(sessionId: number): Promise<void> {
    await this.db.execute(`UPDATE \`message\` SET deleted = 1 WHERE session_id = ? AND ${notDeleted()}`, [sessionId]);
  }

  async logicalDeleteAfter(sessionId: number, messageId: number): Promise<void> {
    await this.db.execute(
      `UPDATE \`message\` SET deleted = 1 WHERE session_id = ? AND id > ? AND ${notDeleted()}`,
      [sessionId, messageId],
    );
  }

  selectLast(sessionId: number): Promise<Message | null> {
    return this.db.queryOne<Message>(
      `SELECT * FROM \`message\` WHERE session_id = ? AND ${notDeleted()} ORDER BY id DESC LIMIT 1`,
      [sessionId],
    );
  }

  /** 按 id 单调序取最后一条用户消息，不受 created_at 时钟偏移影响。 */
  selectLastUserMessage(sessionId: number): Promise<Message | null> {
    return this.db.queryOne<Message>(
      `SELECT * FROM \`message\` WHERE session_id = ? AND role = 'USER' AND ${notDeleted()} ORDER BY id DESC LIMIT 1`,
      [sessionId],
    );
  }

  async deleteFromId(sessionId: number, fromId: number): Promise<void> {
    await this.db.execute(
      `UPDATE \`message\` SET deleted = 1 WHERE session_id = ? AND id >= ? AND ${notDeleted()}`,
      [sessionId, fromId],
    );
  }

  selectMessagesForSearch(sessionIds: number[], escapedKeyword: string): Promise<Message[]> {
    if (sessionIds.length === 0) {
      return Promise.resolve([]);
    }
    const placeholders = sessionIds.map(() => '?').join(',');
    return this.db.query<Message>(
      `SELECT t.sessionId AS sessionId, t.id AS id, t.content AS content
       FROM (
         SELECT m.session_id AS sessionId, m.id AS id, m.content AS content,
                ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.id ASC) AS rn
         FROM message m
         WHERE m.deleted = 0 AND m.role = 'USER'
           AND m.session_id IN (${placeholders})
           AND m.content LIKE CONCAT('%', ?, '%') ESCAPE '\\\\'
       ) t
       WHERE t.rn <= 5
       ORDER BY t.id ASC`,
      [...sessionIds, escapedKeyword],
    );
  }
}

export class FileChangeRepository {
  constructor(private readonly db: Db) {}

  async insert(change: FileChange): Promise<number> {
    const id = await this.db.insert('message_file_change', {
      messageId: change.messageId,
      sessionId: change.sessionId,
      filePath: change.filePath ?? (change as { path?: string }).path,
      changeType: change.changeType ?? (change as { type?: string }).type,
      linesAdded: change.linesAdded,
      linesDeleted: change.linesDeleted,
      diffMode: change.diffMode,
      beforeContent: change.beforeContent,
      afterContent: change.afterContent,
      patchContent: change.patchContent,
      patchTruncated: change.patchTruncated == null ? null : change.patchTruncated ? 1 : 0,
      diffUnavailableReason: change.diffUnavailableReason,
    });
    change.id = id;
    return id;
  }

  selectByMessageAndPath(messageId: number, path: string): Promise<FileChange | null> {
    return this.db.queryOne<FileChange>(
      `SELECT * FROM message_file_change WHERE message_id = ? AND file_path = ? LIMIT 1`,
      [messageId, path],
    );
  }

  async updateById(id: number, data: Partial<FileChange>): Promise<void> {
    await this.db.updateById('message_file_change', id, data as Record<string, unknown>);
  }

  listBySession(sessionId: number): Promise<FileChange[]> {
    return this.db.query<FileChange>(
      `SELECT * FROM message_file_change WHERE session_id = ? ORDER BY id ASC`,
      [sessionId],
    );
  }

  listByMessageIds(sessionId: number, messageIds: number[]): Promise<FileChange[]> {
    if (messageIds.length === 0) {
      return Promise.resolve([]);
    }
    const placeholders = messageIds.map(() => '?').join(',');
    return this.db.query<FileChange>(
      `SELECT * FROM message_file_change WHERE session_id = ? AND message_id IN (${placeholders}) ORDER BY id ASC`,
      [sessionId, ...messageIds],
    );
  }
}
