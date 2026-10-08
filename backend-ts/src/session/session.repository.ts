import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import { toSnakeRow } from '../common/case.js';
import { nowSql } from '../common/datetime.js';
import type { FileChange, Message, Session, SessionGroupPage } from './types.js';

export const SESSION_SOURCE_VALUES = ['web', 'embed'] as const;
export type SessionSource = (typeof SESSION_SOURCE_VALUES)[number];

export const isSessionSource = (value: unknown): value is SessionSource =>
  typeof value === 'string' && (SESSION_SOURCE_VALUES as readonly string[]).includes(value);

export interface SessionListFilter {
  userId: number;
  agentId?: number | null;
  source?: SessionSource | null;
}

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

  /**
   * 递归列出 rootIds 各自主会话树下的全部后代边路任务（不含 rootIds 自身）。
   * BFS 逐层按 parent_session_id IN 批量下钻，返回 rootId -> 后代列表（无序，由调用方排序）。
   * 归档节点不入结果且不向其下钻（归档子树整体隐藏）；父已删除的孤儿链因断链天然不可达。
   * depthLimit 仅防病态数据（环 / 超深链），正常树 1-3 层即收敛。
   */
  async listDescendantSideTasksByRoots(
    rootIds: number[],
    userId?: number,
    depthLimit = 10,
  ): Promise<Map<number, Session[]>> {
    const byRoot = new Map<number, Session[]>();
    if (rootIds.length === 0) return byRoot;
    // frontier: 待下钻的节点 id -> 所属根；visited 防环（正常树不会命中）
    let frontier = new Map<number, number>();
    const visited = new Set<number>();
    for (const rootId of rootIds) {
      frontier.set(rootId, rootId);
      visited.add(rootId);
    }
    for (let depth = 0; depth < depthLimit && frontier.size > 0; depth++) {
      const ids = [...frontier.keys()];
      const placeholders = ids.map(() => '?').join(',');
      const userClause = userId != null ? ' AND user_id = ?' : '';
      const children = await this.db.query<Session>(
        `SELECT * FROM \`session\`
         WHERE parent_session_id IN (${placeholders})
           AND session_type = 'SIDE_TASK'
           AND (status IS NULL OR status <> 'ARCHIVED')
           AND ${notDeleted()}${userClause}`,
        userId != null ? [...ids, userId] : ids,
      );
      const next = new Map<number, number>();
      for (const child of children) {
        const id = child.id;
        const parentKey = child.parentSessionId;
        if (id == null || parentKey == null || visited.has(id)) continue;
        const rootId = frontier.get(parentKey);
        if (rootId == null) continue;
        visited.add(id);
        const list = byRoot.get(rootId) ?? [];
        list.push(child);
        byRoot.set(rootId, list);
        next.set(id, rootId);
      }
      frontier = next;
    }
    return byRoot;
  }

  /** 单根递归列出全部后代边路任务（按 updated_at 降序、id 降序平铺）。 */
  async listDescendantSideTasks(rootId: number, userId?: number): Promise<Session[]> {
    const byRoot = await this.listDescendantSideTasksByRoots([rootId], userId);
    const list = byRoot.get(rootId) ?? [];
    list.sort((a, b) => {
      const ta = a.updatedAt ?? '';
      const tb = b.updatedAt ?? '';
      if (ta !== tb) return ta < tb ? 1 : -1;
      return (b.id ?? 0) - (a.id ?? 0);
    });
    return list;
  }

  findActiveByUserAndProjectKey(userId: number, projectKey: string): Promise<Session | null> {
    return this.db.queryOne<Session>(
      `SELECT * FROM \`session\` WHERE user_id = ? AND project_key = ? AND status = 'ACTIVE' AND ${notDeleted()} LIMIT 1`,
      [userId, projectKey],
    );
  }

  /** 用户历史会话出现过的 (project_key, workspace) 去重集合，供记忆项目下拉与抽取渠道判定。 */
  listProjectKeyRows(userId: number): Promise<Array<{ projectKey: string; workspace: string | null }>> {
    return this.db.query(
      `SELECT project_key AS projectKey, MAX(workspace) AS workspace
       FROM \`session\` WHERE user_id = ? AND ${notDeleted()} AND project_key IS NOT NULL AND project_key <> ''
       GROUP BY project_key`,
      [userId],
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
      source: session.source ?? 'web',
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

  /**
   * CAS：仅当 phase 落在他值集合内才改写（并刷新 last_activity_at）。
   *
   * 停机收尾必须用它而不是"先读后写"：执行线程可能在读完之后写入终态，
   * 无条件写会把 COMPLETED/FAILED 覆盖回运行态，使已完成的会话被当成孤儿重新执行。
   */
  markPhaseIfIn(sessionId: number, phase: string, expected: string[]): Promise<number> {
    if (expected.length === 0) return Promise.resolve(0);
    const placeholders = expected.map(() => '?').join(', ');
    return this.updateWhere(
      { phase, lastActivityAt: nowSql() },
      `id = ? AND deleted = 0 AND phase IN (${placeholders})`,
      [sessionId, ...expected],
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

  /** 把 oldParentId 的全部未删除子会话重挂到 newParentId 名下（提升边路任务时子树跟随新主会话用）。 */
  async reparentChildrenTo(oldParentId: number, newParentId: number): Promise<void> {
    await this.db.execute(
      `UPDATE \`session\` SET parent_session_id = ? WHERE parent_session_id = ? AND ${notDeleted()}`,
      [newParentId, oldParentId],
    );
  }

  list(whereSql: string, params: unknown[], orderSql: string): Promise<Session[]> {
    return this.db.query<Session>(
      `SELECT * FROM \`session\` WHERE ${whereSql} AND ${notDeleted()} ${orderSql}`,
      params,
    );
  }

  /** Embed SDK 历史列表：user + agent + source 过滤，主会话，updated_at 倒序分页 */
  async pageSessionsByFilter(filter: SessionListFilter, offset: number, limit: number): Promise<SessionGroupPage> {
    const clauses = ['user_id = ?', `session_type NOT IN ('SUBAGENT', 'SIDE_TASK')`, 'status = ?', 'source = ?'];
    const params: unknown[] = [filter.userId, 'ACTIVE', filter.source ?? 'web'];
    if (filter.agentId != null) {
      clauses.push('agent_id = ?');
      params.push(filter.agentId);
    }
    const whereSql = clauses.join(' AND ');
    const total = await this.count(whereSql, params);
    const items = await this.list(whereSql, params, `ORDER BY updated_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`);
    return { items, total, offset, limit, hasMore: offset + items.length < total };
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
      `SELECT DISTINCT s.id, s.title, s.session_type, s.parent_session_id, s.phase, s.status, s.updated_at, s.agent_id
       FROM session s
       JOIN message m ON m.session_id = s.id AND m.deleted = 0
       WHERE s.user_id = ? AND s.deleted = 0
         AND s.session_type IN ('NORMAL', 'SIDE_TASK')
         AND m.role = 'USER'
         AND m.content LIKE CONCAT('%', ?, '%') ESCAPE '\\\\'
         AND (
           s.session_type = 'NORMAL'
           OR EXISTS (
             SELECT 1 FROM session p
             WHERE p.id = s.parent_session_id
               AND p.user_id = s.user_id
               AND p.deleted = 0
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

  /**
   * 取会话内截止到指定消息的全部内容（fork 预览口径：切点即被点击那一轮的助手最终回复 id，
   * 含边界）。不传 cutMessageId 时等价于 listBySession。
   */
  selectThroughMessage(sessionId: number, cutMessageId: number | null): Promise<Message[]> {
    if (cutMessageId == null) return this.listBySession(sessionId);
    return this.db.query<Message>(
      `SELECT * FROM \`message\` WHERE session_id = ? AND ${notDeleted()} AND id <= ? ORDER BY created_at ASC, id ASC`,
      [sessionId, cutMessageId],
    );
  }

  /**
   * 轮次分页的「用户消息起点」，上界含切点。
   * 与 selectUserStarts 的区别只在边界：切点是那一轮的助手最终回复，该轮的用户消息 id 必然
   * 小于它；用 selectUserStarts 的排他边界（beforeId）会把那一整轮漏掉，预览就看不见来源轮次。
   * beforeMessageId 用于向上翻页，与 selectUserStarts 同义。
   */
  selectUserStartsThrough(
    sessionId: number,
    cutMessageId: number,
    beforeMessageId: number | null,
    limit: number,
  ): Promise<Message[]> {
    if (beforeMessageId != null) {
      return this.db.query<Message>(
        `SELECT * FROM \`message\` WHERE session_id = ? AND ${notDeleted()} AND role = 'USER'
          AND id <= ? AND id < ? ORDER BY id DESC LIMIT ?`,
        [sessionId, cutMessageId, beforeMessageId, limit],
      );
    }
    return this.db.query<Message>(
      `SELECT * FROM \`message\` WHERE session_id = ? AND ${notDeleted()} AND role = 'USER' AND id <= ? ORDER BY id DESC LIMIT ?`,
      [sessionId, cutMessageId, limit],
    );
  }

  /** selectRange 的含切点上界版本：`id >= startId AND id <= cutMessageId`。 */
  selectRangeThrough(sessionId: number, startId: number, cutMessageId: number): Promise<Message[]> {
    return this.db.query<Message>(
      `SELECT * FROM \`message\` WHERE session_id = ? AND ${notDeleted()} AND id >= ? AND id <= ? ORDER BY created_at ASC, id ASC`,
      [sessionId, startId, cutMessageId],
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

  /**
   * 首条用户消息判定（标题生成用）：该消息之前是否还有本会话**自己发**的用户消息。
   * 复制来的消息（source_session_id 非空）不算——分叉边路任务的历史用户消息全是复制来的，
   * 只有用户在边路面板发的那条才该触发命名。
   */
  async hasOwnEarlierUserMessage(sessionId: number, messageId: number): Promise<boolean> {
    const row = await this.db.queryOne<{ id: number }>(
      `SELECT id FROM \`message\` WHERE session_id = ? AND role = 'USER' AND source_session_id IS NULL
        AND id < ? AND ${notDeleted()} LIMIT 1`,
      [sessionId, messageId],
    );
    return row != null;
  }

  selectUserStarts(
    sessionId: number,
    beforeId: number | null,
    limit: number,
    maxMessageId?: number | null,
    excludeSourceSessionId?: number | null,
  ): Promise<Message[]> {
    const cap = maxMessageId == null ? '' : ' AND id <= ?';
    const capParams = maxMessageId == null ? [] : [maxMessageId];
    const src = sourceExcludeSql(excludeSourceSessionId);
    if (beforeId != null) {
      return this.db.query<Message>(
        `SELECT * FROM \`message\` WHERE session_id = ? AND ${notDeleted()} AND role = 'USER' AND id < ?${cap}${src.sql} ORDER BY id DESC LIMIT ?`,
        [sessionId, beforeId, ...capParams, ...src.params, limit],
      );
    }
    return this.db.query<Message>(
      `SELECT * FROM \`message\` WHERE session_id = ? AND ${notDeleted()} AND role = 'USER'${cap}${src.sql} ORDER BY id DESC LIMIT ?`,
      [sessionId, ...capParams, ...src.params, limit],
    );
  }

  selectRange(
    sessionId: number,
    startId: number,
    beforeId: number | null,
    maxMessageId?: number | null,
    excludeSourceSessionId?: number | null,
  ): Promise<Message[]> {
    const cap = maxMessageId == null ? '' : ' AND id <= ?';
    const capParams = maxMessageId == null ? [] : [maxMessageId];
    const src = sourceExcludeSql(excludeSourceSessionId);
    if (beforeId != null) {
      return this.db.query<Message>(
        `SELECT * FROM \`message\` WHERE session_id = ? AND ${notDeleted()} AND id >= ? AND id < ?${cap}${src.sql} ORDER BY created_at ASC, id ASC`,
        [sessionId, startId, beforeId, ...capParams, ...src.params],
      );
    }
    return this.db.query<Message>(
      `SELECT * FROM \`message\` WHERE session_id = ? AND ${notDeleted()} AND id >= ?${cap}${src.sql} ORDER BY created_at ASC, id ASC`,
      [sessionId, startId, ...capParams, ...src.params],
    );
  }

  async logicalDeleteById(id: number): Promise<void> {
    await this.db.execute(`UPDATE \`message\` SET deleted = 1 WHERE id = ? AND ${notDeleted()}`, [id]);
  }

  /** 限会话范围的按 id 逻辑删除：id 落在其他会话时不误删（微信入站消息被取代时回滚用）。 */
  async logicalDeleteByIdInSession(sessionId: number, id: number): Promise<void> {
    await this.db.execute(
      `UPDATE \`message\` SET deleted = 1 WHERE id = ? AND session_id = ? AND ${notDeleted()}`,
      [id, sessionId],
    );
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

  /** 最后一条 role=ASSISTANT 且正文非空的消息（记忆抽取输入，技术方案 5.6 D8）。 */
  selectLastAssistantMessage(sessionId: number): Promise<Message | null> {
    return this.db.queryOne<Message>(
      `SELECT * FROM \`message\` WHERE session_id = ? AND role = 'ASSISTANT'
         AND content IS NOT NULL AND content <> '' AND ${notDeleted()}
       ORDER BY id DESC LIMIT 1`,
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

  /** 管理端关键词命中片段：每会话取第一条命中消息（任意角色）。 */
  selectFirstMatchingMessages(
    sessionIds: number[],
    escapedKeyword: string,
  ): Promise<Array<{ sessionId: number; content: string | null }>> {
    if (sessionIds.length === 0) {
      return Promise.resolve([]);
    }
    const placeholders = sessionIds.map(() => '?').join(',');
    return this.db.query<{ sessionId: number; content: string | null }>(
      `SELECT t.sessionId AS sessionId, t.content AS content
       FROM (
         SELECT m.session_id AS sessionId, m.content AS content,
                ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.id ASC) AS rn
         FROM message m
         WHERE m.deleted = 0
           AND m.session_id IN (${placeholders})
           AND m.content LIKE CONCAT('%', ?, '%') ESCAPE '\\\\'
       ) t
       WHERE t.rn = 1`,
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

  /**
   * 管理端聊天记录只展示路径和行数。diff 正文是 MEDIUMTEXT，SELECT * 会把整段快照从磁盘读出来。
   */
  listSummaryBySession(sessionId: number, excludeSourceSessionId?: number | null): Promise<FileChange[]> {
    const src = sourceExcludeSql(excludeSourceSessionId, 'm');
    return this.db.query<FileChange>(
      `SELECT fc.id, fc.message_id, fc.session_id, fc.file_path, fc.change_type, fc.lines_added, fc.lines_deleted
       FROM message_file_change fc
       INNER JOIN \`message\` m ON m.id = fc.message_id AND ${notDeleted('m')}
       WHERE fc.session_id = ?${src.sql}
       ORDER BY fc.id ASC`,
      [sessionId, ...src.params],
    );
  }

  listSummaryByMessageIds(sessionId: number, messageIds: number[]): Promise<FileChange[]> {
    if (messageIds.length === 0) {
      return Promise.resolve([]);
    }
    const placeholders = messageIds.map(() => '?').join(',');
    return this.db.query<FileChange>(
      `SELECT id, message_id, session_id, file_path, change_type, lines_added, lines_deleted
       FROM message_file_change
       WHERE session_id = ? AND message_id IN (${placeholders})
       ORDER BY id ASC`,
      [sessionId, ...messageIds],
    );
  }
}

/** 边路分享/导出排除从父会话 fork 复制来的行。不传时 SQL 与原来一致。 */
function sourceExcludeSql(excludeSourceSessionId?: number | null, alias?: string): { sql: string; params: number[] } {
  if (excludeSourceSessionId == null) return { sql: '', params: [] };
  const column = alias ? `${alias}.source_session_id` : 'source_session_id';
  return { sql: ` AND (${column} IS NULL OR ${column} <> ?)`, params: [excludeSourceSessionId] };
}
