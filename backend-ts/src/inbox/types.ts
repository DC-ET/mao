import type { InboxKind } from '@mao/contracts';

/**
 * 收件箱 kind 封闭集合（对应 V131 表注释）。
 * 运行时枚举放在后端域：`@mao/contracts` 按约定只导纯类型，
 * 后端通过 types.ts 本地持有运行时常量与守卫。
 */
export const INBOX_KINDS: readonly InboxKind[] = [
  'TASK_COMPLETED',
  'TASK_FAILED',
  'QUESTION_PENDING',
  'APPROVAL_PENDING',
  'SUBAGENT_DONE',
  'TRIGGER_DISABLED',
  'BUDGET_WARN',
  'SCHEDULED_TASK_PAUSED',
  'TOKEN_DISABLED',
  'OPEN_API_CALL_FAILED',
  'WEIXIN_REPLY_WINDOW_CLOSED',
];

/** 未知 kind 一律拒绝（不写库、不广播）。 */
export function isInboxKind(value: unknown): value is InboxKind {
  return typeof value === 'string' && (INBOX_KINDS as readonly string[]).includes(value);
}

export type { InboxKind };
