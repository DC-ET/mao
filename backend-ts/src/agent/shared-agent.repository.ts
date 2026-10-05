import type { Db } from '../db/db.js';

/** shared_agent_entry 行（DB 直读；dateStrings 使 DATETIME 以字符串返回）。 */
export interface SharedAgentEntryRow {
  id: number;
  agentId: number;
  note: string;
  sortOrder: number;
  createdBy: number;
  createdAt: string | null;
  updatedAt: string | null;
}

/** 团队共享目录仓储：薄封装（Db 直调，无 ORM），唯一键 uk_shared_agent(agent_id) 保证一 Agent 一条目。 */
export class SharedAgentEntryRepository {
  constructor(private readonly db: Db) {}

  findByAgentId(agentId: number): Promise<SharedAgentEntryRow | null> {
    return this.db.queryOne<SharedAgentEntryRow>('SELECT * FROM shared_agent_entry WHERE agent_id = ?', [agentId]);
  }

  listAll(): Promise<SharedAgentEntryRow[]> {
    return this.db.query<SharedAgentEntryRow>('SELECT * FROM shared_agent_entry ORDER BY sort_order ASC, agent_id ASC');
  }

  /** 重复上架即更新（upsert by agent_id）；created_by 保留首次上架人（ON DUPLICATE 不更新该列）。 */
  async upsert(agentId: number, note: string, sortOrder: number, createdBy: number): Promise<void> {
    await this.db.execute(
      `INSERT INTO shared_agent_entry (agent_id, note, sort_order, created_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE note = VALUES(note), sort_order = VALUES(sort_order)`,
      [agentId, note, sortOrder, createdBy],
    );
  }

  async deleteByAgentId(agentId: number): Promise<void> {
    await this.db.execute('DELETE FROM shared_agent_entry WHERE agent_id = ?', [agentId]);
  }
}
