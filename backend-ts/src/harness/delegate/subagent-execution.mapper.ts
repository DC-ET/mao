import type { Db } from '../../db/db.js';
import type { SubagentExecution } from '../../session/types.js';

export class SubagentExecutionMapper {
  constructor(private readonly db: Db) {}

  async insert(row: SubagentExecution): Promise<number> {
    const id = await this.db.insert('subagent_execution', {
      parentSessionId: row.parentSessionId,
      childSessionId: row.childSessionId,
      agentType: row.agentType,
      taskDescription: row.taskDescription,
      result: row.result ?? null,
      status: row.status ?? 'RUNNING',
      totalRounds: row.totalRounds ?? 0,
      totalPromptTokens: row.totalPromptTokens ?? 0,
      totalCompletionTokens: row.totalCompletionTokens ?? 0,
      startedAt: row.startedAt ?? null,
      completedAt: row.completedAt ?? null,
    });
    row.id = id;
    return id;
  }

  async updateById(id: number, data: Partial<SubagentExecution>): Promise<void> {
    await this.db.updateById('subagent_execution', id, data);
  }

  findByChildSessionId(childSessionId: number): Promise<SubagentExecution | null> {
    return this.db.queryOne<SubagentExecution>(
      'SELECT * FROM subagent_execution WHERE child_session_id = ? ORDER BY id DESC LIMIT 1',
      [childSessionId],
    );
  }

  countByChildSessionId(childSessionId: number): Promise<number> {
    return this.db.queryOne<{ c: number }>(
      'SELECT COUNT(*) AS c FROM subagent_execution WHERE child_session_id = ?',
      [childSessionId],
    ).then((r) => Number(r?.c ?? 0));
  }

  countCompletedByChildSessionId(childSessionId: number): Promise<number> {
    return this.db.queryOne<{ c: number }>(
      "SELECT COUNT(*) AS c FROM subagent_execution WHERE child_session_id = ? AND status = 'COMPLETED'",
      [childSessionId],
    ).then((r) => Number(r?.c ?? 0));
  }

  listByParent(parentSessionId: number): Promise<SubagentExecution[]> {
    return this.db.query<SubagentExecution>(
      'SELECT * FROM subagent_execution WHERE parent_session_id = ? ORDER BY id DESC',
      [parentSessionId],
    );
  }
}
