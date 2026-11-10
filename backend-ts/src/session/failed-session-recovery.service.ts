import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { harnessLog } from '../harness/log.js';
import { userMessagePreviewOf } from '../notification/task/user-message-preview.js';
import type { FailedSessionCandidateRow } from './session.repository.js';
import { parseFailureReason } from './session-vo.js';
import type { Session } from './types.js';

/**
 * 跳过原因。服务层产出前四项；RECOVERING / EXECUTOR_BUSY / SUBMIT_FAILED
 * 由恢复内核（CrashRecoveryRunner.recoverFailedSessions）回填。
 * 失败原因不再作为跳过条件：402/403、权限、工具错误、超时等一律进入清单，由管理员勾选。
 */
export type FailedRecoverySkipReason =
  | 'NOT_FAILED'
  | 'LOCAL_MODE'
  | 'NON_NORMAL_SESSION'
  | 'PENDING_TASK_RETRY'
  | 'ALREADY_RUNNING'
  | 'RECOVERING'
  | 'EXECUTOR_BUSY'
  | 'SUBMIT_FAILED';

/** 预览项（§4.5.1 / §6.2）。 */
export interface FailedSessionRecoveryItem {
  sessionId: number;
  userId: number | null;
  userName: string | null;
  agentName: string | null;
  title: string | null;
  executionMode: string | null;
  phase: string;
  lastActivityAt: string | null;
  failedAt: string | null;
  httpStatus: number | null;
  errorCode: string | null;
  errorSummary: string;
  lastUserMessage: string;
  /** 该会话被定时任务引用时给出首个引用（恢复不回写 run 状态，仅提示操作者自行判断，§4.3）。 */
  scheduledTask: { id: number; name: string } | null;
  /** 是否有可原地续更的渠道进度卡（仅按飞书映射判定；钉钉卡片无轻量存在性查询）。 */
  hasProgressCard: boolean;
  willRecover: boolean;
  skipReason: FailedRecoverySkipReason | null;
}

export interface FailedSessionRecoveryPreview {
  windowHours: number;
  total: number;
  recoverableCount: number;
  /** 窗口内失败会话超过预览上限时为 true，清单只含最近活跃的一批。 */
  truncated: boolean;
  items: FailedSessionRecoveryItem[];
}

export interface FailedSessionRecoveryRunResult {
  accepted: number[];
  skipped: Array<{ sessionId: number; reason: FailedRecoverySkipReason }>;
}

/** 恢复内核窄接口：FailedSessionRecoveryService 只依赖这一小块，便于单测替换。 */
export interface FailedRecoveryKernel {
  recoverFailedSessions(
    sessionIds: number[],
    opts?: {
      onSessionFinished?: (
        sessionId: number,
        outcome: { phase: 'COMPLETED' | 'FAILED' | 'CANCELLED'; hadProgressCard: boolean },
      ) => Promise<void>;
    },
  ): Promise<{
    accepted: number[];
    skipped: Array<{ id: number; reason: string }>;
  }>;
}

/** 单批恢复上限（§4.7）：避免一次占满执行池，超限直接拒绝并提示分批。 */
export const FAILED_RECOVERY_MAX_BATCH = 20;
/** 预览清单上限：7 天窗内失败会话可能上百，超出部分提示管理员缩小窗口或分批处理。 */
const PREVIEW_LIMIT = 200;
const SUMMARY_MAX_CHARS = 200;
const FALLBACK_ERROR_SUMMARY = '执行失败';
const HTTP_STATUS_PATTERN = /LLM API returned (\d{3})/;
const ERROR_CODE_PATTERN = /"code"\s*:\s*"([^"]+)"/;

