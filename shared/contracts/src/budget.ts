// 用量预算的用户面契约（个人可见）。消费方：desktop（用量抽屉「预算」Tab）。
// 管理面 CRUD 仍走 admin（budget:read/write），不共用本文件。
// 单位口径（决策 4）：COST 的 limitValue 与 periodSpend 同为「成本单位」，
// 与模型价格填写口径一致；后端存储为微单位（×1e6），由服务端换算后下发。

export type BudgetScope = 'GLOBAL' | 'USER' | 'AGENT';
export type BudgetLimitType = 'COST' | 'TOKENS';
export type BudgetAction = 'WARN' | 'BLOCK';
/** 服务端派生（决策 5）：BLOCK 档越线 → BLOCKED；WARN 档越线 → WARNED；否则 NORMAL。 */
export type BudgetStatus = 'NORMAL' | 'WARNED' | 'BLOCKED';

export interface MyBudgetItemVO {
  id: number;
  scope: BudgetScope;
  /** 当期消耗（COST → 成本单位；TOKENS → token 原值）。 */
  periodSpend: number;
  /** 上限，与 periodSpend 同单位。 */
  limitValue: number;
  limitType: BudgetLimitType;
  action: BudgetAction;
  status: BudgetStatus;
  /** 周期标签 yyyy-MM（服务器本地时区）。 */
  period: string;
  /** 下次重置时间（服务器本地时区；月度 = 下月 1 日 00:00:00）。 */
  resetAt: string;
}

export interface MyBudgetsVO {
  items: MyBudgetItemVO[];
}
