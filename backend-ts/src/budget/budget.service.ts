import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { BudgetRepository, BudgetListItem, UsageBudgetRow } from './budget.repository.js';

export type BudgetScope = 'GLOBAL' | 'USER' | 'AGENT';

/** 预算检查目标：会话准入时由调用方从会话（或开放触发入参）提取。 */
export interface BudgetTarget {
  userId: number | null;
  agentId: number | null;
}

/** BLOCK 命中信息：message 拼装与错误码所需（技术方案 §5.7）。 */
export interface BudgetBlock {
  budgetId: number;
  scope: BudgetScope;
  scopeId: number | null;
  /** 当期消耗（COST → 成本单位；TOKENS → token 数） */
  spend: number;
  /** 上限（与 spend 同单位） */
  limitValue: number;
  limitType: 'COST' | 'TOKENS';
}

/** 预算行归属目标存在性查询（usage_budget 无外键，目标删除后行仍在 → 跳过检查，展示"已删除"）。 */
export interface BudgetTargetLookup {
  findUser(id: number): Promise<{ id: number; name?: string | null } | null>;
  findAgent(id: number): Promise<{ id: number; name?: string | null } | null>;
}

/** BUDGET_WARN 收件箱写入（窄接口，InboxService 实现；避免 budget 域反向依赖 inbox 实现细节）。 */
export interface BudgetWarnRecorder {
  recordBudgetWarn(input: {
    userId: number;
    budgetId: number;
    scope: BudgetScope;
    /** 当期消耗（展示口径：COST → 成本单位；TOKENS → token 数） */
    spend: number;
    limitValue: number;
    limitType: 'COST' | 'TOKENS';
    /** 周期标签 yyyy-MM（dedup 维度之一，服务器本地时区） */
    period: string;
  }): Promise<void>;
}

const SCOPES: ReadonlySet<string> = new Set(['GLOBAL', 'USER', 'AGENT']);
const LIMIT_TYPES: ReadonlySet<string> = new Set(['COST', 'TOKENS']);
const ACTIONS: ReadonlySet<string> = new Set(['WARN', 'BLOCK']);

