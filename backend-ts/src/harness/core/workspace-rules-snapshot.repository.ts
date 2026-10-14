import type { Db } from '../../db/db.js';

/** 一行 = 一个会话当前生效的工作区规则快照（无历史留档，只保留"当前生效"）。 */
export interface SessionWorkspaceRulesRow {
  sessionId: number;
  workspace: string;
  rulesText: string;
  rulesHash: string;
  sourcePath: string | null;
  sourceMtime: number | null;
  createdAt: string;
  updatedAt: string;
}

/** 待冻结/覆盖写回的一行（时间列由 DB 维护，不入参）。 */
export interface SessionWorkspaceRulesUpsert {
  sessionId: number;
  workspace: string;
  rulesText: string;
  rulesHash: string;
  sourcePath: string | null;
  sourceMtime: number | null;
}

export class WorkspaceRulesSnapshotRepository {
  constructor(private readonly db: Db) {}

  selectBySessionId(sessionId: number): Promise<SessionWorkspaceRulesRow | null> {
    return this.db.queryOne<SessionWorkspaceRulesRow>(
      `SELECT session_id, workspace, rules_text, rules_hash, source_path, source_mtime, created_at, updated_at
         FROM session_workspace_rules WHERE session_id = ?`,
      [sessionId],
    );
  }

  /**
   * 冻结或覆盖写回，同刻并发只留一行。
   *
   * ON DUPLICATE KEY 必须是整列赋值而不是 no-op：workspace 不一致的旧行只有被改写，
   * 才不会把 A 工作区的规则继续注入到 B 工作区（技术方案 §4.2 评审补充）。
   */
  async upsert(row: SessionWorkspaceRulesUpsert): Promise<void> {
    await this.db.execute(
      `INSERT INTO session_workspace_rules
         (session_id, workspace, rules_text, rules_hash, source_path, source_mtime)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         workspace = VALUES(workspace),
         rules_text = VALUES(rules_text),
         rules_hash = VALUES(rules_hash),
         source_path = VALUES(source_path),
         source_mtime = VALUES(source_mtime)`,
      [row.sessionId, row.workspace, row.rulesText, row.rulesHash, row.sourcePath, row.sourceMtime],
    );
  }

  /** 失效（压缩提交后）与回收（会话删除/提升）共用；返回删除行数。 */
  async deleteBySessionId(sessionId: number): Promise<number> {
    const result = await this.db.execute(
      `DELETE FROM session_workspace_rules WHERE session_id = ?`,
      [sessionId],
    );
    return result.affectedRows;
  }
}