function toSqlDateTime(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function truncate(text: string | null | undefined, maxChars: number): string {
  const raw = (text ?? '').trim();
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars)}…`;
}

function toIdSet(values: Array<number | string | null | undefined>): number[] {
  const out = new Set<number>();
  for (const value of values) {
    const id = Number(value);
    if (Number.isSafeInteger(id) && id > 0) out.add(id);
  }
  return [...out];
}

/** 预览 / 执行共用的候选仓库窄接口（session.repository 的子集 + 会话单查）。 */
export interface FailedRecoveryStore {
  listFailedSessionsForRecovery(
    opts: { windowStart?: string | null; ids?: number[]; limit?: number },
  ): Promise<FailedSessionCandidateRow[]>;
  listSessionIdsWithPendingTaskRetry(sessionIds: number[]): Promise<Set<number>>;
  listScheduledTaskRefsBySessionIds(
    sessionIds: number[],
  ): Promise<Map<number, Array<{ id: number; name: string }>>>;
  findById(id: number): Promise<Session | null>;
}

export interface FailedSessionRecoveryDeps {
  store: FailedRecoveryStore;
  userLookup: {
    findByIds(ids: number[]): Promise<Array<{ id?: number | string | null; username?: string | null; displayName?: string | null }>>;
  };
  agentLookup: {
    findByIds(ids: number[]): Promise<Array<{ id?: number | string | null; name?: string | null }>>;
  };
  messageLookup: { getLastUserMessage(sessionId: number): Promise<{ content?: unknown } | null> };
  progressCardLookup: {
    findBySessionIds?(sessionIds: number[]): Promise<Map<number, unknown>>;
    findBySessionId?(sessionId: number): Promise<unknown | null>;
  };
  /** 实例内是否有执行占位（WS 执行 claim / IM 通道执行中），同步判定（§4.7 L4）。 */
  isSessionClaimed: (sessionId: number) => boolean;
  /** 无卡片映射会话完成后的降级推送（P1，§4.8）：实现内部自行判断渠道，非飞书会话空转。 */
  pushFinalReply?: (sessionId: number) => Promise<void>;
  /** 测试注入时钟；缺省取系统当前时刻。 */
  now?: () => Date;
}

/**
 * 失败会话批量恢复：时间窗内全部 FAILED 主会话进清单，管理员勾选后发起续跑。
 *
 * 职责：候选查询编排 + 排除判定 + 预览装配 + 委托恢复内核执行 + 结果汇总与日志。
 * 续跑流程本身完全复用 CrashRecoveryRunner（清理尾部 → RESUMING → RUNNING → execute
 * → finishExecution → onExecutionFinished），本服务不重写任何续跑逻辑。
 * 不按错误类型过滤：402/403、其它 HTTP 状态、工具错误、超时都列出，能否勾选只看
 * 执行模式、会话类型、定时任务重试链和是否已在跑。
 */
export class FailedSessionRecoveryService {
  private kernel: FailedRecoveryKernel | null = null;

  constructor(private readonly deps: FailedSessionRecoveryDeps) {}

  /** 装配期注入恢复内核（app-lifecycle 在构造 CrashRecoveryRunner 后调用）。 */
  attachKernel(kernel: FailedRecoveryKernel): void {
    this.kernel = kernel;
  }

  /** 候选扫描 + 逐条排除判定（只读）。不按错误类型过滤。 */
  async preview(windowHours: number): Promise<FailedSessionRecoveryPreview> {
    const hours = this.normalizeWindowHours(windowHours);
    const windowStart = toSqlDateTime(new Date((this.deps.now?.() ?? new Date()).getTime() - hours * 3_600_000));
    const rows = await this.deps.store.listFailedSessionsForRecovery({ windowStart, limit: PREVIEW_LIMIT });
    const items = await this.buildItems(rows);
    return {
      windowHours: hours,
      total: items.length,
      recoverableCount: items.filter((item) => item.willRecover).length,
      truncated: rows.length >= PREVIEW_LIMIT,
      items,
    };
  }

  /**
   * 发起恢复：对每个 id 重新校验（预览到执行之间状态可能变化），
   * 通过后交内核逐个异步提交，立即返回受理结果——不等执行完成。
   */
  async run(sessionIds: number[]): Promise<FailedSessionRecoveryRunResult> {
    const ids = toIdSet(sessionIds);
    if (ids.length === 0) return { accepted: [], skipped: [] };
    if (ids.length > FAILED_RECOVERY_MAX_BATCH) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        `单批最多恢复 ${FAILED_RECOVERY_MAX_BATCH} 个会话，请分批恢复`,
      );
    }
    const rows = await this.deps.store.listFailedSessionsForRecovery({ ids });
    const rowById = new Map(rows.map((row) => [row.sessionId, row]));
    const pendingRetry = await this.deps.store.listSessionIdsWithPendingTaskRetry(rows.map((row) => row.sessionId));

    const accepted: number[] = [];
    const skipped: FailedSessionRecoveryRunResult['skipped'] = [];
    const eligible: number[] = [];
    for (const id of ids) {
      const row = rowById.get(id);
      if (row == null) {
        // 候选行缺失：会话不存在、已不是 FAILED，或不是可恢复的主会话（已归档 / 子代理 / 边路）。
        skipped.push({ sessionId: id, reason: await this.resolveMissingRowReason(id) });
        continue;
      }
      if (this.deps.isSessionClaimed(id)) {
        skipped.push({ sessionId: id, reason: 'ALREADY_RUNNING' });
        continue;
      }
      const reason = this.skipReasonFor(row, pendingRetry);
      if (reason != null) {
        skipped.push({ sessionId: id, reason });
        continue;
      }
      eligible.push(id);
    }

    if (eligible.length > 0) {
      if (this.kernel == null) {
        // 内核未注入（装配缺失）属于部署错误，直接失败而不是静默吞掉操作。
        throw new BusinessException(ErrorCode.INTERNAL_ERROR, '恢复内核未就绪，请联系管理员');
      }
      const kernelResult = await this.kernel.recoverFailedSessions(eligible, {
        onSessionFinished: async (sessionId, outcome) => {
          await this.onRecoveredSessionFinished(sessionId, outcome);
        },
      });
      accepted.push(...kernelResult.accepted);
      for (const item of kernelResult.skipped) {
        skipped.push({ sessionId: item.id, reason: item.reason as FailedRecoverySkipReason });
      }
    }

    harnessLog(
      'info',
      `[failed-session-recovery] batch submitted: accepted=${accepted.length} skipped=${skipped.length} `
        + `detail=${JSON.stringify(skipped)}`,
    );
    return { accepted, skipped };
  }

  /** 预览到执行之间状态可能变化：候选行消失时给出更细的跳过原因。 */
  private async resolveMissingRowReason(
    id: number,
  ): Promise<Extract<FailedRecoverySkipReason, 'NOT_FAILED' | 'NON_NORMAL_SESSION'>> {
    let session: Session | null = null;
    try {
      session = await this.deps.store.findById(id);
    } catch { /* 查询失败按不存在处理 */ }
    if (session == null || (session.phase ?? '') !== 'FAILED') return 'NOT_FAILED';
    if ((session.sessionType ?? 'NORMAL') !== 'NORMAL') return 'NON_NORMAL_SESSION';
    return 'NOT_FAILED';
  }

  /** 排除判定：返回 null 表示可恢复。不看错误类型。预览与执行复用同一判定。 */
  private skipReasonFor(
    row: FailedSessionCandidateRow,
    pendingRetry: Set<number>,
  ): FailedRecoverySkipReason | null {
    if ((row.executionMode ?? 'CLOUD') === 'LOCAL') return 'LOCAL_MODE';
    if ((row.sessionType ?? 'NORMAL') !== 'NORMAL') return 'NON_NORMAL_SESSION';
    if (pendingRetry.has(row.sessionId)) return 'PENDING_TASK_RETRY';
    return null;
  }

  private async buildItems(rows: FailedSessionCandidateRow[]): Promise<FailedSessionRecoveryItem[]> {
    const userIds = toIdSet(rows.map((row) => row.userId));
    const agentIds = toIdSet(rows.map((row) => row.agentId));
    const [users, agents, pendingRetry, taskRefs, cardMap] = await Promise.all([
      userIds.length > 0 ? this.deps.userLookup.findByIds(userIds) : Promise.resolve([]),
      agentIds.length > 0 ? this.deps.agentLookup.findByIds(agentIds) : Promise.resolve([]),
      this.deps.store.listSessionIdsWithPendingTaskRetry(rows.map((row) => row.sessionId)),
      this.deps.store.listScheduledTaskRefsBySessionIds(rows.map((row) => row.sessionId)),
      this.lookupProgressCards(rows.map((row) => row.sessionId)),
    ]);
    const userNameById = new Map(users.map((u) => [Number(u.id), u.displayName || u.username || null]));
    const agentNameById = new Map(agents.map((a) => [Number(a.id), a.name ?? null]));

    const items = await Promise.all(rows.map(async (row) => {
      const failure = describeFailure(row);
      const baseReason = this.skipReasonFor(row, pendingRetry);
      const claimed = baseReason == null && this.deps.isSessionClaimed(row.sessionId);
      const skipReason = baseReason ?? (claimed ? 'ALREADY_RUNNING' : null);
      let lastUserMessage = '';
      try {
        const message = await this.deps.messageLookup.getLastUserMessage(row.sessionId);
        lastUserMessage = truncate(userMessagePreviewOf(message?.content ?? null), SUMMARY_MAX_CHARS);
      } catch { /* 预览展示字段，失败留空不阻断 */ }
      return {
        sessionId: row.sessionId,
        userId: row.userId,
        userName: row.userId != null ? userNameById.get(row.userId) ?? null : null,
        agentName: row.agentId != null ? agentNameById.get(row.agentId) ?? null : null,
        title: row.title,
        executionMode: row.executionMode,
        phase: 'FAILED',
        lastActivityAt: row.lastActivityAt,
        failedAt: failure.failedAt,
        httpStatus: parseHttpStatus(failure.errorMessage),
        errorCode: parseErrorCode(failure.errorMessage),
        errorSummary: truncate(failure.errorMessage, SUMMARY_MAX_CHARS),
        lastUserMessage,
        scheduledTask: taskRefs.get(row.sessionId)?.[0] ?? null,
        hasProgressCard: cardMap.get(row.sessionId) != null,
        willRecover: skipReason == null,
        skipReason,
      } satisfies FailedSessionRecoveryItem;
    }));
    return items;
  }

  private async lookupProgressCards(sessionIds: number[]): Promise<Map<number, unknown>> {
    if (sessionIds.length === 0) return new Map();
    const batch = this.deps.progressCardLookup.findBySessionIds;
    if (batch != null) {
      try {
        return await batch(sessionIds);
      } catch { /* 展示字段，失败按无卡处理 */ }
      return new Map();
    }
    const single = this.deps.progressCardLookup.findBySessionId;
    const map = new Map<number, unknown>();
    if (single == null) return map;
    await Promise.all(sessionIds.map(async (id) => {
      try {
        const row = await single(id);
        if (row != null) map.set(id, row);
      } catch { /* 展示字段，失败按无卡处理 */ }
    }));
    return map;
  }

  /**
   * 恢复终态回调：完成且无卡片映射的会话降级推送最终回复（§4.8）。
   * 推送失败仅记日志，不影响恢复结果与 phase。
   */
  private async onRecoveredSessionFinished(
    sessionId: number,
    outcome: { phase: 'COMPLETED' | 'FAILED' | 'CANCELLED'; hadProgressCard: boolean },
  ): Promise<void> {
    if (outcome.phase !== 'COMPLETED' || outcome.hadProgressCard) return;
    const push = this.deps.pushFinalReply;
    if (push == null) return;
    try {
      await push(sessionId);
      harnessLog('info', `[failed-session-recovery] Session ${sessionId}: fallback final reply pushed`);
    } catch (e) {
      harnessLog('warn', `[failed-session-recovery] Session ${sessionId}: fallback push failed`, e);
    }
  }

  private normalizeWindowHours(windowHours: number): number {
    if (!Number.isSafeInteger(windowHours)) return 24;
    return Math.max(1, Math.min(windowHours, 168));
  }
}

function llmCallFailed(success: number | boolean | null | undefined): boolean {
  return success === 0 || success === false;
}

/**
 * 错误摘要优先用终态 executionError（与会话列表失败原因同源），
 * 没有则回落到最后一次失败的 agent 场景 LLM 调用。两者都没有时给占位文案，避免清单空白。
 * 失败时间：最后一次 agent 调用本身失败时用该调用时间，否则用会话最后活跃时间。
 */
function describeFailure(row: FailedSessionCandidateRow): { errorMessage: string; failedAt: string | null } {
  const runtime = parseFailureReason(row.runtimeStatusJson, 'FAILED')?.trim() ?? '';
  const llmFailed = llmCallFailed(row.llmSuccess);
  const llmMessage = (row.llmErrorMessage ?? '').trim();
  const errorMessage = runtime || (llmFailed ? llmMessage : '') || FALLBACK_ERROR_SUMMARY;
  const failedAt = llmFailed && row.llmCalledAt ? row.llmCalledAt : (row.lastActivityAt ?? null);
  return { errorMessage, failedAt };
}

function parseHttpStatus(message: string | null): number | null {
  const match = message?.match(HTTP_STATUS_PATTERN);
  if (match == null) return null;
  const status = Number(match[1]);
  return status >= 100 && status <= 599 ? status : null;
}

function parseErrorCode(message: string | null): string | null {
  const match = message?.match(ERROR_CODE_PATTERN);
  return match == null ? null : match[1];
}
