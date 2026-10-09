/**
 * 站内收件箱契约（前后端共用，desktop 同步消费）。
 * kind 枚举封闭：表注释与 WS 关键帧之外不新增；未知 kind 一律忽略并 warn。
 */

/** 收件箱条目类型（封闭集合，对应 V131/V139 表注释）。 */
export type InboxKind =
  | 'TASK_COMPLETED'
  | 'TASK_FAILED'
  | 'QUESTION_PENDING'
  | 'APPROVAL_PENDING'
  | 'SUBAGENT_DONE'
  | 'TRIGGER_DISABLED'
  | 'BUDGET_WARN'
  | 'SCHEDULED_TASK_PAUSED'
  | 'TOKEN_DISABLED'
  | 'OPEN_API_CALL_FAILED';

/** 条目来源：用户手工触发 / 定时任务 / 入站 Webhook / 开放 API（前端来源徽标）。 */
export type InboxSource = 'MANUAL' | 'SCHEDULED' | 'WEBHOOK' | 'API';

export interface InboxItem {
  id: number;
  kind: InboxKind;
  title: string;
  content: string | null;
  isRead: boolean;
  readAt: string | null;
  sessionId: number | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface InboxListResult {
  records: InboxItem[];
  total: number;
  page: number;
  size: number;
}

export interface InboxPreference {
  taskCompletedEnabled: boolean;
  questionPendingEnabled: boolean;
  approvalPendingEnabled: boolean;
  subagentDoneEnabled: boolean;
  /** 预算提醒（BUDGET_WARN，V139；默认开——成本越线是运维级提醒）。 */
  budgetWarnEnabled: boolean;
  /** 开放接口单次失败聚合通知（OPEN_API_CALL_FAILED，V142；默认关）。 */
  openApiCallFailedEnabled: boolean;
  /** P2：Electron 系统通知总开关（仅桌面端窗口未聚焦时弹出；Web/安卓忽略此开关）。 */
  systemNotifyEnabled: boolean;
}
