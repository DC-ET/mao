import { Cron } from 'croner';
import { randomUUID } from 'node:crypto';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { formatDateTime } from '../common/json.js';
import { mpPage, type MpPage } from '../common/json.js';
import type { Message, Session } from '../domain/types.js';
import { WEIXIN_PROJECT_KEY } from '../domain/types.js';
import { isActivePhase } from '../session/session-vo.js';
import type { TaskNotifySource } from '../session/task-terminal.service.js';
import { collectMissedPoints } from './scheduled-task-missed.js';

export interface ScheduledTask {
  id?: number;
  userId?: number;
  agentId?: number;
  sessionId?: number;
  name?: string;
  prompt?: string;
  cronExpression?: string;
  status?: string;
  /** 一次性任务：true=执行一次后自动完结；null 时按 cron 形态自动判定。 */
  once?: number | null;
  lastFireTime?: string | null;
  lastExecutionStatus?: string | null;
  nextFireTime?: string | null;
  fireCount?: number;
  finished?: number;
  finishedAt?: string | null;
  /** 连续失败次数。COMPLETED 清零，最终 FAILED +1，达阈值自动暂停。 */
  consecutiveFailures?: number;
  /** 失败后最多再试几次（不含首次）。0 表示不重试。 */
  retryMax?: number;
  /** 固定重试间隔（分钟）。 */
  retryIntervalMinutes?: number;
  /** RUN_ONCE 补最近一次；SKIP 只记错过。 */
  missedPolicy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  deleted?: number;
}

/** 一行对应一个计划触发点。重试覆盖同一行，不另起一行。 */
export interface ScheduledTaskRun {
  id?: number;
  taskId: number;
  fireTime: string;
  attempt: number;
  status: string;
  sessionId: number;
  messageId?: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  costMicros?: number | null;
  errorSummary?: string | null;
  nextRetryAt?: string | null;
  /** 进入 QUEUED 的单调序号。结算按它找最早入队的行。 */
  queueSeq?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface TaskFailureOutcome {
  consecutiveFailures: number;
  paused: boolean;
}

export interface ScheduledTaskListFilter {
  keyword?: string | null;
  userId?: number | null;
  agentId?: number | null;
  status?: string | null;
  /** true=仅已完结，false=仅进行中；null/undefined=不过滤 */
  finished?: boolean | null;
}

export interface ScheduledTaskStore {
  insert(task: ScheduledTask): Promise<number>;
  /** 支持增量 patch：仅更新传入字段，避免调用方用旧快照整行回写覆盖并发修改。 */
  updateById(task: Partial<ScheduledTask> & { id: number }): Promise<void>;
  deleteById(id: number): Promise<void>;
  selectById(id: number): Promise<ScheduledTask | null>;
  listByUser(userId: number): Promise<ScheduledTask[]>;
  listAll(pageNum: number, pageSize: number, filter?: ScheduledTaskListFilter): Promise<{ records: ScheduledTask[]; total: number }>;
  listDue(now: string): Promise<ScheduledTask[]>;
  /** 以下运行记录方法由 DbStore 实现。单测里的窄 fake 可以不提供，服务会跳过运行记录。 */
  selectRunById?(id: number): Promise<ScheduledTaskRun | null>;
  selectRunByFire?(taskId: number, fireTime: string): Promise<ScheduledTaskRun | null>;
  insertRun?(run: ScheduledTaskRun): Promise<number>;
  updateRun?(run: Partial<ScheduledTaskRun> & { id: number }): Promise<void>;
  deleteUnstartedRun?(taskId: number, fireTime: string): Promise<void>;
  beginRetry?(runId: number): Promise<ScheduledTaskRun | null>;
  clearRunRetry?(runId: number): Promise<void>;
  clearPendingRetries?(taskId: number): Promise<void>;
  oldestQueuedRun?(taskId: number): Promise<ScheduledTaskRun | null>;
  hasPendingRetry?(taskId: number): Promise<boolean>;
  listRuns?(taskId: number, limit: number): Promise<ScheduledTaskRun[]>;
  listDueRetries?(now: string): Promise<ScheduledTaskRun[]>;
  listMissedTasks?(before: string): Promise<ScheduledTask[]>;
  insertMissedIgnore?(run: Pick<ScheduledTaskRun, 'taskId' | 'fireTime' | 'sessionId'>): Promise<void>;
  casNextFire?(id: number, expectedNextFireTime: string, nextFireTime: string | null, finish?: { finishedAt: string }): Promise<boolean>;
  listOpenRuns?(): Promise<ScheduledTaskRun[]>;
  listOpenRunsBySession?(sessionId: number): Promise<ScheduledTaskRun[]>;
  listStaleRuns?(runningBefore: string, queuedBefore: string): Promise<ScheduledTaskRun[]>;
  deleteRunsBefore?(cutoff: string): Promise<void>;
  recordTaskOutcome?(taskId: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED', pauseAfter: number, now: string): Promise<TaskFailureOutcome | null>;
}

export interface ScheduleSessionService {
  getSession(id: number): Promise<Session | null>;
  updatePhase(sessionId: number, phase: string): Promise<void>;
  saveMessage(sessionId: number, role: string, content: unknown, a: null, b: null, c: null, d: number, e: null): Promise<Message>;
  getMessages(sessionId: number): Promise<Message[]>;
}

export interface ScheduleMessageQueueService {
  enqueue(
    sessionId: number,
    userId: number,
    content: string,
    images: string | null,
    scheduledTaskId?: number | null,
  ): Promise<void>;
}

export interface ScheduleHarnessService {
  executeFromEvent(sessionId: number, executionId: string, listener: unknown, cancelFlag?: { get(): boolean; set(v: boolean): void }): Promise<void>;
}

/** Push the already-persisted USER prompt through the live WS execution path. */
export type ScheduledLiveExecution = (
  session: Session,
  userId: number,
  executionId: string,
  savedMessage: Message,
  /** 本次触发开始时刻。停止标记早于它视为陈旧，不取消这次执行。 */
  startedAt?: number,
  /** 触发本执行的定时任务 id：收件箱条目据此前置「定时任务」来源徽标。 */
  scheduledTaskId?: number | null,
  /** 触发来源（SCHEDULED=定时任务；WEBHOOK/API 由开放接口域传入），透传给收件箱徽标。 */
  source?: 'SCHEDULED' | 'WEBHOOK' | 'API' | null,
) => Promise<void>;

/** Push the final assistant result to a Feishu channel session (no-op for non-Feishu sessions). */
export type ScheduledFeishuResultPusher = (sessionId: number, text: string) => Promise<void>;

/** Spring cron uses `?` in DOM/DOW; Croner needs `*`. Also trim trailing spaces. */
export function normalizeSpringCron(expression: string): string {
  return expression.trim().replace(/\?/g, '*').replace(/\s+/g, ' ');
}

/**
 * 判断 cron 是否为一次性任务：固定了「日」与「月」且「周」为通配（如 `0 0 8 15 8 ?`）。
 * 这类表达式下一次触发永远在明年同一天，任务实际只会执行一次。
 */
export function isOneShotCron(expression: string): boolean {
  const parts = expression.trim().replace(/\s+/g, ' ').split(' ');
  if (parts.length !== 6) return false;
  const [sec, min, hour, dom, month, dow] = parts;
  const fixed = (p: string) => /^\d+$/.test(p);
  const any = (p: string) => p === '*' || p === '?';
  // 秒/分/时/日/月全部固定、周为通配，才会只触发一次
  return fixed(sec) && fixed(min) && fixed(hour) && fixed(dom) && fixed(month) && any(dow);
}

export interface CronPreview {
  valid: boolean;
  /** 是否一次性任务（按 cron 形态判定，与创建/更新时的判定同源）。 */
  oneShot: boolean;
  nextFireTimes: string[];
  message: string | null;
}

export const MAX_TASK_NAME_LENGTH = 200;
export const MAX_TASK_PROMPT_LENGTH = 10000;
/** 连续失败达到此次数后自动暂停。按触发点计，不按 attempt 计。 */
export const TASK_PAUSE_AFTER_FAILURES = 3;
export const DEFAULT_RETRY_MAX = 2;
export const DEFAULT_RETRY_INTERVAL_MINUTES = 5;
export const MAX_RETRY_MAX = 5;
export const MIN_RETRY_INTERVAL_MINUTES = 1;
export const MAX_RETRY_INTERVAL_MINUTES = 60;

const PREVIEW_DEFAULT_COUNT = 3;
const PREVIEW_MIN_COUNT = 1;
const PREVIEW_MAX_COUNT = 10;

/**
 * 微信主动发送窗口：`context_token` 仅在用户最近一条入站消息后的 24 小时内有效，
 * 超过后 ilink 一律返回 `ret=-2`。定时任务等「用户长时间未说话后触发」的场景必然落在窗口外。
 */
const WEIXIN_ACTIVE_SEND_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ScheduleTaskTerminalService {
  finishExecution(sessionId: number, userId: number, phase: string, executionId: string, reason?: string, notifySource?: TaskNotifySource): Promise<void>;
}

export interface ScheduleWeixinSendService {
  sendText(accountId: string, wxUserId: string, text: string): Promise<boolean>;
}

export interface ScheduleWeixinAccountRepo {
  findByUserId(userId: number): Promise<{ accountId?: string | null } | null>;
}

export interface ScheduleWeixinTokenRepo {
  findByAccountId(accountId: string): Promise<Array<{ wxUserId: string }>>;
}

/**
 * 微信 24 小时主动发送窗口预检：定时任务在用户长时间未说话后触发时，
 * `context_token` 必然已过期，直接打 ilink 只会拿到 `ret=-2`。
 * 预检查该账号最近入站时间，超窗则不打 ilink，让调用方改走站内通知。
 */
export interface ScheduleWeixinInboundRepo {
  findLatestInboundAt(accountId: string): Promise<Date | null>;
}

/** 任务名称校验：与 scheduled_task.name VARCHAR(200) NOT NULL 对齐。 */
export function normalizeTaskName(name: string | null | undefined): string {
  const value = (name ?? '').trim();
  if (value.length === 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '任务名称不能为空');
  }
  if (value.length > MAX_TASK_NAME_LENGTH) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `任务名称不能超过 ${MAX_TASK_NAME_LENGTH} 字符`);
  }
  return value;
}

