import type { InboxItem, InboxKind, InboxPreference, InboxListResult, InboxSource } from '@mao/contracts';
import { isInboxKind } from './types.js';
import type { InboxRepository, NotificationRow } from './inbox.repository.js';
import { toInboxItem } from './inbox.repository.js';

/** WS 广播窄接口（对齐 streaming-ws-registry 的 send）。 */
export interface InboxEventRegistry {
  send(userId: number, event: { type: string; sessionId: number | null; data: unknown }): void;
}

/** 会话信息查询（标题 / 归属用户），查询失败由调用方降级，不阻断写入。 */
export interface InboxSessionLookup {
  userIdOf(sessionId: number): Promise<number | null>;
  titleOf(sessionId: number): Promise<string | null>;
}

/** LOCAL 路径的 userId 兜底解析（复用 LocalToolSessionRegistry 三级回退）。 */
export type InboxUserIdResolver = (sessionId: number) => Promise<number | null>;

/** question.pending 出站订阅分发回调（openapi 域经 create-app 注入；失败由回调实现侧吞掉）。 */
export type QuestionPendingDispatcher = (input: QuestionPendingInboxInput) => void;

export interface TaskTerminalInboxInput {
  userId: number;
  sessionId: number;
  title: string | null;
  /** 只接受 COMPLETED / FAILED；CANCELLED 不写收件箱。 */
  phase: string;
  executionId: string | null;
  failureReason?: string | null;
  source?: InboxSource;
}

export interface QuestionPendingInboxInput {
  userId: number;
  sessionId: number;
  requestId: string;
}

export interface SubagentDoneInboxInput {
  /** 父会话（跳转目标）。userId 未知时内部按 childSessionId 兜底解析。 */
  parentSessionId: number;
  childSessionId: number;
  executionId: number;
  status: string;
  result: string | null;
  agentType: string | null;
  taskDescription: string | null;
}

/** 收件箱事件：只带权威未读数，条目内容由渲染端拉列表后 diff 得出。 */
export const INBOX_UPDATED_EVENT = 'inbox_updated';

/** 偏好列默认值口径：前三类开、子代理关（防并行子代理刷屏）。 */
const DEFAULT_PREFERENCE: InboxPreference = {
  taskCompletedEnabled: true,
  questionPendingEnabled: true,
  approvalPendingEnabled: true,
  subagentDoneEnabled: false,
  systemNotifyEnabled: true,
};

const TITLE_MAX = 200;
const CONTENT_MAX = 500;

/**
 * 站内收件箱统一入口。
 *
 * 职责边界：
 * - 幂等：`inboxDedupKey` 单一导出，写入侧与置已读侧共用同一实现（防两侧漂移）。
 * - 权威未读数：每次写路径后重算 COUNT 并经 WS 广播；前端禁止本地累加。
 * - 偏好门控：kind 关闭则不写入（与 IM/webhook 渠道开关独立，互不门控）。
 */
export class InboxService {
  constructor(
    private readonly repo: InboxRepository,
    private readonly registry: InboxEventRegistry,
    private readonly sessionLookup: InboxSessionLookup,
    private readonly userIdResolver?: InboxUserIdResolver,
    /** 出站订阅 question.pending 分发（在偏好门控之前触发：订阅独立于站内偏好开关）。 */
    private readonly questionPendingDispatcher?: QuestionPendingDispatcher | null,
  ) {}

  /**
   * 幂等键（唯一导出）：`"{userId}:{kind}:{sessionId}:{tail}"`。
   * tail 取 executionId（TASK_* / SUBAGENT_DONE）或 requestId（QUESTION / APPROVAL）。
   * 两侧（写入与联动置已读）必须共用本函数，禁止各自拼接字符串。
   */
  inboxDedupKey(userId: number, kind: InboxKind, sessionId: number | null, tail: string): string {
    return `${userId}:${kind}:${sessionId}:${tail}`;
  }

  /** TASK_COMPLETED / TASK_FAILED：主会话相位收敛时记录（SUBAGENT/SIDE_TASK/微信/飞书/CANCELLED 由调用方跳过）。 */
  async recordTaskTerminal(input: TaskTerminalInboxInput): Promise<void> {
    const isCompleted = input.phase === 'COMPLETED';
    if (!isCompleted && input.phase !== 'FAILED') return;
    if (input.userId == null) return;
    const kind: InboxKind = isCompleted ? 'TASK_COMPLETED' : 'TASK_FAILED';
    const title = clip(input.title, TITLE_MAX) || '未命名任务';
    const payload: Record<string, unknown> = { source: input.source ?? 'MANUAL', phase: input.phase };
    if (!isCompleted && input.failureReason != null) {
      payload.reason = clip(input.failureReason, TITLE_MAX);
    }
    await this.record({
      userId: input.userId,
      kind,
      title: isCompleted ? `任务已完成：${title}` : `任务执行失败：${title}`,
      content: isCompleted ? null : clip(input.failureReason, CONTENT_MAX),
      sessionId: input.sessionId,
      payload,
      tail: input.executionId != null && input.executionId !== '' ? input.executionId : String(input.sessionId),
    });
  }

