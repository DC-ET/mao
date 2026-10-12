/**
 * 每日运营摘要域类型（技术方案 docs/plan/2026-10-12-daily-digest-technical-design.md §5.1）。
 * 六个板块全部来自既有表聚合；板块无数据时服务层置 null（空板块不渲染）。
 */

export interface DigestFailedTask {
  sessionId: number | null;
  title: string;
  /** 失败原因原文截断（约 80 字；不用 LLM 起草）。 */
  reason: string;
}

export interface DigestPausedTask {
  taskId: number | null;
  name: string;
}

export interface DigestDisabledWatcher {
  watcherId: number | null;
  name: string;
}

export interface DigestApprovalItem {
  sessionId: number | null;
  title: string;
}

export interface DigestCostAgent {
  agentId: number | null;
  name: string;
  micros: number;
}

export interface DigestTasks {
  completed: number;
  failed: number;
  /** 失败任务 Top3（标题 + 原因摘录 + 会话跳转）。 */
  failedTop: DigestFailedTask[];
}

export interface DigestScheduled {
  total: number;
  completed: number;
  failed: number;
  /** 窗口内被连续失败自动暂停的任务（notification SCHEDULED_TASK_PAUSED）。 */
  paused: DigestPausedTask[];
}

export interface DigestWatchers {
  /** 窗口内判定值变化（changed=1）的轮询次数。 */
  triggered: number;
  /** 窗口内被连续失败自动停用的哨兵（notification WATCHER_DISABLED）。 */
  disabled: DigestDisabledWatcher[];
}

export interface DigestApprovals {
  /** 当前仍未处理的审批待办数（不限昨天窗口——挂起是状态量不是事件量）。 */
  pending: number;
  items: DigestApprovalItem[];
}

export interface DigestCost {
  /** 窗口内已配价调用成本合计（cost_micros，×10⁶ 整数）。 */
  totalMicros: number;
  /** 窗口内未配价格（cost_micros IS NULL）的调用数，单列附注不进合计。 */
  unpricedCalls: number;
  /** 按 Agent 聚合的成本 Top3。 */
  top: DigestCostAgent[];
}

export interface DigestOpenApi {
  total: number;
  /** outcome='rejected' 的调用数（鉴权失败 / 限流拒绝等）。 */
  rejected: number;
}

export interface DigestData {
  /** 被汇总的自然日 yyyy-MM-dd（Asia/Shanghai 昨天）。 */
  coveredDate: string;
  tasks: DigestTasks | null;
  scheduled: DigestScheduled | null;
  watchers: DigestWatchers | null;
  approvals: DigestApprovals | null;
  cost: DigestCost | null;
  openApi: DigestOpenApi | null;
}

/** 设置页「上一份摘要」三态：未处理 / 已发送 / 无事件未发送。 */
export type YesterdayDigestStatus = 'PENDING' | 'SENT' | 'QUIET';

/** 偏好行（DB 直读；TINYINT 列以 number 返回，service 层转布尔）。 */
export interface DigestPreferenceRow {
  userId: number;
  enabled: number;
  pushTime: string;
  outboundEnabled: number;
  lastDigestDate: string | null;
}

export interface DigestPreference {
  enabled: boolean;
  /** HH:MM（Asia/Shanghai 口径比较，字符串字典序即时间序）。 */
  pushTime: string;
  /** 是否经出站订阅推送（仅有 digest.daily 订阅时实际生效）。 */
  outboundEnabled: boolean;
  /** 最近一次已处理的被汇总日期；NULL=从未处理。 */
  lastDigestDate: string | null;
}

export interface DigestPreferenceView extends DigestPreference {
  yesterdayStatus: YesterdayDigestStatus;
  /** 状态对应的被汇总日期（昨天）。 */
  yesterdayCoveredDate: string;
}

export interface DigestProcessResult {
  sent: boolean;
  /** DISABLED=总开关关闭（仅非强制路径）；QUIET=安静日无数据。 */
  reason?: 'DISABLED' | 'QUIET';
  /** 收件箱浓缩一行（sent=true 时返回，供试发 toast 展示）。 */
  line?: string;
  coveredDate: string;
}

/** 收件箱写入端口（由 InboxService 实现；dedup 键拼接逻辑留在 inbox 域内）。 */
export interface DigestInboxPort {
  writeDigestEntry(input: {
    userId: number;
    title: string;
    content: string | null;
    payload: Record<string, unknown>;
    /** dedup_key 尾段：被汇总日期（同日覆盖，试发不产生重复行）。 */
    dedupTail: string;
  }): Promise<void>;
  hasDigestEntry(userId: number, dedupTail: string): Promise<boolean>;
}

/** 出站订阅分发端口（由 OutboundSubscriptionService 实现；fire-and-forget，绝不抛）。 */
export interface DigestOutboundPort {
  dispatchDigest(input: {
    userId: number;
    coveredDate: string;
    digest: DigestData;
    text: string;
  }): void;
}

/** 偏好行默认值（决策 11：默认开；默认 09:30 推送）。 */
export const DEFAULT_DIGEST_PREFERENCE: DigestPreference = {
  enabled: true,
  pushTime: '09:30',
  outboundEnabled: true,
  lastDigestDate: null,
};

/** push_time 合法格式 HH:MM（00:00~23:59）。 */
export function isValidPushTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
