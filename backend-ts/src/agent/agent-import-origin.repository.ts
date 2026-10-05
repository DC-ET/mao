import type { Db } from '../db/db.js';

/** agent_import_origin 行（DB 直读；dateStrings 使 DATETIME 以字符串返回）。 */
export interface AgentImportOriginRow {
  id: number;
  agentId: number;
  sourceUrl: string;
  contentHash: string;
  importedSystemPrompt: string | null;
  importedBy: number;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * Agent bundle 导入来源仓储：只保留每个 Agent 最近一次来源（uk_import_origin_agent，单行 upsert）。
 * check-updates 以 content_hash 为远端变更比对基准、imported_system_prompt 为本地漂移检测快照。
 */
export class AgentImportOriginRepository {
  constructor(private readonly db: Db) {}

  findByAgentId(agentId: number): Promise<AgentImportOriginRow | null> {
    return this.db.queryOne<AgentImportOriginRow>('SELECT * FROM agent_import_origin WHERE agent_id = ?', [agentId]);
  }

  listAll(): Promise<AgentImportOriginRow[]> {
    return this.db.query<AgentImportOriginRow>('SELECT * FROM agent_import_origin ORDER BY agent_id ASC');
  }

  /** 重复导入即覆盖（uk agent_id）；imported_by 记录最近一次操作者。 */
  async upsert(
    agentId: number,
    sourceUrl: string,
    contentHash: string,
    importedSystemPrompt: string | null,
    importedBy: number,
  ): Promise<void> {
    await this.db.execute(
      `INSERT INTO agent_import_origin (agent_id, source_url, content_hash, imported_system_prompt, imported_by)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE source_url = VALUES(source_url), content_hash = VALUES(content_hash),
         imported_system_prompt = VALUES(imported_system_prompt), imported_by = VALUES(imported_by)`,
      [agentId, sourceUrl, contentHash, importedSystemPrompt, importedBy],
    );
  }
}