  /** QUESTION_PENDING：ask_user_questions 派发点写入（不区分用户在线与否）。 */
  async recordQuestionPending(input: QuestionPendingInboxInput): Promise<void> {
    // 出站订阅分发独立于站内偏好门控（技术方案 §5.5）：订阅是机器回调，与站内未读开关无关
    if (this.questionPendingDispatcher != null) {
      try {
        this.questionPendingDispatcher(input);
      } catch (e) {
        console.warn(`[inbox] question pending outbound dispatch failed: ${(e as Error).message}`);
      }
    }
    await this.record({
      userId: input.userId,
      kind: 'QUESTION_PENDING',
      title: '有待回答的提问',
      content: 'Agent 正在等待你的回答，回答后才能继续执行',
      sessionId: input.sessionId,
      payload: { requestId: input.requestId },
      tail: input.requestId,
    });
  }

  /**
   * TRIGGER_DISABLED：入站 Webhook 触发器连续失败自动停用通知（openapi 域）。
   * 无偏好开关（始终通知——停用是运维级事件，必须让属主知道）；
   * tail 带时间戳保证每次停用事件都可重复通知（dedup_key 唯一性）。
   */
  async recordTriggerDisabled(input: {
    userId: number;
    triggerId: number;
    triggerName: string;
    sessionId: number | null;
    failures: number;
  }): Promise<void> {
    await this.record({
      userId: input.userId,
      kind: 'TRIGGER_DISABLED',
      title: `Webhook 触发器已自动停用：${input.triggerName}`,
      content: `连续失败 ${input.failures} 次，已自动停用；请检查外部系统签名/目标系统状态后重新启用`,
      sessionId: input.sessionId,
      payload: { triggerId: input.triggerId, triggerName: input.triggerName, failures: input.failures },
      tail: `${input.triggerId}:${Date.now()}`,
    });
  }

  /**
   * APPROVAL_PENDING：LOCAL 审批注册点写入。
   * LocalToolExecutor 无 userId 上下文，这里按 sessionId 兜底解析（内部查询失败则跳过）。
   */
  async recordApprovalPending(sessionId: number, requestId: string): Promise<void> {
    const userId = await this.sessionLookup.userIdOf(sessionId);
    if (userId == null) {
      console.warn(`[inbox] skip approval notification, owner not resolved: session=${sessionId}`);
      return;
    }
    await this.record({
      userId,
      kind: 'APPROVAL_PENDING',
      title: '有待处理的审批',
      content: '有一条本地工具调用等待你审批',
      sessionId,
      payload: { requestId },
      tail: requestId,
    });
  }

  /**
   * SUBAGENT_DONE：覆盖子代理 COMPLETED / FAILED / CANCELLED 三种终态，
   * 标题/摘要按 status 分流，避免失败被表述成完成。
   */
  async recordSubagentDone(input: SubagentDoneInboxInput): Promise<void> {
    const userId = await this.sessionLookup.userIdOf(input.parentSessionId)
      ?? (this.userIdResolver != null ? await this.userIdResolver(input.childSessionId) : null);
    if (userId == null) {
      console.warn(`[inbox] skip subagent notification, owner not resolved: parent=${input.parentSessionId}, child=${input.childSessionId}`);
      return;
    }
    const status = input.status;
    const isCompleted = status === 'COMPLETED';
    const isFailed = status === 'FAILED';
    if (!isCompleted && !isFailed && status !== 'CANCELLED') return;
    const childTitle = await this.sessionLookup.titleOf(input.childSessionId);
    const subject = clip(childTitle ?? input.taskDescription, TITLE_MAX) || '子代理任务';
    const label = isCompleted ? '已完成' : isFailed ? '执行失败' : '已取消';
    const body = clip(input.result, CONTENT_MAX);
    await this.record({
      userId,
      kind: 'SUBAGENT_DONE',
      title: `子代理${label}：${subject}`,
      content: body,
      sessionId: input.parentSessionId,
      payload: {
        status,
        childSessionId: input.childSessionId,
        executionId: input.executionId,
        agentType: input.agentType ?? null,
      },
      tail: String(input.executionId),
    });
  }

  /**
   * 待办联动置已读：提问被回答/取消/超时、审批被批准/拒绝/超时/断连后，
   * 对应条目自动置为已读（保留可查，不计未读徽标）。
   * 直接拼完整 dedup_key 等值匹配；幂等（第二次影响 0 行）。
   */
  async resolvePending(userId: number, kind: InboxKind, sessionId: number, tail: string): Promise<void> {
    if (!isInboxKind(kind) || userId == null) return;
    await this.repo.markReadByDedupKey(userId, this.inboxDedupKey(userId, kind, sessionId, tail));
    await this.broadcastUnreadCount(userId);
  }

