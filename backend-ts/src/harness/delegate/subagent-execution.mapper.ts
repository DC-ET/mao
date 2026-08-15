import type { Db } from '../../db/db.js';
import type { SubagentExecution } from '../../session/types.js';

export class SubagentExecutionMapper {
  constructor(private readonly db: Db) {}

  withDb(db: Db): SubagentExecutionMapper {
    return new SubagentExecutionMapper(db);
  }

  findById(id: number): Promise<SubagentExecution | null> {
    return this.db.queryOne<SubagentExecution>('SELECT * FROM subagent_execution WHERE id = ?', [id]);
  }

  findByIdForUpdate(id: number): Promise<SubagentExecution | null> {
    return this.db.queryOne<SubagentExecution>('SELECT * FROM subagent_execution WHERE id = ? FOR UPDATE', [id]);
  }

  async insert(row: SubagentExecution): Promise<number> {
    const id = await this.db.insert('subagent_execution', {
      parentSessionId: row.parentSessionId,
      childSessionId: row.childSessionId,
      agentType: row.agentType,
      invocationType: row.invocationType,
      parentToolCallId: row.parentToolCallId,
      deliveryStatus: row.deliveryStatus ?? 'PENDING',
      parentResultDeliveredAt: row.parentResultDeliveredAt ?? null,
      parentAssistantMessageId: row.parentAssistantMessageId ?? null,
      parentToolMessageId: row.parentToolMessageId ?? null,
      executionStartMessageId: row.executionStartMessageId ?? null,
      finalMessageId: row.finalMessageId ?? null,
      taskDescription: row.taskDescription,
      result: row.result ?? null,
      status: row.status ?? 'RUNNING',
      totalRounds: row.totalRounds ?? 0,
      totalPromptTokens: row.totalPromptTokens ?? 0,
      totalCompletionTokens: row.totalCompletionTokens ?? 0,
      totalToolCalls: row.totalToolCalls ?? 0,
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

  listRecoveryCandidates(): Promise<SubagentExecution[]> {
    return this.db.query<SubagentExecution>(
      `SELECT e.* FROM subagent_execution e
       JOIN session p ON p.id = e.parent_session_id AND p.deleted = 0
       WHERE e.delivery_status = 'PENDING'
         AND e.status IN ('RUNNING', 'RECOVERING', 'COMPLETED', 'FAILED', 'CANCELLED')
       ORDER BY e.parent_session_id, e.id`,
    );
  }

  async claimRecovering(id: number): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE subagent_execution SET status = 'RECOVERING'
       WHERE id = ? AND delivery_status = 'PENDING' AND status IN ('RUNNING', 'RECOVERING')`,
      [id],
    );
    return Number(result.affectedRows ?? 0) === 1;
  }

  async updateTerminal(id: number, data: Partial<SubagentExecution>): Promise<boolean> {
    const allowed = ['COMPLETED', 'FAILED', 'CANCELLED'];
    if (!data.status || !allowed.includes(data.status)) throw new Error(`Illegal subagent terminal status: ${data.status}`);
    const { status, ...fields } = data;
    const pairs = Object.entries(fields).filter(([, value]) => value !== undefined);
    const assignments = ['status = ?', ...pairs.map(([key]) => `${camelToSnake(key)} = ?`)];
    const result = await this.db.execute(
      `UPDATE subagent_execution SET ${assignments.join(', ')}
       WHERE id = ? AND status IN ('RUNNING', 'RECOVERING')`,
      [status, ...pairs.map(([, value]) => value), id],
    );
    return Number(result.affectedRows ?? 0) === 1;
  }

  findFirstByChildSessionId(childSessionId: number): Promise<SubagentExecution | null> {
    return this.db.queryOne<SubagentExecution>(
      'SELECT * FROM subagent_execution WHERE child_session_id = ? ORDER BY id ASC LIMIT 1',
      [childSessionId],
    );
  }
}

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
