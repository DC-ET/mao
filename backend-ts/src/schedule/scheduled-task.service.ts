import { Cron } from 'croner';
import { randomUUID } from 'node:crypto';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { formatDateTime } from '../common/json.js';
import { mpPage, type MpPage } from '../common/json.js';
import type { Message, Session } from '../domain/types.js';
import { WEIXIN_PROJECT_KEY } from '../domain/types.js';
import { isActivePhase } from '../session/session-vo.js';

export interface ScheduledTask {
  id?: number;
  userId?: number;
  agentId?: number;
  sessionId?: number;
  name?: string;
  prompt?: string;
  cronExpression?: string;
  status?: string;
  lastFireTime?: string | null;
  lastExecutionStatus?: string | null;
  nextFireTime?: string | null;
  fireCount?: number;
  finished?: number;
  finishedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  deleted?: number;
}

export interface ScheduledTaskStore {
  insert(task: ScheduledTask): Promise<number>;
  updateById(task: ScheduledTask): Promise<void>;
  deleteById(id: number): Promise<void>;
  selectById(id: number): Promise<ScheduledTask | null>;
  listByUser(userId: number): Promise<ScheduledTask[]>;
  listAll(pageNum: number, pageSize: number): Promise<{ records: ScheduledTask[]; total: number }>;
  listDue(now: string): Promise<ScheduledTask[]>;
}

export interface ScheduleSessionService {
  getSession(id: number): Promise<Session | null>;
  updatePhase(sessionId: number, phase: string): Promise<void>;
  saveMessage(sessionId: number, role: string, content: unknown, a: null, b: null, c: null, d: number, e: null): Promise<Message>;
  getMessages(sessionId: number): Promise<Message[]>;
}

export interface ScheduleMessageQueueService {
  enqueue(sessionId: number, userId: number, content: string, images: string | null): Promise<void>;
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
) => Promise<void>;

/** Spring cron uses `?` in DOM/DOW; Croner needs `*`. Also trim trailing spaces. */
export function normalizeSpringCron(expression: string): string {
  return expression.trim().replace(/\?/g, '*').replace(/\s+/g, ' ');
}

export interface ScheduleTaskTerminalService {
  finishExecution(sessionId: number, userId: number, phase: string, executionId: string, reason?: string): Promise<void>;
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

const sessionLocks = new Map<number, Promise<void>>();

async function withSessionLock<T>(sessionId: number, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((r) => { release = r; });
  sessionLocks.set(sessionId, prev.then(() => current));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (sessionLocks.get(sessionId) === current) {
      sessionLocks.delete(sessionId);
    }
  }
}

