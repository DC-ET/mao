import type { ApprovalRuleType } from './approval-rule-normalize.js';

export type { ApprovalRuleType };
export { APPROVAL_RULE_TYPES } from './approval-rule-normalize.js';

export type ApprovalRuleScope = 'SESSION' | 'USER';
export const APPROVAL_RULE_SCOPES: readonly ApprovalRuleScope[] = ['SESSION', 'USER'];

export interface ApprovalRuleRow {
  id: number;
  userId: number;
  scope: ApprovalRuleScope;
  sessionId: number | null;
  ruleType: ApprovalRuleType;
  ruleValue: string;
  hitCount: number;
  lastHitAt: string | null;
  enabled: number;
  createdAt: string;
  updatedAt: string;
}

/** 设置页规则 VO（仅用户级管理入口可见） */
export interface ApprovalRuleVo {
  id: number;
  scope: ApprovalRuleScope;
  sessionId: number | null;
  ruleType: ApprovalRuleType;
  ruleValue: string;
  hitCount: number;
  lastHitAt: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** admin 只读清单行（含用户名 / 会话标题 enrich） */
export interface ApprovalRuleAdminRow extends ApprovalRuleVo {
  userId: number;
  username: string | null;
  sessionTitle: string | null;
}

/** admin 只读清单筛选与分页参数。 */
export interface ApprovalRuleAdminFilter {
  userId?: number | null;
  ruleType?: ApprovalRuleType | null;
  enabled?: boolean | null;
  page: number;
  size: number;
}

export interface ApprovalRuleAdminPage {
  records: ApprovalRuleAdminRow[];
  total: number;
  page: number;
  size: number;
}