  /**
   * 审批联动置已读（批准 / 拒绝 / 超时 / 异常 / 断连统一收敛）。
   * LocalToolExecutor 无 userId 上下文，按 sessionId 兜底解析后拼完整 dedup_key 等值匹配。
   */
  async resolveApprovalPending(sessionId: number, requestId: string): Promise<void> {
    const userId = await this.sessionLookup.userIdOf(sessionId);
    if (userId == null) return;
    await this.resolvePending(userId, 'APPROVAL_PENDING', sessionId, requestId);
  }

  async markRead(userId: number, id: number): Promise<boolean> {
    const updated = await this.repo.markRead(id, userId);
    await this.broadcastUnreadCount(userId);
    return updated;
  }

  async markAllRead(userId: number): Promise<void> {
    await this.repo.markAllRead(userId);
    await this.broadcastUnreadCount(userId);
  }

  async remove(userId: number, id: number): Promise<boolean> {
    const deleted = await this.repo.deleteById(id, userId);
    await this.broadcastUnreadCount(userId);
    return deleted;
  }

  async list(userId: number, page: number, size: number, unreadOnly?: boolean): Promise<InboxListResult> {
    const { rows, total } = await this.repo.list({ userId, page, size, unreadOnly });
    return {
      records: rows.map((row) => this.toItem(row)),
      total,
      page,
      size,
    };
  }

  async unreadCount(userId: number): Promise<number> {
    return this.repo.countUnread(userId);
  }

  async getPreferences(userId: number): Promise<InboxPreference> {
    const row = await this.repo.findPreference(userId);
    if (row == null) return { ...DEFAULT_PREFERENCE };
    return {
      taskCompletedEnabled: Number(row.taskCompletedEnabled) === 1,
      questionPendingEnabled: Number(row.questionPendingEnabled) === 1,
      approvalPendingEnabled: Number(row.approvalPendingEnabled) === 1,
      subagentDoneEnabled: Number(row.subagentDoneEnabled) === 1,
      systemNotifyEnabled: Number(row.systemNotifyEnabled ?? 1) === 1,
    };
  }

  async savePreferences(userId: number, flags: InboxPreference): Promise<InboxPreference> {
    await this.repo.savePreference(userId, flags);
    return flags;
  }

  /** 统一写入：未知 kind 忽略并 warn、偏好门控、幂等落库、广播权威未读数。 */
  private async record(input: {
    userId: number;
    kind: InboxKind;
    title: string;
    content: string | null;
    /** TRIGGER_DISABLED 等非会话绑定条目允许为空（V131 session_id NULL 可空）。 */
    sessionId: number | null;
    payload: Record<string, unknown>;
    tail: string;
  }): Promise<void> {
    if (input.userId == null) return;
    if (!isInboxKind(input.kind)) {
      console.warn(`[inbox] ignoring unknown inbox kind: ${String(input.kind)}`);
      return;
    }
    if (!(await this.isKindEnabled(input.userId, input.kind))) {
      return;
    }
    await this.repo.insertIgnore({
      userId: input.userId,
      kind: input.kind,
      title: clip(input.title, TITLE_MAX) ?? '',
      content: input.content == null ? null : clip(input.content, CONTENT_MAX),
      sessionId: input.sessionId,
      payloadJson: JSON.stringify(input.payload),
      dedupKey: this.inboxDedupKey(input.userId, input.kind, input.sessionId, input.tail),
    });
    await this.broadcastUnreadCount(input.userId);
  }

  private async isKindEnabled(userId: number, kind: InboxKind): Promise<boolean> {
    const preference = await this.getPreferences(userId);
    switch (kind) {
      case 'TASK_COMPLETED':
        return preference.taskCompletedEnabled;
      case 'TASK_FAILED':
        return preference.taskCompletedEnabled;
      case 'QUESTION_PENDING':
        return preference.questionPendingEnabled;
      case 'APPROVAL_PENDING':
        return preference.approvalPendingEnabled;
      case 'SUBAGENT_DONE':
        return preference.subagentDoneEnabled;
      case 'TRIGGER_DISABLED':
        // 无偏好开关：触发器自动停用是运维级事件，始终通知属主
        return true;
      default:
        return false;
    }
  }

  private async broadcastUnreadCount(userId: number): Promise<void> {
    try {
      const unreadCount = await this.repo.countUnread(userId);
      this.registry.send(userId, { type: INBOX_UPDATED_EVENT, sessionId: null, data: { unreadCount } });
    } catch (e) {
      console.warn(`[inbox] failed to broadcast unread count for user ${userId}: ${(e as Error).message}`);
    }
  }

  private toItem(row: NotificationRow): InboxItem {
    return toInboxItem(row);
  }
}

function clip(value: string | null | undefined, maxLength: number): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength);
}