/** 周期起点：服务器本地时区当月 1 日 00:00（技术方案 §5.6）。 */
export function monthStartLocal(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01 00:00:00`;
}

/** 周期标签（收件箱去重 tail 用）：yyyy-MM。 */
export function currentPeriodLabel(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * 用量预算服务：当期消耗查询（§5.6）、任务准入 BLOCK 检查（§5.7）、WARN 结算（§5.8）、
 * 预算行 CRUD（§5.9）。子代理/边路不在此检查（跟随父会话准入结论，调用方过滤）。
 */
export class BudgetService {
  constructor(
    private readonly repo: BudgetRepository,
    private readonly spendStore: {
      /** 按维度求和：COST → SUM(cost_micros)（微单位整数）；TOKENS → SUM(total_tokens)。 */
      sumCostSince(scope: 'GLOBAL' | 'USER' | 'AGENT', scopeId: number | null, since: string): Promise<number>;
      sumTokensSince(scope: 'GLOBAL' | 'USER' | 'AGENT', scopeId: number | null, since: string): Promise<number>;
    },
    private readonly targetLookup: BudgetTargetLookup,
    private readonly warnRecorder?: BudgetWarnRecorder | null,
  ) {}

  /** 当期消耗（检查口径原值：COST 返回微单位整数，TOKENS 返回 token 数）。 */
  async getPeriodSpend(scope: BudgetScope, scopeId: number | null, limitType: 'COST' | 'TOKENS', now?: Date): Promise<number> {
    const since = monthStartLocal(now);
    return limitType === 'COST'
      ? this.spendStore.sumCostSince(scope, scopeId, since)
      : this.spendStore.sumTokensSince(scope, scopeId, since);
  }

  /**
   * 任务准入 BLOCK 检查（§5.7）：enabled 的 BLOCK 行按 GLOBAL → USER → AGENT 逐一比对，
   * 命中即拒（返回首个命中行）。目标已删除的行跳过；userId/agentId 缺失跳过对应 scope。
   */
  async checkAdmission(target: BudgetTarget): Promise<BudgetBlock | null> {
    const rows = await this.safeEnabledRows('BLOCK');
    for (const row of rows) {
      const scope = row.scope as BudgetScope;
      if (scope === 'USER' && (target.userId == null || row.scopeId == null || row.scopeId !== target.userId)) continue;
      if (scope === 'AGENT' && (target.agentId == null || row.scopeId == null || row.scopeId !== target.agentId)) continue;
      if (!(await this.targetExists(scope, row.scopeId))) continue;
      const limitType = row.limitType as 'COST' | 'TOKENS';
      const spend = await this.getPeriodSpend(scope, row.scopeId ?? null, limitType);
      if (spend >= Number(row.limitValue)) {
        return {
          budgetId: row.id!,
          scope,
          scopeId: row.scopeId ?? null,
          spend: this.displaySpend(limitType, spend),
          limitValue: this.displaySpend(limitType, Number(row.limitValue)),
          limitType,
        };
      }
    }
    return null;
  }

  /**
   * WARN 结算（§5.8）：任务终态后调用。GLOBAL+USER+AGENT 的 enabled WARN 行合并检查，
   * 越线行各写一条 BUDGET_WARN 收件箱（dedup 由 InboxService 按 budgetId+周期幂等）。
   * fire-and-forget 语义：任何异常吞掉并 warn，不影响终态链。
   */
  async settleWarn(target: BudgetTarget, notifyUserId: number | null, now?: Date): Promise<void> {
    if (notifyUserId == null) return;
    let rows: UsageBudgetRow[];
    try {
      rows = await this.safeEnabledRows('WARN');
    } catch (e) {
      console.warn(`[budget] warn settle failed to load rows: ${(e as Error).message}`);
      return;
    }
    if (rows.length === 0) return;
    const spendCache = new Map<string, number>();
    const spendOf = async (limitType: 'COST' | 'TOKENS', scope: BudgetScope, scopeId: number | null): Promise<number> => {
      const key = `${limitType}:${scope}:${scopeId ?? ''}`;
      let v = spendCache.get(key);
      if (v == null) {
        v = await this.getPeriodSpend(scope, scopeId, limitType, now);
        spendCache.set(key, v);
      }
      return v;
    };
    for (const row of rows) {
      const scope = row.scope as BudgetScope;
      if (scope === 'USER' && (target.userId == null || row.scopeId == null || row.scopeId !== target.userId)) continue;
      if (scope === 'AGENT' && (target.agentId == null || row.scopeId == null || row.scopeId !== target.agentId)) continue;
      if (!(await this.targetExists(scope, row.scopeId))) continue;
      const limitType = row.limitType as 'COST' | 'TOKENS';
      try {
        const spend = await spendOf(limitType, scope, row.scopeId ?? null);
        if (spend >= Number(row.limitValue) && this.warnRecorder != null && row.id != null) {
          await this.warnRecorder.recordBudgetWarn({
            userId: notifyUserId,
            budgetId: row.id,
            scope,
            spend: this.displaySpend(limitType, spend),
            limitValue: this.displaySpend(limitType, Number(row.limitValue)),
            limitType,
            period: currentPeriodLabel(now ?? new Date()),
          });
        }
      } catch (e) {
        console.warn(`[budget] warn settle failed for budget ${row.id}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * 队列消费 BLOCK 留队提醒（§5.7）：复用 BUDGET_WARN kind，dedup 按 budgetId+周期，
   * 同周期同预算恰好提醒一次。通知目标是会话属主（notifyUserId）。
   */
  async noticeQueueBlocked(block: BudgetBlock, notifyUserId: number | null): Promise<void> {
    if (this.warnRecorder == null || notifyUserId == null) return;
    await this.warnRecorder.recordBudgetWarn({
      userId: notifyUserId,
      budgetId: block.budgetId,
      scope: block.scope,
      spend: block.spend,
      limitValue: block.limitValue,
      limitType: block.limitType,
      period: currentPeriodLabel(),
    });
  }

  async list(filter: { scope?: string | null; action?: string | null } = {}): Promise<BudgetListItem[]> {
    const rows = await this.repo.list(filter);
    const since = monthStartLocal();
    const items: BudgetListItem[] = [];
    for (const row of rows) {
      const item: BudgetListItem = { ...row };
      const scope = row.scope as BudgetScope;
      if (row.scopeId != null) {
        if (scope === 'USER') {
          const user = await this.targetLookup.findUser(row.scopeId).catch(() => null);
          item.targetName = user?.name ?? null;
          item.targetDeleted = user == null;
        } else if (scope === 'AGENT') {
          const agent = await this.targetLookup.findAgent(row.scopeId).catch(() => null);
          item.targetName = agent?.name ?? null;
          item.targetDeleted = agent == null;
        }
      }
      if (row.enabled === 1 && SCOPES.has(scope)) {
        const limitType = row.limitType as 'COST' | 'TOKENS';
        if (limitType === 'COST' || limitType === 'TOKENS') {
          const spend = await this.safeSpend(limitType, scope, row.scopeId ?? null, since);
          // 列表展示口径：COST 由微单位换算为成本单位（与价格填写单位一致）
          item.periodSpend = spend == null ? null : (limitType === 'COST' ? spend / 1_000_000 : spend);
        }
      }
      items.push(item);
    }
    return items;
  }

  async create(input: {
    scope: string;
    scopeId?: number | null;
    period?: string | null;
    limitType: string;
    limitValue: number;
    action: string;
    enabled?: number | boolean;
    createdBy?: number | null;
  }): Promise<UsageBudgetRow> {
    const normalized = this.validate(input);
    if (normalized.scope === 'GLOBAL') {
      await this.assertNoExistingGlobal(null);
    }
    const row: UsageBudgetRow = { ...normalized, createdBy: input.createdBy ?? null };
    row.id = await this.repo.insert(row);
    return row;
  }

  async update(id: number, input: {
    scope: string;
    scopeId?: number | null;
    period?: string | null;
    limitType: string;
    limitValue: number;
    action: string;
    enabled?: number | boolean;
  }): Promise<UsageBudgetRow> {
    const existing = await this.repo.findById(id);
    if (existing == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '预算不存在');
    }
    const normalized = this.validate(input);
    if (normalized.scope === 'GLOBAL') {
      await this.assertNoExistingGlobal(id);
    }
    const row: UsageBudgetRow = { ...normalized, id };
    await this.repo.updateById(row);
    return { ...row, createdBy: existing.createdBy, createdAt: existing.createdAt };
  }

  async remove(id: number): Promise<void> {
    const existing = await this.repo.findById(id);
    if (existing == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '预算不存在');
    }
    await this.repo.deleteById(id);
  }

  /** GLOBAL 行至多一条（含停用行，避免停用行复活时冲突）。 */
  private async assertNoExistingGlobal(excludeId: number | null): Promise<void> {
    const rows = await this.repo.list({ scope: 'GLOBAL' });
    if (rows.some((r) => r.id != null && r.id !== excludeId)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'GLOBAL 作用域至多一条预算，请编辑既有行');
    }
  }

  private validate(input: {
    scope: string;
    scopeId?: number | null;
    period?: string | null;
    limitType: string;
    limitValue: number;
    action: string;
    enabled?: number | boolean;
  }): Omit<UsageBudgetRow, 'id' | 'createdBy' | 'createdAt' | 'updatedAt'> {
    const scope = String(input.scope ?? '').trim();
    if (!SCOPES.has(scope)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'scope 只能是 GLOBAL / USER / AGENT');
    }
    let scopeId: number | null = input.scopeId ?? null;
    if (scope === 'GLOBAL') {
      scopeId = null;
    } else {
      if (scopeId == null || !Number.isInteger(scopeId) || scopeId <= 0) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, 'USER / AGENT 预算必须指定目标 id');
      }
    }
    const limitType = String(input.limitType ?? '').trim();
    if (!LIMIT_TYPES.has(limitType)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'limitType 只能是 COST / TOKENS');
    }
    const limitValue = Number(input.limitValue);
    if (!Number.isInteger(limitValue) || limitValue <= 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'limitValue 必须为正整数（COST 为成本×1e6 微单位口径）');
    }
    const action = String(input.action ?? '').trim();
    if (!ACTIONS.has(action)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'action 只能是 WARN / BLOCK');
    }
    const enabled = input.enabled == null ? 1 : (input.enabled === true ? 1 : input.enabled === false ? 0 : Number(input.enabled) ? 1 : 0);
    return {
      scope,
      scopeId,
      period: 'MONTHLY',
      limitType,
      limitValue,
      action,
      enabled,
    };
  }

  /** enabled 行按 GLOBAL → USER → AGENT 定序（§5.7 检查顺序；同 scope 内保持 id 升序稳定）。 */
  private async safeEnabledRows(action: 'WARN' | 'BLOCK'): Promise<UsageBudgetRow[]> {
    const rows = await this.repo.list({ action, enabledOnly: true });
    return [...rows].sort((a, b) => this.scopeOrder(a.scope) - this.scopeOrder(b.scope));
  }

  private scopeOrder(scope: string): number {
    return scope === 'GLOBAL' ? 0 : scope === 'USER' ? 1 : 2;
  }

  private async targetExists(scope: BudgetScope, scopeId: number | null | undefined): Promise<boolean> {
    if (scope === 'GLOBAL') return true;
    if (scopeId == null) return false;
    try {
      if (scope === 'USER') return await this.targetLookup.findUser(scopeId) != null;
      if (scope === 'AGENT') return await this.targetLookup.findAgent(scopeId) != null;
    } catch (e) {
      console.warn(`[budget] target lookup failed for ${scope} ${scopeId}: ${(e as Error).message}`);
      return false;
    }
    return false;
  }

  private async safeSpend(limitType: 'COST' | 'TOKENS', scope: BudgetScope, scopeId: number | null, since: string): Promise<number | null> {
    try {
      // 必须 await：sum*Since 返回 Promise，不 await 时 catch 拿不到异步拒绝，
      // 列表页一次消耗查询失败会让整个 /admin/budgets 500。
      return await (limitType === 'COST'
        ? this.spendStore.sumCostSince(scope, scopeId, since)
        : this.spendStore.sumTokensSince(scope, scopeId, since));
    } catch (e) {
      console.warn(`[budget] period spend failed for ${scope}: ${(e as Error).message}`);
      return null;
    }
  }

  /** 展示口径换算：COST 微单位 → 成本单位；TOKENS 原值。 */
  private displaySpend(limitType: 'COST' | 'TOKENS', value: number): number {
    return limitType === 'COST' ? value / 1_000_000 : value;
  }
}
