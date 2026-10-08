import type { Db } from '../db/db.js';

export type BudgetScope = 'GLOBAL' | 'USER' | 'AGENT';
export type BudgetLimitType = 'COST' | 'TOKENS';
export type BudgetAction = 'WARN' | 'BLOCK';

export interface UsageBudgetRow {
  id?: number;
  scope: string;
  scopeId?: number | null;
  period?: string | null;
  limitType: string;
  limitValue: number;
  action: string;
  enabled?: number | null;
  createdBy?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** 列表行附加的目标名（USER→用户名，AGENT→Agent 名；目标已删为 null）。 */
export interface BudgetListItem extends UsageBudgetRow {
  targetName?: string | null;
  targetDeleted?: boolean;
  /** 当期消耗（COST → 成本单位；TOKENS → total_tokens） */
  periodSpend?: number | null;
}

export interface BudgetListFilter {
  scope?: string | null;
  action?: string | null;
  enabledOnly?: boolean;
}

export class BudgetRepository {
  constructor(private readonly db: Db) {}

  async list(filter: BudgetListFilter): Promise<UsageBudgetRow[]> {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (filter.scope != null && filter.scope.trim() !== '') {
      where.push('scope = ?');
      params.push(filter.scope.trim());
    }
    if (filter.action != null && filter.action.trim() !== '') {
      where.push('action = ?');
      params.push(filter.action.trim());
    }
    if (filter.enabledOnly) {
      where.push('enabled = 1');
    }
    return this.db.query<UsageBudgetRow>(
      `SELECT * FROM usage_budget WHERE ${where.join(' AND ')} ORDER BY id ASC`,
      params,
    );
  }

  async findById(id: number): Promise<UsageBudgetRow | null> {
    return this.db.queryOne<UsageBudgetRow>('SELECT * FROM usage_budget WHERE id = ?', [id]);
  }

  async insert(row: UsageBudgetRow): Promise<number> {
    return this.db.insert('usage_budget', {
      scope: row.scope,
      scopeId: row.scopeId ?? null,
      period: row.period ?? 'MONTHLY',
      limitType: row.limitType,
      limitValue: row.limitValue,
      action: row.action,
      enabled: row.enabled ?? 1,
      createdBy: row.createdBy ?? null,
    });
  }

  async updateById(row: UsageBudgetRow): Promise<void> {
    if (row.id == null) return;
    await this.db.updateById('usage_budget', row.id, {
      scope: row.scope,
      scopeId: row.scopeId ?? null,
      period: row.period ?? 'MONTHLY',
      limitType: row.limitType,
      limitValue: row.limitValue,
      action: row.action,
      enabled: row.enabled ?? 1,
    });
  }

  /** 物理删：无历史引用（技术方案 §5.9）。 */
  async deleteById(id: number): Promise<void> {
    await this.db.execute('DELETE FROM usage_budget WHERE id = ?', [id]);
  }
}

/**
 * 当期消耗查询（技术方案 §5.6）：对 llm_call 按 scope 维度 SUM。
 * USER 走 idx_llm_call_user_created，AGENT 走 V138 新增 idx_llm_call_agent_created，
 * GLOBAL 全表（idx_llm_call_created 范围扫描）。NULL 的 cost_micros 行 SUM 自动忽略。
 */
export class BudgetSpendStore {
  constructor(private readonly db: Db) {}

  async sumCostSince(scope: 'GLOBAL' | 'USER' | 'AGENT', scopeId: number | null, since: string): Promise<number> {
    return this.sum('cost_micros', scope, scopeId, since);
  }

  async sumTokensSince(scope: 'GLOBAL' | 'USER' | 'AGENT', scopeId: number | null, since: string): Promise<number> {
    return this.sum('total_tokens', scope, scopeId, since);
  }

  private async sum(column: 'cost_micros' | 'total_tokens', scope: 'GLOBAL' | 'USER' | 'AGENT', scopeId: number | null, since: string): Promise<number> {
    const row = await this.db.queryOne<{ v: number | null }>(
      `SELECT COALESCE(SUM(${column}), 0) AS v FROM llm_call
       WHERE created_at >= ?${scope === 'USER' ? ' AND user_id = ?' : scope === 'AGENT' ? ' AND agent_id = ?' : ''}`,
      scope === 'GLOBAL' ? [since] : [since, scopeId],
    );
    return Number(row?.v ?? 0);
  }
}