/** 提示词校验：任务本体为空则该任务没有任何可执行内容。 */
export function normalizeTaskPrompt(prompt: string | null | undefined): string {
  const value = (prompt ?? '').trim();
  if (value.length === 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '任务提示词不能为空');
  }
  if (value.length > MAX_TASK_PROMPT_LENGTH) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `任务提示词不能超过 ${MAX_TASK_PROMPT_LENGTH} 字符`);
  }
  return value;
}

export function clampPreviewCount(count: number): number {
  if (!Number.isFinite(count)) return PREVIEW_DEFAULT_COUNT;
  return Math.min(PREVIEW_MAX_COUNT, Math.max(PREVIEW_MIN_COUNT, Math.trunc(count)));
}

/**
 * Cron 预览：与调度器共用 normalizeSpringCron + croner + Asia/Shanghai，
 * 保证「预览看到的触发时间」就是「实际执行时间」。非法表达式不抛异常。
 */
export function buildCronPreview(cronExpression: string, count: number = PREVIEW_DEFAULT_COUNT): CronPreview {
  const normalized = normalizeSpringCron(cronExpression ?? '');
  if (normalized.length === 0) {
    return { valid: false, oneShot: false, nextFireTimes: [], message: 'cron 表达式不能为空' };
  }
  const oneShot = isOneShotCron(normalized);
  try {
    const cron = new Cron(normalized, { timezone: 'Asia/Shanghai' });
    const runs = cron.nextRuns(clampPreviewCount(count));
    if (runs.length === 0) {
      return { valid: false, oneShot, nextFireTimes: [], message: '该表达式没有可计算的下次触发时间' };
    }
    return { valid: true, oneShot, nextFireTimes: runs.map((d) => formatDateTime(d)), message: null };
  } catch (e) {
    return {
      valid: false,
      oneShot: false,
      nextFireTimes: [],
      message: `无效的 cron 表达式: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

const sessionLocks = new Map<number, Promise<void>>();

/**
 * 会话级串行锁（导出共享：开放接口 OpenRunService 与定时任务同锁串行，
 * 见技术方案决策 16——第三执行入口自建新锁会让 check-then-act 窗口只剩 busy 双检兜底）。
 */
export async function withSessionLock<T>(sessionId: number, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((r) => { release = r; });
  // Map 中存链式 Promise（同 GitWriteOperationService.withRepoLock），清理时按同一引用比较，
  // 否则清理条件永假导致 Map 条目按 sessionId 泄漏。
  const chained = prev.then(() => current, () => current);
  sessionLocks.set(sessionId, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (sessionLocks.get(sessionId) === chained) {
      sessionLocks.delete(sessionId);
    }
  }
}

/** Trigger envelope injected around task.prompt so the agent executes the task itself instead of re-creating it. */
export function buildScheduledPrompt(task: Pick<ScheduledTask, 'name'>, prompt: string): string {
  return [
    `[系统提示：本消息由定时任务「${task.name}」按 cron 计划自动触发，当前时间 ${formatDateTime(new Date())}。`,
    '请直接执行下面分隔线之后的任务内容本身；除非用户在任务内容中明确要求，不要创建、修改、暂停或删除任何定时任务，也不要重新调度自己。',
    '---',
    prompt,
  ].join('\n');
}

export class ScheduledTaskService {
  /** 正在排队/执行中的任务 id → 计数，防止锁等待期间重复触发连环补发。 */
  private readonly inFlight = new Set<number>();
  /** 入队序号：同一毫秒内递增，重启后以当前时间戳为底，新排队不会排到历史行前面。 */
  private queueTick = 0;
  private feishuResultPusher: ScheduledFeishuResultPusher | null = null;
  private runWindowLoader: ((sessionId: number, messageId: number) => Promise<{ costMicros: number | null; wallClockMs: number }>) | null = null;
  private failureNotifier: ((input: { userId: number; taskId: number; taskName: string; sessionId: number | null; failures: number }) => Promise<void>) | null = null;
  /** 微信 24 小时窗口已关时的站内通知回调（可选注入）。 */
  private weixinWindowNotifier: ((input: { userId: number; sessionId: number; title: string; body: string }) => Promise<void>) | null = null;
  /** 微信入站仓库：用于主动发送前的 24 小时窗口预检（可选注入）。 */
  private weixinInboundRepository: ScheduleWeixinInboundRepo | null = null;
  constructor(
    private readonly store: ScheduledTaskStore,
    private readonly sessionService: ScheduleSessionService,
    private readonly messageQueueService: ScheduleMessageQueueService,
    private readonly harnessService: ScheduleHarnessService,
    private readonly taskTerminalService: ScheduleTaskTerminalService,
    private readonly weixinSendService: ScheduleWeixinSendService,
    private readonly weixinAccountRepository: ScheduleWeixinAccountRepo,
    private readonly weixinContextTokenRepository: ScheduleWeixinTokenRepo,
    private readonly agentExecutor: (fn: () => void | Promise<void>) => void = (fn) => { void Promise.resolve().then(fn); },
    private liveExecution: ScheduledLiveExecution | null = null,
    private isSessionBusy: ((sessionId: number) => boolean) | null = null,
    /** 用量预算 BLOCK 闸门（技术方案 §5.7，可选注入）：直跑分支 updatePhase 前检查。 */
    private budgetCheck: ((target: { userId: number | null; agentId: number | null }) => Promise<{ message: string } | null>) | null = null,
  ) {}

  setLiveExecution(liveExecution: ScheduledLiveExecution | null): void {
    this.liveExecution = liveExecution;
  }

  setBudgetCheck(budgetCheck: ((target: { userId: number | null; agentId: number | null }) => Promise<{ message: string } | null>) | null): void {
    this.budgetCheck = budgetCheck;
  }

  setFeishuResultPusher(pusher: ScheduledFeishuResultPusher | null): void {
    this.feishuResultPusher = pusher;
  }

  setSessionBusyCheck(isSessionBusy: ((sessionId: number) => boolean) | null): void {
    this.isSessionBusy = isSessionBusy;
  }

  setRunWindowLoader(loader: ((sessionId: number, messageId: number) => Promise<{ costMicros: number | null; wallClockMs: number }>) | null): void {
    this.runWindowLoader = loader;
  }

  setFailureNotifier(notifier: ((input: { userId: number; taskId: number; taskName: string; sessionId: number | null; failures: number }) => Promise<void>) | null): void {
    this.failureNotifier = notifier;
  }

  /** 注入微信 24 小时窗口已关时的站内通知回调。 */
  setWeixinWindowNotifier(notifier: ((input: { userId: number; sessionId: number; title: string; body: string }) => Promise<void>) | null): void {
    this.weixinWindowNotifier = notifier;
  }

  /** 注入微信入站仓库以启用 24 小时窗口预检；不注入则跳过预检（保持旧行为）。 */
  setWeixinInboundRepository(repo: ScheduleWeixinInboundRepo | null): void {
    this.weixinInboundRepository = repo;
  }

  async createTask(
    userId: number,
    agentId: number,
    sessionId: number,
    name: string,
    prompt: string,
    cronExpression: string,
    once?: boolean,
    reliability?: { retryMax?: number | null; retryIntervalMinutes?: number | null; missedPolicy?: string | null },
  ): Promise<ScheduledTask> {
    const validName = normalizeTaskName(name);
    const validPrompt = normalizeTaskPrompt(prompt);
    this.parseCron(cronExpression);
    const task: ScheduledTask = {
      userId, agentId, sessionId, name: validName, prompt: validPrompt, cronExpression,
      // 显式 once 优先；未指定时按 cron 形态自动判定（固定月+日视为一次性）
      once: once != null ? (once ? 1 : 0) : (isOneShotCron(cronExpression) ? 1 : 0),
      status: 'ACTIVE', fireCount: 0,
      nextFireTime: this.calculateNextFireTime(cronExpression),
      ...this.reliabilityPatch(reliability),
    };
    task.id = await this.store.insert(task);
    return task;
  }

  async updateTask(taskId: number, userId: number, name?: string | null, prompt?: string | null, cronExpression?: string | null, status?: string | null, once?: boolean | null, opts?: { allowNonOwner?: boolean; retryMax?: number | null; retryIntervalMinutes?: number | null; missedPolicy?: string | null }): Promise<ScheduledTask> {
    const task = await this.getTaskOwnedByUser(taskId, userId, opts?.allowNonOwner);
    const previousStatus = task.status;
    if (name != null) task.name = normalizeTaskName(name);
    if (prompt != null) task.prompt = normalizeTaskPrompt(prompt);
    if (once != null) task.once = once ? 1 : 0;
    if (status != null) {
      if (status !== 'ACTIVE' && status !== 'PAUSED') {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '状态只能为 ACTIVE 或 PAUSED');
      }
      task.status = status;
    }
    if (cronExpression != null) {
      this.parseCron(cronExpression);
      const sameSchedule = normalizeSpringCron(cronExpression) === normalizeSpringCron(task.cronExpression ?? '');
      task.cronExpression = cronExpression;
      // 未显式指定 once 时，换 cron 后按新形态重判一次性属性。
      // 存量行的 once 是 0/1 而不是 null，不能再要求 task.once == null。
      if (once == null && !sameSchedule) task.once = isOneShotCron(cronExpression) ? 1 : 0;
      // 管理端保存会原样带上当前 cron。仍是一次性且还在等重试时，下一档必须保持为空。
      // 关掉一次性之后要按循环任务重算下一档，否则重试成功后没有档期。
      const pendingOnceRetry = sameSchedule && task.once === 1 && task.id != null
        && (await this.store.hasPendingRetry?.(task.id)) === true;
      if (!pendingOnceRetry) {
        const next = this.calculateNextFireTime(cronExpression);
        task.nextFireTime = next;
        if (next != null) {
          task.finished = 0;
          task.finishedAt = null;
        }
      }
    }
    // 已完结任务的 nextFireTime 为空。只改名称/提示词不得把它拉起来；
    // 显式改 once，或把状态设回 ACTIVE，才按当前 cron 重新排期。
    const reactivate = cronExpression == null && task.status === 'ACTIVE' && task.nextFireTime == null
      && (once != null || status === 'ACTIVE');
    if (reactivate) {
      const next = this.calculateNextFireTime(task.cronExpression!);
      task.nextFireTime = next;
      if (next != null) {
        task.finished = 0;
        task.finishedAt = null;
      }
    }
    const reliability = this.reliabilityPatch(opts);
    if (reliability.retryMax != null) task.retryMax = reliability.retryMax;
    if (reliability.retryIntervalMinutes != null) task.retryIntervalMinutes = reliability.retryIntervalMinutes;
    if (reliability.missedPolicy != null) task.missedPolicy = reliability.missedPolicy;
    // 只有从非启用跃迁到启用才清零。管理端保存会带上当前状态，重复保存不得清零。
    const enabling = status === 'ACTIVE' && previousStatus !== 'ACTIVE';
    if (enabling) task.consecutiveFailures = 0;
    // 显式字段 patch：不回写 created_at/updated_at 等只读列，
    // 让 updated_at 由 ON UPDATE CURRENT_TIMESTAMP 依据真实修改时刻刷新。
    await this.store.updateById({
      id: task.id!,
      name: task.name,
      prompt: task.prompt,
      cronExpression: task.cronExpression,
      status: task.status,
      once: task.once,
      nextFireTime: task.nextFireTime,
      finished: task.finished,
      finishedAt: task.finishedAt,
      ...reliability,
      ...(enabling ? { consecutiveFailures: 0 } : {}),
    });
    if (status != null && status !== 'ACTIVE') {
      await this.store.clearPendingRetries?.(taskId);
    }
    return task;
  }

  async deleteTask(taskId: number, userId: number, opts?: { allowNonOwner?: boolean }): Promise<void> {
    const task = await this.getTaskOwnedByUser(taskId, userId, opts?.allowNonOwner);
    await this.store.clearPendingRetries?.(taskId);
    await this.store.deleteById(taskId);
    void task;
  }

  listByUser(userId: number): Promise<ScheduledTask[]> {
    return this.store.listByUser(userId);
  }

  async listAll(pageNum: number, pageSize: number, filter?: ScheduledTaskListFilter): Promise<MpPage<ScheduledTask>> {
    const { records, total } = await this.store.listAll(pageNum, pageSize, filter);
    return mpPage(records, total, pageNum, pageSize);
  }

  getById(taskId: number): Promise<ScheduledTask | null> {
    return this.store.selectById(taskId);
  }

  async listRuns(taskId: number, userId: number, limit: number, opts?: { allowNonOwner?: boolean }): Promise<ScheduledTaskRun[]> {
    await this.getTaskOwnedByUser(taskId, userId, opts?.allowNonOwner);
    if (this.store.listRuns == null) return [];
    const size = Math.min(50, Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 20)));
    return this.store.listRuns(taskId, size);
  }

  async executeTask(task: ScheduledTask, ctx?: { isRetry?: boolean; fireTime?: string; runId?: number }): Promise<void> {
    const isRetry = ctx?.isRetry === true;
    // 在飞守卫：提交后直到异步执行结束都占住，避免 cron 再次扫描时连环补发与 fireCount 竞态。
    // 重试撞上在飞时直接返回，不清 next_retry_at，下轮再试。
    if (task.id != null && this.inFlight.has(task.id)) {
      return;
    }
    if (task.id != null) this.inFlight.add(task.id);
    let submitted = false;
    const previousNextFireTime = task.nextFireTime ?? null;
    const dueFireTime = isRetry ? (ctx?.fireTime ?? null) : previousNextFireTime;
    let cronUsedForAdvance = task.cronExpression!;
    let advancedNext: string | null = null;
    let runId: number | null = isRetry ? (ctx?.runId ?? null) : null;
    let pendingRetry = false;
    try {
      // 推进下一档之前先读库。扫描快照上的 cron 可能已被用户改掉；
      // 已暂停的任务还没开跑，不能先把本次档期吃掉。
      const beforeRun = task.id != null ? await this.store.selectById(task.id) : null;
      if (beforeRun != null && beforeRun.status != null && beforeRun.status !== 'ACTIVE') {
        if (isRetry && runId != null) await this.store.clearRunRetry?.(runId);
        return;
      }
      if (isRetry && (beforeRun == null || beforeRun.finished === 1)) {
        if (runId != null) await this.store.clearRunRetry?.(runId);
        return;
      }
      if (beforeRun?.cronExpression) {
        cronUsedForAdvance = beforeRun.cronExpression;
        task.cronExpression = beforeRun.cronExpression;
      }
      if (beforeRun?.once != null) task.once = beforeRun.once;
      if (beforeRun?.name != null) task.name = beforeRun.name;
      if (beforeRun?.prompt != null) task.prompt = beforeRun.prompt;
      if (beforeRun?.retryMax != null) task.retryMax = beforeRun.retryMax;
      if (beforeRun?.retryIntervalMinutes != null) task.retryIntervalMinutes = beforeRun.retryIntervalMinutes;
      if (!isRetry) {
        // M-5 同类约束：此处仅增量写 nextFireTime，禁止用 listDue 的 T0 快照整行回写，
        // 否则会覆盖扫描到执行之间用户对 name/prompt/cron/status 的修改。
        const nextFireTime = this.calculateNextFireTime(cronUsedForAdvance);
        advancedNext = nextFireTime;
        task.nextFireTime = nextFireTime;
        await this.store.updateById({ id: task.id!, nextFireTime });
        if (dueFireTime != null && task.id != null && task.sessionId != null) {
          const claimed = await this.claimRun(task.id, task.sessionId, dueFireTime);
          if (!claimed.ok) {
            await this.restoreNextFireIfUnchanged(task.id, advancedNext, previousNextFireTime);
            return;
          }
          runId = claimed.runId;
        }
      }
      const executionId = randomUUID();
      const userId = task.userId!;
      try {
        this.agentExecutor(async () => {
        try {
          await withSessionLock(task.sessionId!, async () => {
            // 进入执行阶段才算「运行中违纪」：入队失败/会话为空等未真正执行
            // 的路径不得误标正在运行的其它执行（L-2）。
            let executionStarted = false;
            let countThisRun = false;
            let sessionGone = false;
            let messageId: number | null = null;
            let startedAt: string | null = null;
            try {
              // 拿到锁后重读最新任务状态，排队期间可能已被更新/暂停/删除
              const latest = task.id != null ? await this.store.selectById(task.id) : null;
              if (latest == null) {
                return;
              }
              task.name = latest.name;
              task.prompt = latest.prompt ?? task.prompt;
              task.cronExpression = latest.cronExpression ?? task.cronExpression;
              task.status = latest.status;
              task.once = latest.once ?? task.once;
              task.fireCount = latest.fireCount ?? task.fireCount;
              task.retryMax = latest.retryMax ?? task.retryMax;
              task.retryIntervalMinutes = latest.retryIntervalMinutes ?? task.retryIntervalMinutes;
              if (task.status != null && task.status !== 'ACTIVE') {
                if (isRetry) {
                  if (runId != null) await this.store.clearRunRetry?.(runId);
                } else {
                  // 下一档已经写过，但这次还没执行。暂停/停用时还回进入本方法前的档期。
                  await this.restoreNextFireIfUnchanged(task.id!, advancedNext, previousNextFireTime);
                  if (runId != null && dueFireTime != null) await this.store.deleteUnstartedRun?.(task.id!, dueFireTime);
                }
                return;
              }
              if (isRetry) {
                if (runId == null || this.store.beginRetry == null) return;
                const begun = await this.store.beginRetry(runId);
                if (begun == null) return;
              }
              let session: Session;
              try {
                const loaded = await this.sessionService.getSession(task.sessionId!);
                if (loaded == null) throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
                session = loaded;
              } catch (e) {
                if (!(e instanceof BusinessException) || e.code !== ErrorCode.SESSION_NOT_FOUND.code) throw e;
                // 会话已删：停掉后续档期。nextFireTime 在开跑前已经推进，这里必须清掉，
                // 否则已删会话的循环任务会每个周期再失败一次。
                sessionGone = true;
                countThisRun = true;
                pendingRetry = (await this.finishRun(runId, 'FAILED', { retryable: false, error: '会话已删除', task })).willRetry;
                return;
              }
              const phase = session.phase;
              const busy = this.isSessionBusy?.(task.sessionId!) === true || isActivePhase(phase);
              if (busy) {
                // 仅入队未真正执行：不进入 finally 的 fireCount 收尾（countThisRun 保持 false），
                // 但本次 cron 触发已发生——入队成功即累加 fireCount/lastFireTime。
                // 绑定 scheduledTaskId：队列消费侧完成后回写 lastExecutionStatus QUEUED→COMPLETED/FAILED。
                await this.messageQueueService.enqueue(
                  task.sessionId!, userId, buildScheduledPrompt(task, task.prompt!), null, task.id ?? null,
                );
                const enqueuedAt = formatDateTime(new Date());
                const patch: Partial<ScheduledTask> & { id: number } = {
                  id: task.id!,
                  lastExecutionStatus: 'QUEUED',
                };
                if (!isRetry) {
                  patch.lastFireTime = enqueuedAt;
                  patch.fireCount = (latest.fireCount ?? task.fireCount ?? 0) + 1;
                  task.lastFireTime = enqueuedAt;
                  task.fireCount = patch.fireCount;
                }
                // once 只看锁内重读。入队先不标完结，失败后还要能重试；清空下一档挡住 listDue 再开一档。
                if (!isRetry && latest.once === 1) {
                  patch.nextFireTime = null;
                  task.nextFireTime = null;
                }
                task.lastExecutionStatus = 'QUEUED';
                await this.store.updateById(patch);
                if (runId != null) {
                  await this.store.updateRun?.({
                    id: runId, status: 'QUEUED', startedAt: null, messageId: null, queueSeq: this.nextQueueSeq(),
                  });
                }
                return;
              }
              // 预算 BLOCK 检查（技术方案 §5.7）：直跑分支 busy 入队判定之后、updatePhase('RUNNING')
              // 与 USER 消息落库之前——此处被拒无孤儿数据需回滚。本轮执行标记 FAILED（走早退
              // FAILED 记录路径）；busy 入队分支不检查，排队消息由 autoConsumeQueue 消费时再查；
              // 子代理/边路跟随父会话准入结论，不单独检查。
              if (this.budgetCheck != null
                && session.sessionType !== 'SUBAGENT'
                && session.sessionType !== 'SIDE_TASK') {
                const blocked = await this.budgetCheck({ userId: session.userId ?? null, agentId: session.agentId ?? null });
                if (blocked != null) {
                  countThisRun = true;
                  pendingRetry = (await this.finishRun(runId, 'FAILED', { retryable: false, error: '预算不足，执行被准入闸门阻止', task })).willRetry;
                  await this.markTaskResult(task, 'FAILED');
                  return;
                }
              }
              const executionStartedAt = Date.now();
              startedAt = formatDateTime(new Date(executionStartedAt));
              await this.sessionService.updatePhase(task.sessionId!, 'RUNNING');
              executionStarted = true;
              if (runId != null) await this.store.updateRun?.({ id: runId, status: 'RUNNING', startedAt });
              let savedMessage: Message;
              try {
                savedMessage = await this.sessionService.saveMessage(task.sessionId!, 'USER', buildScheduledPrompt(task, task.prompt!), null, null, null, 0, null);
              } catch (saveError) {
                await this.sessionService.updatePhase(task.sessionId!, 'IDLE');
                countThisRun = true;
                pendingRetry = (await this.finishRun(runId, 'FAILED', {
                  retryable: true,
                  error: saveError instanceof Error ? saveError.message : String(saveError),
                  startedAt,
                  task,
                })).willRetry;
                await this.markTaskResult(task, 'FAILED');
                return;
              }
              messageId = savedMessage?.id ?? null;
              if (runId != null && messageId != null) await this.store.updateRun?.({ id: runId, messageId });
              if (this.liveExecution != null) {
                await this.liveExecution(session, userId, executionId, savedMessage, executionStartedAt, task.id ?? null);
                // liveExecution（runExecution）内部 catch 吞掉失败/取消并落终态后正常返回，
                // 必须回读会话真实终态：FAILED/CANCELLED 时不得标 COMPLETED，
                // 也不得把上一轮 ASSISTANT 旧回复误推给飞书/微信。
                const after = await this.sessionService.getSession(task.sessionId!);
                const actualPhase = after?.phase;
                if (actualPhase === 'FAILED' || actualPhase === 'CANCELLED') {
                  pendingRetry = (await this.finishRun(runId, actualPhase, {
                    retryable: actualPhase === 'FAILED',
                    error: actualPhase === 'CANCELLED' ? '用户取消' : '执行失败',
                    messageId,
                    startedAt,
                    task,
                  })).willRetry;
                  await this.markTaskResult(task, actualPhase);
                  countThisRun = true;
                  return;
                }
              } else {
                await this.harnessService.executeFromEvent(task.sessionId!, executionId, {
                  onContentDelta() {},
                  onToolCallStart() {},
                  onToolCallResult() {},
                  onMessageEnd() {},
                  onError() {},
                });
                // 遗留/测试路径（无 liveExecution）：这一轮确定由定时任务触发，显式传 SCHEDULED，
                // 否则收件箱条目会缺「定时任务」来源（窄接口缺参会静默回落 MANUAL）
                await this.taskTerminalService.finishExecution(
                  task.sessionId!, userId, 'COMPLETED', executionId, undefined, 'SCHEDULED',
                );
              }
              pendingRetry = (await this.finishRun(runId, 'COMPLETED', { messageId, startedAt, task })).willRetry;
              await this.markTaskResult(task, 'COMPLETED');
              await this.sendWeixinReplyIfApplicable(task.sessionId!, userId);
              await this.sendFeishuReplyIfApplicable(task.sessionId!);
              countThisRun = true;
            } catch (e) {
              if (e instanceof BusinessException && e.code === ErrorCode.SESSION_NOT_FOUND.code) {
                sessionGone = true;
                countThisRun = true;
                pendingRetry = (await this.finishRun(runId, 'FAILED', { retryable: false, error: '会话已删除', startedAt, messageId, task })).willRetry;
                return;
              }
              countThisRun = true;
              // L-2：仅本次确实进入执行阶段才落 FAILED 终态；
              // busy 入队失败 / 会话为空等未执行路径不得改写同会话正在运行的执行。
              if (executionStarted) {
                try {
                  await this.taskTerminalService.finishExecution(task.sessionId!, userId, 'FAILED', executionId,
                    e instanceof Error ? e.message : String(e));
                } catch { /* ignore */ }
              }
              pendingRetry = (await this.finishRun(runId, 'FAILED', {
                retryable: true,
                error: e instanceof Error ? e.message : String(e),
                startedAt,
                messageId,
                task,
              })).willRetry;
              await this.markTaskResult(task, 'FAILED');
            } finally {
              if (!countThisRun) return;
              if (sessionGone) {
                const now = formatDateTime(new Date());
                await this.store.updateById({
                  id: task.id!,
                  finished: 1,
                  finishedAt: now,
                  nextFireTime: null,
                  lastExecutionStatus: 'FAILED',
                  lastFireTime: now,
                  ...(isRetry ? {} : { fireCount: (task.fireCount ?? 0) + 1 }),
                });
                return;
              }
              // M-5：执行收尾只做「增量更新」——仅写执行结果字段，避免整行回写
              // T0 快照覆盖执行期间用户对 cron/prompt/name/status 的修改。
              const patch: Partial<ScheduledTask> & { id: number } = { id: task.id! };
              const now = formatDateTime(new Date());
              patch.lastFireTime = now;
              if (!isRetry) patch.fireCount = (task.fireCount ?? 0) + 1;
              const latest = task.id != null ? await this.store.selectById(task.id) : null;
              if (latest != null && (latest.status === 'ACTIVE' || latest.status === 'PAUSED')) {
                if (latest.once === 1 && pendingRetry) {
                  // 还会重试：清掉已经推进的下一档。暂停与否都要清，否则重试和下一档叠在一起。
                  patch.nextFireTime = null;
                  patch.finished = 0;
                  patch.finishedAt = null;
                } else if (latest.once === 1 && !pendingRetry && (isRetry || latest.status === 'PAUSED' || latest.status === 'ACTIVE')) {
                  if (isRetry || latest.status === 'PAUSED') {
                    patch.finished = 1;
                    patch.finishedAt = now;
                    patch.nextFireTime = null;
                  } else {
                    const latestCron = latest.cronExpression ?? cronUsedForAdvance;
                    const next = this.calculateNextFireTime(latestCron);
                    // 一次性任务执行过一次即完结（cron 固定月+日时 next 永远是明年同一天，不能靠 next==null 判定）
                    if (next == null || latest.once === 1) {
                      patch.finished = 1;
                      patch.finishedAt = now;
                      patch.nextFireTime = null;
                    } else if (latestCron !== cronUsedForAdvance) {
                      // 开跑前按旧 cron 推进过下一档。执行期间 cron 已变，按新表达式重写，避免仍按旧档期触发。
                      patch.nextFireTime = next;
                    }
                  }
                } else if (latest.status === 'ACTIVE') {
                  const latestCron = latest.cronExpression ?? cronUsedForAdvance;
                  const next = this.calculateNextFireTime(latestCron);
                  if (next == null) {
                    patch.finished = 1;
                    patch.finishedAt = now;
                    patch.nextFireTime = null;
                  } else if (latestCron !== cronUsedForAdvance) {
                    patch.nextFireTime = next;
                  }
                }
              }
              await this.store.updateById(patch);
            }
          });
        } finally {
          if (task.id != null) this.inFlight.delete(task.id);
        }
      });
      submitted = true;
      } catch (e) {
        // 池满拒绝发生在回调开始之前：本次触发还没跑，必须把 nextFireTime 还回 due，
        // 否则扫描 catch 会把它记成 FAILED 并跳到下一档（每天一次要等到明天，一次性要等到明年）。
        if (!isExecutorRejected(e)) {
          const handled = await this.failOpenRun(runId, e);
          if (handled) return;
          throw e;
        }
        if (isRetry) {
          console.warn(`定时任务重试提交被拒绝，保留下次重试时间, id=${task.id}`, e);
          return;
        }
        task.nextFireTime = previousNextFireTime;
        try {
          await this.store.updateById({ id: task.id!, nextFireTime: previousNextFireTime });
        } catch (rollbackError) {
          console.error(`定时任务提交被拒绝后回滚 nextFireTime 失败, id=${task.id}`, rollbackError);
        }
        if (task.id != null && dueFireTime != null) await this.store.deleteUnstartedRun?.(task.id, dueFireTime);
        console.warn(`定时任务提交被拒绝，保留本次触发以便下轮扫描, id=${task.id}`, e);
      }
    } finally {
      if (!submitted && task.id != null) this.inFlight.delete(task.id);
    }
  }

  /**
   * 未开跑就放弃本次触发时，把 nextFireTime 还回推进前的值。
   * 仅当库里仍是我们刚写下去的那一档时才还：用户随后又改过计划则保留他们的值。
   */
  private async restoreNextFireIfUnchanged(
    taskId: number | undefined,
    writtenNext: string | null,
    previousNext: string | null,
  ): Promise<void> {
    if (taskId == null) return;
    try {
      const current = await this.store.selectById(taskId);
      if (current == null || current.nextFireTime !== writtenNext) return;
      await this.store.updateById({ id: taskId, nextFireTime: previousNext });
    } catch (error) {
      console.error(`定时任务未执行，回滚 nextFireTime 失败, id=${taskId}`, error);
    }
  }

  /** Cron 预览入口：路由层直接调用（只读，不落库）。 */
  previewCron(cronExpression: string, count?: number): CronPreview {
    return buildCronPreview(cronExpression, count ?? PREVIEW_DEFAULT_COUNT);
  }

  calculateNextFireTime(cronExpression: string): string | null {
    try {
      const cron = new Cron(normalizeSpringCron(cronExpression), { timezone: 'Asia/Shanghai' });
      const next = cron.nextRun();
      return next ? formatDateTime(next) : null;
    } catch {
      return null;
    }
  }

  private parseCron(cronExpression: string): void {
    try {
      // eslint-disable-next-line no-new
      new Cron(normalizeSpringCron(cronExpression), { timezone: 'Asia/Shanghai' });
    } catch (e) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `无效的 cron 表达式: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * busy 入队的定时任务在队列终态回写。
   * 一次性任务入队时不再立刻完结。取消说明这一次没有跑完，恢复下一档；
   * 成功或重试耗尽后才完结；还会重试时保持未完结且下一档为空。
   */
  async settleQueuedExecution(taskId: number, status: 'COMPLETED' | 'FAILED' | 'CANCELLED'): Promise<void> {
    const task = await this.store.selectById(taskId);
    if (task == null) return;
    const run = (await this.store.oldestQueuedRun?.(taskId)) ?? null;
    let willRetry = false;
    if (run?.id != null) {
      willRetry = (await this.finishRun(run.id, status, {
        retryable: status === 'FAILED',
        error: status === 'FAILED' ? '排队执行失败' : status === 'CANCELLED' ? '排队消息已取消' : null,
        task,
      })).willRetry;
    }
    const patch: Partial<ScheduledTask> & { id: number } = { id: taskId, lastExecutionStatus: status };
    if (task.once === 1 && task.status === 'ACTIVE') {
      if (status === 'CANCELLED') {
        patch.finished = 0;
        patch.finishedAt = null;
        patch.nextFireTime = task.cronExpression ? this.calculateNextFireTime(task.cronExpression) : null;
      } else if (status === 'COMPLETED' || (status === 'FAILED' && !willRetry)) {
        patch.finished = 1;
        patch.finishedAt = formatDateTime(new Date());
        patch.nextFireTime = null;
      } else if (status === 'FAILED' && willRetry) {
        patch.finished = 0;
        patch.finishedAt = null;
        patch.nextFireTime = null;
      }
    }
    await this.store.updateById(patch);
  }

  private async markTaskResult(task: ScheduledTask, status: string): Promise<void> {
    task.lastExecutionStatus = status;
    // 增量写：避免用可能过期的 task 对象整行回写（同 executeTask 开头，见 M-5 注释）
    if (task.id == null) return;
    await this.store.updateById({ id: task.id, lastExecutionStatus: status });
  }

  private async sendWeixinReplyIfApplicable(sessionId: number, userId: number): Promise<void> {
    try {
      const session = await this.sessionService.getSession(sessionId);
      if (session == null || session.projectKey !== WEIXIN_PROJECT_KEY) {
        return;
      }
      const account = await this.weixinAccountRepository.findByUserId(userId);
      if (account == null || !account.accountId) {
        return;
      }
      const messages = await this.sessionService.getMessages(sessionId);
      let reply: string | null = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'ASSISTANT') {
          reply = messages[i].content ?? null;
          break;
        }
      }
      if (!reply || reply.trim() === '') {
        return;
      }
      const { getWeixinSessionPeer } = await import('../weixin/session-peer.js');
      const boundWxUserId = await getWeixinSessionPeer(sessionId);
      const tokens = await this.weixinContextTokenRepository.findByAccountId(account.accountId);
      const wxUserId = boundWxUserId
        ?? (tokens.length === 1 ? tokens[0]?.wxUserId : undefined);
      if (!wxUserId) {
        return;
      }
      // 24 小时窗口预检：定时任务多在用户长时间未说话后触发，context_token 早已过期，
      // 此时打 ilink 只会拿到 ret=-2（线上 10-05/10-06/10-09 三次失败均属此类）。
      // 超窗则不打 ilink，转站内通知指路，用户下次说话时即可在微信收到后续回复。
      if (!(await this.isWeixinInboundWindowOpen(account.accountId))) {
        console.warn(`定时任务微信回复跳过：超过24小时主动发送窗口, accountId=${account.accountId}, sessionId=${sessionId}`);
        await this.notifyWeixinWindowClosed(sessionId, userId);
        return;
      }
      await this.weixinSendService.sendText(account.accountId, wxUserId, reply);
    } catch (e) {
      console.error('Error sending WeChat reply for scheduled task', e);
    }
  }

  /**
   * 微信 24 小时主动发送窗口是否仍打开。
   * 未注入入站仓库（如单元测试）时无法判定，按「打开」放行，保持既有行为。
   */
  private async isWeixinInboundWindowOpen(accountId: string): Promise<boolean> {
    const latest = await this.weixinInboundRepository?.findLatestInboundAt(accountId);
    if (latest == null) return true;
    return Date.now() - latest.getTime() < WEIXIN_ACTIVE_SEND_WINDOW_MS;
  }

  /** 窗口已关时把提示落站内收件箱，避免「Agent 跑完了但用户哪里都看不到」。 */
  private async notifyWeixinWindowClosed(sessionId: number, userId: number): Promise<void> {
    const notifier = this.weixinWindowNotifier;
    if (notifier == null) return;
    try {
      await notifier({
        userId,
        sessionId,
        title: '微信回复发送失败',
        body: '定时任务的回复已生成，但超过 24 小时主动发送窗口，无法从微信推送给您。请在电脑端打开 Mao 查看完整内容。',
      });
    } catch (e) {
      console.error('Error notifying weixin 24h window closed', e);
    }
  }

  /** 飞书通道定时任务结果回流：推送最终 ASSISTANT 回复；非飞书会话由 pusher 实现内部判断跳过。 */
  private async sendFeishuReplyIfApplicable(sessionId: number): Promise<void> {
    const pusher = this.feishuResultPusher;
    if (pusher == null) return;
    try {
      const messages = await this.sessionService.getMessages(sessionId);
      let reply: string | null = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'ASSISTANT') {
          reply = messages[i].content ?? null;
          break;
        }
      }
      if (!reply || reply.trim() === '') {
        return;
      }
      await pusher(sessionId, reply);
    } catch (e) {
      console.error('Error sending Feishu reply for scheduled task', e);
    }
  }

  async compensateMissed(processStartedAt: Date): Promise<void> {
    if (this.store.listMissedTasks == null || this.store.casNextFire == null) return;
    const tasks = await this.store.listMissedTasks(formatDateTime(processStartedAt));
    // 补偿窗口截止在进程启动时刻。改用墙钟会把启动之后才到期的点记成错过。
    const now = processStartedAt;
    for (const task of tasks) {
      if (task.id == null || task.cronExpression == null || task.nextFireTime == null || task.sessionId == null) continue;
      let cron: Cron;
      try {
        cron = new Cron(normalizeSpringCron(task.cronExpression), { timezone: 'Asia/Shanghai' });
      } catch {
        continue;
      }
      const collected = collectMissedPoints(cron, parseShanghaiDateTime(task.nextFireTime), now);
      if (collected.latest == null) continue;
      const policy = task.missedPolicy === 'SKIP' ? 'SKIP' : 'RUN_ONCE';
      const toRecord = policy === 'RUN_ONCE'
        ? collected.points.filter((point) => point.getTime() !== collected.latest!.getTime())
        : collected.points;
      for (const point of toRecord) {
        await this.store.insertMissedIgnore?.({
          taskId: task.id,
          fireTime: formatDateTime(point),
          sessionId: task.sessionId,
        });
      }
      if (collected.truncated > 0) {
        console.warn(`定时任务错过点超过保留上限, taskId=${task.id}, truncated=${collected.truncated}`);
      }
      const original = task.nextFireTime;
      if (policy === 'SKIP') {
        if (task.once === 1) {
          await this.store.casNextFire(task.id, original, null, { finishedAt: formatDateTime(now) });
        } else {
          const next = cron.nextRun(now);
          await this.store.casNextFire(task.id, original, next ? formatDateTime(next) : null);
        }
      } else {
        await this.store.casNextFire(task.id, original, formatDateTime(collected.latest));
      }
    }
  }

  async reconcileOnStartup(isTrafficOwner: boolean): Promise<void> {
    if (this.store.listOpenRuns == null) return;
    const rows = await this.store.listOpenRuns();
    for (const run of rows) {
      if (run.id == null) continue;
      if (run.status === 'RUNNING' && (run.startedAt == null || run.startedAt === '')) {
        if (!isTrafficOwner || this.inFlight.has(run.taskId)) continue;
        const task = await this.store.selectById(run.taskId);
        if (task == null) continue;
        const outcome = await this.finishRun(run.id, 'FAILED', { retryable: true, error: '启动前未开跑', task });
        await this.parkOrFinishOnce(task, outcome.willRetry);
        continue;
      }
      if (run.status === 'QUEUED') {
        await this.failQueuedRunIfSessionGone(run);
        continue;
      }
      await this.reconcileOpenRun(run);
    }
  }

  async reconcileRunsForSession(sessionId: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED'): Promise<void> {
    if (this.store.listOpenRunsBySession == null) return;
    const rows = await this.store.listOpenRunsBySession(sessionId);
    const started = rows.filter((run) => run.status === 'RUNNING' && run.startedAt != null && run.startedAt !== '' && run.id != null);
    if (started.length !== 1) {
      if (started.length > 1) console.warn(`定时任务崩溃恢复对不上唯一运行行, sessionId=${sessionId}, count=${started.length}`);
      return;
    }
    const run = started[0]!;
    const task = await this.store.selectById(run.taskId);
    if (task == null || run.id == null) return;
    const outcome = await this.finishRun(run.id, phase, { retryable: phase === 'FAILED', task });
    await this.parkOrFinishOnce(task, outcome.willRetry);
  }

  async reconcileStale(now = new Date()): Promise<void> {
    if (this.store.listStaleRuns == null) return;
    const runningBefore = formatDateTime(new Date(now.getTime() - 6 * 3600_000));
    const queuedBefore = formatDateTime(new Date(now.getTime() - 24 * 3600_000));
    const rows = await this.store.listStaleRuns(runningBefore, queuedBefore);
    for (const run of rows) {
      if (run.id == null) continue;
      if (run.status === 'QUEUED') {
        const task = await this.store.selectById(run.taskId);
        if (task == null) continue;
        if (await this.sessionMissing(run.sessionId)) {
          await this.failQueuedRunIfSessionGone(run);
          continue;
        }
        await this.finishRun(run.id, 'CANCELLED', { retryable: false, error: '长时间未消费', task });
        if (task.once === 1 && task.id != null && task.status === 'ACTIVE') {
          await this.store.updateById({
            id: task.id,
            finished: 0,
            finishedAt: null,
            nextFireTime: task.cronExpression ? this.calculateNextFireTime(task.cronExpression) : null,
            lastExecutionStatus: 'CANCELLED',
          });
        }
        continue;
      }
      await this.reconcileOpenRun(run);
    }
  }

  private async reconcileOpenRun(run: ScheduledTaskRun): Promise<void> {
    if (run.id == null) return;
    let session: Session | null = null;
    try {
      session = await this.sessionService.getSession(run.sessionId);
    } catch (e) {
      if (!(e instanceof BusinessException) || e.code !== ErrorCode.SESSION_NOT_FOUND.code) throw e;
    }
    const task = await this.store.selectById(run.taskId);
    if (task == null) return;
    if (run.status === 'QUEUED') return;
    if (session == null) {
      const outcome = await this.finishRun(run.id, 'FAILED', { retryable: false, error: '会话已删除', task });
      await this.parkOrFinishOnce(task, outcome.willRetry);
      return;
    }
    if (session.phase === 'RUNNING' || session.phase === 'RESUMING') return;
    if (session.phase === 'COMPLETED' || session.phase === 'FAILED' || session.phase === 'CANCELLED') {
      const outcome = await this.finishRun(run.id, session.phase, { retryable: session.phase === 'FAILED', task });
      await this.parkOrFinishOnce(task, outcome.willRetry);
    }
  }

  /** 排队行只在会话已经不存在时收口。上一轮的 COMPLETED/FAILED 相位不能当成这次排队的结果。 */
  private async failQueuedRunIfSessionGone(run: ScheduledTaskRun): Promise<void> {
    if (run.id == null || !(await this.sessionMissing(run.sessionId))) return;
    const task = await this.store.selectById(run.taskId);
    if (task == null || task.id == null) return;
    await this.finishRun(run.id, 'FAILED', { retryable: false, error: '会话已删除', task });
    const now = formatDateTime(new Date());
    await this.store.updateById({
      id: task.id,
      finished: 1,
      finishedAt: now,
      nextFireTime: null,
      lastExecutionStatus: 'FAILED',
      lastFireTime: now,
    });
  }

  private async sessionMissing(sessionId: number): Promise<boolean> {
    try {
      const session = await this.sessionService.getSession(sessionId);
      return session == null;
    } catch (e) {
      if (e instanceof BusinessException && e.code === ErrorCode.SESSION_NOT_FOUND.code) return true;
      throw e;
    }
  }

  /** 崩溃或启动收敛走不到 executeTask 的 finally，一次性任务的档期要在这里补上。 */
  private async parkOrFinishOnce(task: ScheduledTask, willRetry: boolean): Promise<void> {
    if (task.once !== 1 || task.id == null) return;
    const now = formatDateTime(new Date());
    if (willRetry) {
      await this.store.updateById({ id: task.id, nextFireTime: null, finished: 0, finishedAt: null });
      return;
    }
    await this.store.updateById({ id: task.id, finished: 1, finishedAt: now, nextFireTime: null });
  }

  private nextQueueSeq(): number {
    const now = Date.now();
    const floor = now * 1000;
    this.queueTick = this.queueTick >= floor ? this.queueTick + 1 : floor;
    return this.queueTick;
  }

  private async claimRun(taskId: number, sessionId: number, fireTime: string): Promise<{ ok: boolean; runId: number | null }> {
    if (this.store.selectRunByFire == null || this.store.insertRun == null) return { ok: true, runId: null };
    const existing = await this.store.selectRunByFire(taskId, fireTime);
    if (existing == null) {
      try {
        const id = await this.store.insertRun({
          taskId, fireTime, attempt: 1, status: 'RUNNING', sessionId, startedAt: null,
        });
        return { ok: true, runId: id };
      } catch (e) {
        if (!isDupKey(e)) throw e;
        return this.takeExistingRun(await this.store.selectRunByFire(taskId, fireTime));
      }
    }
    return this.takeExistingRun(existing);
  }

  private async takeExistingRun(existing: ScheduledTaskRun | null): Promise<{ ok: boolean; runId: number | null }> {
    if (existing?.id == null) return { ok: false, runId: null };
    if (existing.status === 'MISSED') {
      await this.store.updateRun?.({
        id: existing.id,
        status: 'RUNNING',
        attempt: 1,
        startedAt: null,
        finishedAt: null,
        errorSummary: null,
        nextRetryAt: null,
        messageId: null,
        durationMs: null,
        costMicros: null,
      });
      return { ok: true, runId: existing.id };
    }
    if (existing.status === 'RUNNING' && (existing.startedAt == null || existing.startedAt === '')) {
      return { ok: true, runId: existing.id };
    }
    return { ok: false, runId: existing.id };
  }

  private async failOpenRun(runId: number | null, error: unknown): Promise<boolean> {
    if (runId == null || this.store.selectRunById == null) return false;
    const run = await this.store.selectRunById(runId);
    if (run == null || (run.status !== 'RUNNING' && run.status !== 'QUEUED')) return false;
    const task = await this.store.selectById(run.taskId);
    if (task == null) return false;
    await this.finishRun(runId, 'FAILED', {
      retryable: true,
      error: error instanceof Error ? error.message : String(error),
      task,
    });
    return true;
  }

  private async finishRun(
    runId: number | null,
    phase: 'COMPLETED' | 'FAILED' | 'CANCELLED',
    opts: { retryable?: boolean; error?: string | null; messageId?: number | null; startedAt?: string | null; task: ScheduledTask },
  ): Promise<{ willRetry: boolean }> {
    if (runId == null || this.store.selectRunById == null || this.store.updateRun == null) return { willRetry: false };
    const run = await this.store.selectRunById(runId);
    if (run == null) return { willRetry: false };
    const task = (await this.store.selectById(run.taskId)) ?? opts.task;
    const retryMax = normalizeRetryMax(task.retryMax);
    const interval = normalizeRetryInterval(task.retryIntervalMinutes);
    const attempt = Number(run.attempt ?? 1);
    const active = task.status === 'ACTIVE' && Number(task.finished ?? 0) !== 1;
    const willRetry = phase === 'FAILED' && opts.retryable === true && active && attempt < 1 + retryMax;
    const finishedAt = formatDateTime(new Date());
    const startedAt = opts.startedAt ?? run.startedAt ?? null;
    const messageId = opts.messageId ?? run.messageId ?? null;
    let durationMs: number | null = null;
    let costMicros: number | null = null;
    if (messageId != null && this.runWindowLoader != null) {
      try {
        const totals = await this.runWindowLoader(run.sessionId, messageId);
        costMicros = totals.costMicros;
        durationMs = totals.wallClockMs > 0 ? totals.wallClockMs : elapsedMs(startedAt, finishedAt);
      } catch (e) {
        console.warn(`定时任务运行窗口聚合失败, runId=${runId}`, e);
        durationMs = elapsedMs(startedAt, finishedAt);
      }
    } else {
      durationMs = elapsedMs(startedAt, finishedAt);
    }
    const nextRetryAt = willRetry ? formatDateTime(new Date(Date.now() + interval * 60_000)) : null;
    try {
      await this.store.updateRun({
        id: runId,
        status: phase,
        finishedAt,
        durationMs,
        costMicros,
        errorSummary: clipError(opts.error),
        nextRetryAt,
        messageId,
        startedAt,
      });
    } catch (e) {
      console.error(`定时任务运行记录回写失败, runId=${runId}`, e);
    }
    if (!willRetry && (phase === 'FAILED' || phase === 'COMPLETED') && task.id != null && this.store.recordTaskOutcome != null) {
      try {
        const outcome = await this.store.recordTaskOutcome(task.id, phase, TASK_PAUSE_AFTER_FAILURES, finishedAt);
        if (outcome?.paused) {
          await this.store.clearPendingRetries?.(task.id);
          if (task.userId != null && this.failureNotifier != null) {
            try {
              await this.failureNotifier({
                userId: task.userId,
                taskId: task.id,
                taskName: task.name ?? '',
                sessionId: task.sessionId ?? null,
                failures: outcome.consecutiveFailures,
              });
            } catch (e) {
              console.warn(`定时任务自动暂停通知失败, taskId=${task.id}`, e);
            }
          }
        }
      } catch (e) {
        console.error(`定时任务连续失败计数失败, taskId=${task.id}`, e);
      }
    }
    return { willRetry };
  }

  private reliabilityPatch(input?: { retryMax?: number | null; retryIntervalMinutes?: number | null; missedPolicy?: string | null }): Pick<ScheduledTask, 'retryMax' | 'retryIntervalMinutes' | 'missedPolicy'> {
    const patch: Pick<ScheduledTask, 'retryMax' | 'retryIntervalMinutes' | 'missedPolicy'> = {};
    if (input?.retryMax != null) {
      if (!Number.isInteger(input.retryMax) || input.retryMax < 0 || input.retryMax > MAX_RETRY_MAX) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, `重试次数需为 0-${MAX_RETRY_MAX} 的整数`);
      }
      patch.retryMax = input.retryMax;
    }
    if (input?.retryIntervalMinutes != null) {
      if (!Number.isInteger(input.retryIntervalMinutes) || input.retryIntervalMinutes < MIN_RETRY_INTERVAL_MINUTES || input.retryIntervalMinutes > MAX_RETRY_INTERVAL_MINUTES) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, `重试间隔需为 ${MIN_RETRY_INTERVAL_MINUTES}-${MAX_RETRY_INTERVAL_MINUTES} 的整数分钟`);
      }
      patch.retryIntervalMinutes = input.retryIntervalMinutes;
    }
    if (input?.missedPolicy != null) {
      if (input.missedPolicy !== 'RUN_ONCE' && input.missedPolicy !== 'SKIP') {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '错过补偿只能为 RUN_ONCE 或 SKIP');
      }
      patch.missedPolicy = input.missedPolicy;
    }
    return patch;
  }

  private async getTaskOwnedByUser(taskId: number, userId: number, allowNonOwner = false): Promise<ScheduledTask> {
    const task = await this.store.selectById(taskId);
    if (task == null) {
      throw new BusinessException(ErrorCode.SCHEDULED_TASK_NOT_FOUND);
    }
    if (!allowNonOwner && task.userId !== userId) {
      throw new BusinessException(ErrorCode.SCHEDULED_TASK_ACCESS_DENIED);
    }
    return task;
  }
}