export class ScheduledTaskService {
  /** 正在排队/执行中的任务 id → 计数，防止锁等待期间重复触发连环补发。 */
  private readonly inFlight = new Set<number>();
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
  ) {}

  setLiveExecution(liveExecution: ScheduledLiveExecution | null): void {
    this.liveExecution = liveExecution;
  }

  setSessionBusyCheck(isSessionBusy: ((sessionId: number) => boolean) | null): void {
    this.isSessionBusy = isSessionBusy;
  }

  async createTask(userId: number, agentId: number, sessionId: number, name: string, prompt: string, cronExpression: string): Promise<ScheduledTask> {
    this.parseCron(cronExpression);
    const task: ScheduledTask = {
      userId, agentId, sessionId, name, prompt, cronExpression,
      status: 'ACTIVE', fireCount: 0,
      nextFireTime: this.calculateNextFireTime(cronExpression),
    };
    task.id = await this.store.insert(task);
    return task;
  }

  async updateTask(taskId: number, userId: number, name?: string | null, prompt?: string | null, cronExpression?: string | null, status?: string | null): Promise<ScheduledTask> {
    const task = await this.getTaskOwnedByUser(taskId, userId);
    if (name != null) task.name = name;
    if (prompt != null) task.prompt = prompt;
    if (status != null) {
      if (status !== 'ACTIVE' && status !== 'PAUSED') {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '状态只能为 ACTIVE 或 PAUSED');
      }
      task.status = status;
    }
    if (cronExpression != null) {
      this.parseCron(cronExpression);
      task.cronExpression = cronExpression;
      const next = this.calculateNextFireTime(cronExpression);
      task.nextFireTime = next;
      if (next != null) {
        task.finished = 0;
        task.finishedAt = null;
      }
    }
    if (task.status === 'ACTIVE' && task.nextFireTime == null) {
      const next = this.calculateNextFireTime(task.cronExpression!);
      task.nextFireTime = next;
      if (next != null) {
        task.finished = 0;
        task.finishedAt = null;
      }
    }
    await this.store.updateById(task);
    return task;
  }

  async deleteTask(taskId: number, userId: number): Promise<void> {
    const task = await this.getTaskOwnedByUser(taskId, userId);
    await this.store.deleteById(taskId);
    void task;
  }

  listByUser(userId: number): Promise<ScheduledTask[]> {
    return this.store.listByUser(userId);
  }

  async listAll(pageNum: number, pageSize: number): Promise<MpPage<ScheduledTask>> {
    const { records, total } = await this.store.listAll(pageNum, pageSize);
    return mpPage(records, total, pageNum, pageSize);
  }

  getById(taskId: number): Promise<ScheduledTask | null> {
    return this.store.selectById(taskId);
  }

  async executeTask(task: ScheduledTask): Promise<void> {
    // 在飞守卫：锁排队期间同一任务再次到期时直接跳过本次触发（nextFireTime 已推进，
    // 下个周期会正常调度），避免连环补发与 fireCount 竞态覆盖
    if (task.id != null && this.inFlight.has(task.id)) {
      return;
    }
    if (task.id != null) this.inFlight.add(task.id);
    try {
      task.nextFireTime = this.calculateNextFireTime(task.cronExpression!);
      await this.store.updateById(task);
      const executionId = randomUUID();
      const userId = task.userId!;
      this.agentExecutor(() => withSessionLock(task.sessionId!, async () => {
        let countThisRun = false;
        try {
          // 拿到锁后重读最新任务状态，排队期间可能已被更新/暂停/删除
          const latest = task.id != null ? await this.store.selectById(task.id) : null;
          if (latest == null) {
            return;
          }
          task.name = latest.name;
          task.prompt = latest.prompt ?? task.prompt;
          task.cronExpression = latest.cronExpression;
          task.status = latest.status;
          if (task.status != null && task.status !== 'ACTIVE') {
            return;
          }
          const session = await this.sessionService.getSession(task.sessionId!);
          if (session == null) {
            await this.markTaskResult(task, 'FAILED');
            countThisRun = true;
            return;
          }
          const phase = session.phase;
          const busy = this.isSessionBusy?.(task.sessionId!) === true || isActivePhase(phase);
          if (busy) {
            await this.messageQueueService.enqueue(task.sessionId!, userId, task.prompt!, null);
            await this.markTaskResult(task, 'QUEUED');
            countThisRun = true;
            return;
          }
          await this.sessionService.updatePhase(task.sessionId!, 'RUNNING');
          let savedMessage: Message;
          try {
            savedMessage = await this.sessionService.saveMessage(task.sessionId!, 'USER', task.prompt, null, null, null, 0, null);
          } catch {
            await this.sessionService.updatePhase(task.sessionId!, 'IDLE');
            await this.markTaskResult(task, 'FAILED');
            countThisRun = true;
            return;
          }
          if (this.liveExecution != null) {
            await this.liveExecution(session, userId, executionId, savedMessage);
          } else {
            await this.harnessService.executeFromEvent(task.sessionId!, executionId, {
              onContentDelta() {},
              onToolCallStart() {},
              onToolCallResult() {},
              onMessageEnd() {},
              onError() {},
            });
            await this.taskTerminalService.finishExecution(task.sessionId!, userId, 'COMPLETED', executionId);
          }
          await this.markTaskResult(task, 'COMPLETED');
          await this.sendWeixinReplyIfApplicable(task.sessionId!, userId);
          countThisRun = true;
        } catch (e) {
          countThisRun = true;
          try {
            await this.taskTerminalService.finishExecution(task.sessionId!, userId, 'FAILED', executionId,
              e instanceof Error ? e.message : String(e));
          } catch { /* ignore */ }
          await this.markTaskResult(task, 'FAILED');
        } finally {
          if (!countThisRun) return;
          task.lastFireTime = formatDateTime(new Date());
          task.fireCount = (task.fireCount ?? 0) + 1;
          if (task.lastExecutionStatus !== 'QUEUED' && this.calculateNextFireTime(task.cronExpression!) == null) {
            task.finished = 1;
            task.finishedAt = formatDateTime(new Date());
          }
          await this.store.updateById(task);
        }
      }));
    } finally {
      if (task.id != null) this.inFlight.delete(task.id);
    }
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

  private async markTaskResult(task: ScheduledTask, status: string): Promise<void> {
    task.lastExecutionStatus = status;
    await this.store.updateById(task);
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
      await this.weixinSendService.sendText(account.accountId, wxUserId, reply);
    } catch (e) {
      console.error('Error sending WeChat reply for scheduled task', e);
    }
  }

  private async getTaskOwnedByUser(taskId: number, userId: number): Promise<ScheduledTask> {
    const task = await this.store.selectById(taskId);
    if (task == null) {
      throw new BusinessException(ErrorCode.SCHEDULED_TASK_NOT_FOUND);
    }
    if (task.userId !== userId) {
      throw new BusinessException(ErrorCode.SCHEDULED_TASK_ACCESS_DENIED);
    }
    return task;
  }
}

export class ScheduledTaskScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: ScheduledTaskStore,
    private readonly service: ScheduledTaskService,
  ) {}

  start(): void {
    void this.scanAndExecute();
    this.timer = setInterval(() => { void this.scanAndExecute(); }, 60_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async scanAndExecute(): Promise<void> {
    const dueTasks = await this.store.listDue(formatDateTime(new Date()));
    if (dueTasks.length === 0) {
      return;
    }
    console.info(`Found ${dueTasks.length} due scheduled tasks`);
    for (const task of dueTasks) {
      try {
        await this.service.executeTask(task);
      } catch (e) {
        console.error(`Failed to execute scheduled task: id=${task.id}, name=${task.name}`, e);
        task.lastExecutionStatus = 'FAILED';
        task.nextFireTime = this.service.calculateNextFireTime(task.cronExpression!);
        await this.store.updateById(task);
      }
    }
  }
}
