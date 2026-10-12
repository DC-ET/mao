/**
 * 审批规则契约（前后端共用，desktop / admin 同步消费）。
 *
 * 事实源是后端 `backend-ts/src/approval-rule/approval-rule-normalize.ts` 的
 * `ApprovalRuleType` 与 `APPROVAL_RULE_TYPES`（含 `as const satisfies` 约束）。
 * 该类型同时出现在桌面审批卡片的 `ApprovalHint` 与管理后台的规则清单里，
 * 三端内联手写曾导致漏改无任何编译期提示。
 */

/**
 * 规则类型：
 * - SHELL_PREFIX：命令前缀（归一化后前两个 token + 词边界）
 * - SHELL_EXACT：完整命令（归一化全文全等）
 * - MCP_TOOL：MCP 工具全名（mcp__<server>__<tool>）
 */
export type ApprovalRuleType = 'SHELL_PREFIX' | 'SHELL_EXACT' | 'MCP_TOOL';

/** 规则作用域：SESSION 仅本会话 / USER 该用户全部会话。 */
export type ApprovalRuleScope = 'SESSION' | 'USER';

/**
 * 审批卡片「本会话总是允许」hint：由后端从当次工具参数归一化生成，随
 * tool_execute 帧下发到桌面审批卡片。用户点「总是允许」后客户端只回传布尔，
 * 后端按 requestId 取回服务端存储的同一 hint 落会话级规则——客户端永远拿不到
 * pattern 的决定权（不能注入 ruleValue）。
 */
export interface ApprovalHint {
  ruleType: ApprovalRuleType;
  /** 归一化后的模式值（匹配语义的真实载体，卡片副标题展示全文）。 */
  ruleValue: string;
  /** 卡片按钮 / 副标题文案（如「本会话总是允许以 npm run 开头的命令」）。 */
  label: string;
}