export class ScheduledTaskScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private scans = 0;

  constructor(
    private readonly store: ScheduledTaskStore,
    private readonly service: ScheduledTaskService,
    private readonly isTrafficOwner: () => boolean = () => true,
  ) {}

  start(): void {
    void this.boot();
  }

  private async boot(): Promise<void> {
    const startedAt = new Date();
    try {
      await this.service.compensateMissed(startedAt);
      await this.service.reconcileOnStartup(this.isTrafficOwner());
    } catch (e) {
      console.error('定时任务启动补偿失败', e);
    }
    try {
      await this.scanAndExecute();
    } catch (e) {
      console.error('定时任务首轮扫描失败', e);
    }
    this.timer = setInterval(() => { void this.scanAndExecute(); }, 60_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async scanAndExecute(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const now = formatDateTime(new Date());
      const dueTasks = await this.store.listDue(now);
      if (dueTasks.length > 0) {
        console.info(`Found ${dueTasks.length} due scheduled tasks`);
      }
      for (const task of dueTasks) {
        try {
          await this.service.executeTask(task);
        } catch (e) {
          if (isExecutorRejected(e)) {
            // executeTask 已尽量回滚 nextFireTime。这里再推进会把没跑成的触发吃掉。
            console.error(`Scheduled task submit rejected, leaving it due: id=${task.id}, name=${task.name}`, e);
            continue;
          }
          console.error(`Failed to execute scheduled task: id=${task.id}, name=${task.name}`, e);
          // 增量写：task 是 listDue 的 T0 快照，整行回写会覆盖用户并发修改。
          // 运行行已存在时 executeTask 自己收敛，不会冒到这里。
          await this.store.updateById({
            id: task.id!,
            lastExecutionStatus: 'FAILED',
            nextFireTime: this.service.calculateNextFireTime(task.cronExpression!),
          });
        }
      }
      const retries = this.store.listDueRetries != null ? await this.store.listDueRetries(now) : [];
      for (const run of retries) {
        if (run.id == null) continue;
        const task = await this.store.selectById(run.taskId);
        if (task == null || task.status !== 'ACTIVE' || Number(task.finished ?? 0) === 1) {
          await this.store.clearRunRetry?.(run.id);
          continue;
        }
        try {
          await this.service.executeTask(task, { isRetry: true, fireTime: run.fireTime, runId: run.id });
        } catch (e) {
          console.error(`定时任务重试提交失败, taskId=${task.id}, runId=${run.id}`, e);
        }
      }
      this.scans += 1;
      if (this.scans % 60 === 0) {
        await this.service.reconcileStale().catch((e) => console.error('定时任务运行记录安全网失败', e));
      }
    } finally {
      this.scanning = false;
    }
  }
}

function isExecutorRejected(error: unknown): boolean {
  return error instanceof Error && error.name === 'AgentExecutorRejectedError';
}

function isDupKey(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false;
  const row = error as { code?: string; errno?: number };
  return row.code === 'ER_DUP_ENTRY' || row.errno === 1062;
}

function parseShanghaiDateTime(value: string): Date {
  return new Date(value.replace(' ', 'T') + '+08:00');
}

function elapsedMs(startedAt: string | null, finishedAt: string): number | null {
  if (startedAt == null || startedAt === '') return null;
  const start = Date.parse(startedAt.replace(' ', 'T') + '+08:00');
  const end = Date.parse(finishedAt.replace(' ', 'T') + '+08:00');
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

function clipError(value: string | null | undefined): string | null {
  if (value == null) return null;
  const text = value.trim();
  if (text.length === 0) return null;
  return text.length > 500 ? text.slice(0, 500) : text;
}

function normalizeRetryMax(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(Number(value))) return DEFAULT_RETRY_MAX;
  return Math.min(MAX_RETRY_MAX, Math.max(0, Math.trunc(Number(value))));
}

function normalizeRetryInterval(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(Number(value))) return DEFAULT_RETRY_INTERVAL_MINUTES;
  return Math.min(MAX_RETRY_INTERVAL_MINUTES, Math.max(MIN_RETRY_INTERVAL_MINUTES, Math.trunc(Number(value))));
}
