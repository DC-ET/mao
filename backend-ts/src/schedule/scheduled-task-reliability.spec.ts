import { Cron } from 'croner';
import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { sumCostMicros, wallClockMs } from '../session/run-window.js';
import { collectMissedPoints } from './scheduled-task-missed.js';
import {
  ScheduledTaskScheduler,
  ScheduledTaskService,
  type ScheduledTask,
  type ScheduledTaskRun,
  type ScheduledTaskStore,
  type TaskFailureOutcome,
} from './scheduled-task.service.js';

describe('collectMissedPoints', () => {
  it('补跑目标是窗口内最后一点，更早的点留在列表里', () => {
    const cron = new Cron('0 0 9 * * *', { timezone: 'Asia/Shanghai' });
    const from = new Date('2026-10-07T01:00:00Z'); // 上海 09:00
    const now = new Date('2026-10-09T02:00:00Z'); // 上海 10:00，跨过 8 日和 9 日 9 点
    const collected = collectMissedPoints(cron, from, now);
    const labels = collected.points.map((point) => point.toISOString());
    expect(labels[0]).toBe(from.toISOString());
    expect(collected.latest?.toISOString()).toBe('2026-10-09T01:00:00.000Z');
    expect(collected.points.filter((point) => point.getTime() !== collected.latest!.getTime())).toHaveLength(2);
    expect(collected.truncated).toBe(0);
  });

  it('遍历上限截断后仍然定位到最后一个触发点', () => {
    const cron = new Cron('0 * * * * *', { timezone: 'Asia/Shanghai' });
    const from = new Date('2026-10-09T01:00:00Z');
    const now = new Date('2026-10-09T01:30:00Z');
    const collected = collectMissedPoints(cron, from, now, { maxPersist: 3, maxWalk: 5 });
    expect(collected.latest?.toISOString()).toBe('2026-10-09T01:29:00.000Z');
    expect(collected.points).toHaveLength(4);
    expect(collected.truncated).toBeGreaterThan(0);
    expect(collected.points[collected.points.length - 1]).toBe(collected.latest);
  });
});

describe('sumCostMicros / wallClockMs', () => {
  it('空窗口和未配价都是 null；墙钟空集是 0', () => {
    expect(sumCostMicros([])).toBeNull();
    expect(sumCostMicros([{ costMicros: 1 }, { costMicros: null }])).toBeNull();
    expect(sumCostMicros([{ costMicros: 2 }, { costMicros: 3 }])).toBe(5);
    expect(wallClockMs([])).toBe(0);
  });
});

class MemoryStore implements ScheduledTaskStore {
  tasks = new Map<number, ScheduledTask>();
  runs: ScheduledTaskRun[] = [];
  nextRunId = 1;

  constructor(task: ScheduledTask) {
    this.tasks.set(task.id!, { ...task });
  }

  async insert(task: ScheduledTask): Promise<number> {
    task.id = 1;
    this.tasks.set(1, task);
    return 1;
  }
  async updateById(patch: Partial<ScheduledTask> & { id: number }): Promise<void> {
    const current = this.tasks.get(patch.id);
    if (current) Object.assign(current, patch);
  }
  async deleteById(id: number): Promise<void> {
    const current = this.tasks.get(id);
    if (current) current.deleted = 1;
  }
  async selectById(id: number): Promise<ScheduledTask | null> {
    const task = this.tasks.get(id);
    if (task == null || task.deleted === 1) return null;
    return { ...task };
  }
  async listByUser(): Promise<ScheduledTask[]> { return []; }
  async listAll(): Promise<{ records: ScheduledTask[]; total: number }> { return { records: [], total: 0 }; }
  async listDue(now: string): Promise<ScheduledTask[]> {
    return [...this.tasks.values()].filter((task) => task.deleted !== 1 && task.status === 'ACTIVE' && task.finished !== 1 && task.nextFireTime != null && task.nextFireTime <= now);
  }
  async selectRunById(id: number): Promise<ScheduledTaskRun | null> {
    const run = this.runs.find((row) => row.id === id);
    return run ? { ...run } : null;
  }
  async selectRunByFire(taskId: number, fireTime: string): Promise<ScheduledTaskRun | null> {
    const run = this.runs.find((row) => row.taskId === taskId && row.fireTime === fireTime);
    return run ? { ...run } : null;
  }
  async insertRun(run: ScheduledTaskRun): Promise<number> {
    if (this.runs.some((row) => row.taskId === run.taskId && row.fireTime === run.fireTime)) {
      const error = new Error('dup') as Error & { code: string };
      error.code = 'ER_DUP_ENTRY';
      throw error;
    }
    const id = this.nextRunId++;
    this.runs.push({ ...run, id, attempt: run.attempt ?? 1 });
    return id;
  }
  async updateRun(run: Partial<ScheduledTaskRun> & { id: number }): Promise<void> {
    const current = this.runs.find((row) => row.id === run.id);
    if (current) Object.assign(current, run);
  }
  async deleteUnstartedRun(taskId: number, fireTime: string): Promise<void> {
    this.runs = this.runs.filter((row) => !(row.taskId === taskId && row.fireTime === fireTime && row.status === 'RUNNING' && row.startedAt == null));
  }
  async beginRetry(runId: number): Promise<ScheduledTaskRun | null> {
    const run = this.runs.find((row) => row.id === runId && row.status === 'FAILED' && row.nextRetryAt != null);
    if (run == null) return null;
    run.attempt += 1;
    run.status = 'RUNNING';
    run.messageId = null;
    run.startedAt = null;
    run.finishedAt = null;
    run.durationMs = null;
    run.costMicros = null;
    run.errorSummary = null;
    run.nextRetryAt = null;
    return { ...run };
  }
  async clearRunRetry(runId: number): Promise<void> {
    const run = this.runs.find((row) => row.id === runId && row.status === 'FAILED');
    if (run) run.nextRetryAt = null;
  }
  async clearPendingRetries(taskId: number): Promise<void> {
    for (const run of this.runs) {
      if (run.taskId === taskId) run.nextRetryAt = null;
    }
  }
  async oldestQueuedRun(taskId: number): Promise<ScheduledTaskRun | null> {
    const queued = this.runs.filter((row) => row.taskId === taskId && row.status === 'QUEUED').sort((a, b) => {
      const aq = a.queueSeq ?? Number.MAX_SAFE_INTEGER;
      const bq = b.queueSeq ?? Number.MAX_SAFE_INTEGER;
      if (aq !== bq) return aq - bq;
      return (a.id ?? 0) - (b.id ?? 0);
    });
    return queued[0] ? { ...queued[0] } : null;
  }
  async hasPendingRetry(taskId: number): Promise<boolean> {
    return this.runs.some((row) => row.taskId === taskId && row.nextRetryAt != null);
  }
  async listRuns(taskId: number, limit: number): Promise<ScheduledTaskRun[]> {
    return this.runs.filter((row) => row.taskId === taskId).sort((a, b) => b.fireTime.localeCompare(a.fireTime)).slice(0, limit);
  }
  async listDueRetries(now: string): Promise<ScheduledTaskRun[]> {
    return this.runs.filter((run) => {
      const task = this.tasks.get(run.taskId);
      return run.status === 'FAILED' && run.nextRetryAt != null && run.nextRetryAt <= now
        && task != null && task.deleted !== 1 && task.status === 'ACTIVE' && task.finished !== 1;
    });
  }
  async listMissedTasks(before: string): Promise<ScheduledTask[]> {
    return [...this.tasks.values()].filter((task) => task.deleted !== 1 && task.status === 'ACTIVE' && task.finished !== 1 && task.nextFireTime != null && task.nextFireTime < before);
  }
  async insertMissedIgnore(run: Pick<ScheduledTaskRun, 'taskId' | 'fireTime' | 'sessionId'>): Promise<void> {
    if (this.runs.some((row) => row.taskId === run.taskId && row.fireTime === run.fireTime)) return;
    this.runs.push({ ...run, id: this.nextRunId++, attempt: 1, status: 'MISSED' });
  }
  async casNextFire(id: number, expected: string, nextFireTime: string | null, finish?: { finishedAt: string }): Promise<boolean> {
    const task = this.tasks.get(id);
    if (task == null || task.deleted === 1 || task.nextFireTime !== expected) return false;
    task.nextFireTime = nextFireTime;
    if (finish) {
      task.finished = 1;
      task.finishedAt = finish.finishedAt;
      task.nextFireTime = null;
    }
    return true;
  }
  async listOpenRuns(): Promise<ScheduledTaskRun[]> {
    return this.runs.filter((row) => row.status === 'RUNNING' || row.status === 'QUEUED').map((row) => ({ ...row }));
  }
  async listOpenRunsBySession(sessionId: number): Promise<ScheduledTaskRun[]> {
    return this.runs.filter((row) => row.sessionId === sessionId && (row.status === 'RUNNING' || row.status === 'QUEUED'));
  }
  async listStaleRuns(): Promise<ScheduledTaskRun[]> { return []; }
  async deleteRunsBefore(): Promise<void> { /* unused */ }
  async recordTaskOutcome(taskId: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED', pauseAfter: number): Promise<TaskFailureOutcome | null> {
    if (phase === 'CANCELLED') return null;
    const task = this.tasks.get(taskId);
    if (task == null || task.deleted === 1) return null;
    if (phase === 'COMPLETED') {
      task.consecutiveFailures = 0;
      return { consecutiveFailures: 0, paused: false };
    }
    if (task.status !== 'ACTIVE' || task.finished === 1) return null;
    const next = Number(task.consecutiveFailures ?? 0) + 1;
    task.consecutiveFailures = next;
    const paused = next >= pauseAfter;
    if (paused) task.status = 'PAUSED';
    return { consecutiveFailures: next, paused };
  }
}

function serviceFor(store: MemoryStore, hooks?: {
  phase?: string;
  live?: () => Promise<void>;
  save?: () => Promise<{ id: number }>;
  executor?: (fn: () => Promise<void>) => void;
  getSession?: () => Promise<unknown>;
}) {
  const phase = { value: hooks?.phase ?? 'IDLE' };
  const session = {
    getSession: vi.fn(hooks?.getSession ?? (async () => ({ id: 11, phase: phase.value, sessionType: 'NORMAL', userId: 7, agentId: 5 }))),
    updatePhase: vi.fn(async (_id: number, next: string) => { phase.value = next; }),
    saveMessage: vi.fn(hooks?.save ?? (async () => ({ id: 88 }))),
    getMessages: vi.fn(async () => []),
  };
  let ran: Promise<void> | null = null;
  const live = vi.fn(hooks?.live ?? (async () => { phase.value = 'COMPLETED'; }));
  const notify = vi.fn(async () => undefined);
  const enqueue = vi.fn(async () => undefined);
  const svc = new ScheduledTaskService(
    store,
    session as never,
    { enqueue } as never,
    { executeFromEvent: vi.fn() } as never,
    { finishExecution: vi.fn(async (_s: number, _u: number, next: string) => { phase.value = next; }) } as never,
    { sendText: vi.fn() } as never,
    { findByUserId: vi.fn() } as never,
    { findByAccountId: vi.fn() } as never,
    hooks?.executor ?? ((fn) => { ran = Promise.resolve().then(() => fn()); }),
    live as never,
  );
  svc.setFailureNotifier(notify);
  return { svc, session, phase, live, notify, enqueue, run: () => ran };
}

const BASE: ScheduledTask = {
  id: 1, userId: 7, sessionId: 11, name: '日报', prompt: 'hello', cronExpression: '0 0 9 * * *',
  status: 'ACTIVE', once: 0, fireCount: 0, finished: 0, nextFireTime: '2026-10-09 09:00:00', retryMax: 2, retryIntervalMinutes: 5,
  missedPolicy: 'RUN_ONCE', consecutiveFailures: 0,
};

describe('定时任务可靠性', () => {
  it('可重试失败会排下一次，且不增加触发次数；同一次触发的多次失败只计 1 次连败', async () => {
    const store = new MemoryStore({ ...BASE });
    const { svc, phase, run } = serviceFor(store, { live: async () => { phase.value = 'FAILED'; } });
    await svc.executeTask({ ...BASE });
    await run();
    const task = await store.selectById(1);
    expect(task?.fireCount).toBe(1);
    expect(task?.consecutiveFailures).toBe(0);
    expect(task?.status).toBe('ACTIVE');
    const row = store.runs[0]!;
    expect(row.status).toBe('FAILED');
    expect(row.attempt).toBe(1);
    expect(row.nextRetryAt).toBeTruthy();

    row.nextRetryAt = '2000-01-01 00:00:00';
    const scheduler = new ScheduledTaskScheduler(store, svc);
    await scheduler.scanAndExecute();
    await run();
    expect((await store.selectById(1))?.fireCount).toBe(1);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]?.attempt).toBe(2);
    expect((await store.selectById(1))?.consecutiveFailures).toBe(0);
  });

  it('重试耗尽后才给连败 +1，三次触发点失败后暂停并只通知一次', async () => {
    const store = new MemoryStore({ ...BASE, retryMax: 0 });
    const { svc, phase, notify, run } = serviceFor(store, { live: async () => { phase.value = 'FAILED'; } });
    for (let i = 0; i < 3; i++) {
      const current = await store.selectById(1);
      current!.nextFireTime = `2026-10-0${i + 1} 09:00:00`;
      await svc.executeTask({ ...current! });
      await run();
    }
    const task = await store.selectById(1);
    expect(task?.consecutiveFailures).toBe(3);
    expect(task?.status).toBe('PAUSED');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('预算拦截不重试，但计入连败', async () => {
    const store = new MemoryStore({ ...BASE });
    const { svc, run } = serviceFor(store);
    svc.setBudgetCheck(async () => ({ message: '超限' }));
    await svc.executeTask({ ...BASE });
    await run();
    expect(store.runs[0]?.nextRetryAt).toBeNull();
    expect(store.runs[0]?.status).toBe('FAILED');
    expect((await store.selectById(1))?.consecutiveFailures).toBe(1);
  });

  it('一次性任务失败后待重试期间不会被下一档再次触发', async () => {
    const store = new MemoryStore({ ...BASE, once: 1, cronExpression: '0 * * * * *' });
    const { svc, phase, run } = serviceFor(store, { live: async () => { phase.value = 'FAILED'; } });
    await svc.executeTask({ ...BASE, once: 1, cronExpression: '0 * * * * *', nextFireTime: '2026-10-09 09:00:00' });
    await run();
    const task = await store.selectById(1);
    expect(task?.finished).toBe(0);
    expect(task?.nextFireTime).toBeNull();
    expect(store.runs[0]?.nextRetryAt).toBeTruthy();
    expect(await store.listDue('2099-01-01 00:00:00')).toHaveLength(0);
  });

  it('没有到期任务时仍然捞起重试', async () => {
    const store = new MemoryStore({ ...BASE, nextFireTime: '2099-01-01 00:00:00' });
    store.runs.push({
      id: 9, taskId: 1, fireTime: '2026-10-09 09:00:00', attempt: 1, status: 'FAILED', sessionId: 11, nextRetryAt: '2000-01-01 00:00:00',
    });
    const { svc, phase, run } = serviceFor(store, { live: async () => { phase.value = 'COMPLETED'; } });
    const scheduler = new ScheduledTaskScheduler(store, svc);
    await scheduler.scanAndExecute();
    await run();
    expect(store.runs.find((row) => row.id === 9)?.status).toBe('COMPLETED');
    expect(store.runs.find((row) => row.id === 9)?.attempt).toBe(2);
  });

  it('RUN_ONCE 只把最后一点留给定时器，更早的点记为错过且不覆盖已有行', async () => {
    const store = new MemoryStore({
      ...BASE,
      nextFireTime: '2026-10-07 09:00:00',
      cronExpression: '0 0 9 * * *',
    });
    store.runs.push({
      id: 3, taskId: 1, fireTime: '2026-10-08 09:00:00', attempt: 1, status: 'COMPLETED', sessionId: 11,
    });
    const { svc } = serviceFor(store);
    await svc.compensateMissed(new Date('2026-10-09T02:30:00Z'));
    const missed = store.runs.filter((row) => row.status === 'MISSED').map((row) => row.fireTime);
    expect(missed).toContain('2026-10-07 09:00:00');
    expect(missed).not.toContain('2026-10-09 09:00:00');
    expect(store.runs.find((row) => row.fireTime === '2026-10-08 09:00:00')?.status).toBe('COMPLETED');
    expect((await store.selectById(1))?.nextFireTime).toBe('2026-10-09 09:00:00');
  });

  it('SKIP 全部记错过，一次性任务就此完结', async () => {
    const store = new MemoryStore({
      ...BASE, once: 1, missedPolicy: 'SKIP', nextFireTime: '2026-10-09 09:00:00', cronExpression: '0 0 9 * * *',
    });
    const { svc } = serviceFor(store);
    await svc.compensateMissed(new Date('2026-10-09T02:30:00Z'));
    expect(store.runs.map((row) => row.status)).toEqual(['MISSED']);
    const task = await store.selectById(1);
    expect(task?.finished).toBe(1);
    expect(task?.nextFireTime).toBeNull();
  });

  it('暂停会取消未开始的重试，再次保存已启用任务不清零', async () => {
    const store = new MemoryStore({ ...BASE, consecutiveFailures: 2 });
    store.runs.push({
      id: 4, taskId: 1, fireTime: '2026-10-09 09:00:00', attempt: 1, status: 'FAILED', sessionId: 11, nextRetryAt: '2099-01-01 00:00:00',
    });
    const { svc } = serviceFor(store);
    await svc.updateTask(1, 7, null, null, null, 'PAUSED');
    expect(store.runs[0]?.nextRetryAt).toBeNull();
    await svc.updateTask(1, 7, '日报', null, null, 'ACTIVE');
    expect((await store.selectById(1))?.consecutiveFailures).toBe(0);
    await svc.updateTask(1, 7, '日报改名', null, null, 'ACTIVE');
    expect((await store.selectById(1))?.consecutiveFailures).toBe(0);
  });

  it('已有终态行时不会再开跑同一触发点', async () => {
    const store = new MemoryStore({ ...BASE });
    store.runs.push({
      id: 8, taskId: 1, fireTime: '2026-10-09 09:00:00', attempt: 1, status: 'COMPLETED', sessionId: 11,
    });
    const { svc, live, run } = serviceFor(store);
    await svc.executeTask({ ...BASE });
    await run();
    expect(live).not.toHaveBeenCalled();
    expect((await store.selectById(1))?.nextFireTime).toBe('2026-10-09 09:00:00');
  });

  it('错过行会被补跑接管成运行中，而不是停在错过', async () => {
    const store = new MemoryStore({ ...BASE });
    store.runs.push({
      id: 6, taskId: 1, fireTime: '2026-10-09 09:00:00', attempt: 1, status: 'MISSED', sessionId: 11,
    });
    const { svc, phase, run } = serviceFor(store, { live: async () => { phase.value = 'COMPLETED'; } });
    await svc.executeTask({ ...BASE });
    await run();
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]?.status).toBe('COMPLETED');
    expect(store.runs[0]?.id).toBe(6);
  });

  it('崩溃恢复会收回一次性任务已经推进的下一档', async () => {
    const store = new MemoryStore({
      ...BASE, once: 1, retryMax: 2, cronExpression: '0 * * * * *', nextFireTime: '2026-10-09 09:01:00',
    });
    store.runs.push({
      id: 1, taskId: 1, fireTime: '2026-10-09 09:00:00', attempt: 1, status: 'RUNNING', sessionId: 11, startedAt: '2026-10-09 09:00:01',
    });
    const { svc } = serviceFor(store);
    await svc.reconcileRunsForSession(11, 'FAILED');
    expect(store.runs[0]?.nextRetryAt).toBeTruthy();
    expect((await store.selectById(1))?.nextFireTime).toBeNull();
    expect((await store.selectById(1))?.finished).toBe(0);

    store.runs[0] = {
      id: 1, taskId: 1, fireTime: '2026-10-09 09:00:00', attempt: 1, status: 'RUNNING', sessionId: 11, startedAt: '2026-10-09 09:00:01', nextRetryAt: null,
    };
    const stored = store.tasks.get(1)!;
    stored.nextFireTime = '2026-10-09 09:01:00';
    stored.finished = 0;
    await svc.reconcileRunsForSession(11, 'COMPLETED');
    expect((await store.selectById(1))?.finished).toBe(1);
    expect((await store.selectById(1))?.nextFireTime).toBeNull();
  });

  it('连败暂停和一次性耗尽同时发生时任务仍然完结', async () => {
    const store = new MemoryStore({
      ...BASE, once: 1, retryMax: 0, consecutiveFailures: 2, cronExpression: '0 * * * * *', nextFireTime: '2026-10-09 09:00:00',
    });
    const { svc, phase, run } = serviceFor(store, { live: async () => { phase.value = 'FAILED'; } });
    await svc.executeTask({ ...(await store.selectById(1))! });
    await run();
    const task = await store.selectById(1);
    expect(task?.status).toBe('PAUSED');
    expect(task?.consecutiveFailures).toBe(3);
    expect(task?.finished).toBe(1);
    expect(task?.nextFireTime).toBeNull();
  });

  it('启动收敛不把还没消费的排队行收成会话上一轮终态', async () => {
    const store = new MemoryStore({ ...BASE, nextFireTime: '2026-10-09 09:02:00' });
    store.runs.push({
      id: 1, taskId: 1, fireTime: '2026-10-09 09:00:00', attempt: 1, status: 'QUEUED', sessionId: 11,
    });
    const { svc, phase } = serviceFor(store);
    phase.value = 'FAILED';
    await svc.reconcileOnStartup(true);
    expect(store.runs[0]?.status).toBe('QUEUED');
    await svc.settleQueuedExecution(1, 'FAILED');
    expect(store.runs[0]?.status).toBe('FAILED');
    expect(store.runs[0]?.errorSummary).toBe('排队执行失败');
    expect(store.runs[0]?.nextRetryAt).toBeTruthy();
  });

  it('后入队的重试不会抢走先入队那次排队的结算', async () => {
    const store = new MemoryStore({ ...BASE, nextFireTime: '2099-01-01 00:00:00' });
    store.nextRunId = 3;
    store.runs.push({
      id: 2, taskId: 1, fireTime: '2026-10-09 09:01:00', attempt: 1, status: 'QUEUED', sessionId: 11, queueSeq: 1,
    });
    store.runs.push({
      id: 1, taskId: 1, fireTime: '2026-10-09 09:00:00', attempt: 1, status: 'FAILED', sessionId: 11, nextRetryAt: '2000-01-01 00:00:00',
    });
    const { svc, phase, enqueue, run } = serviceFor(store);
    phase.value = 'RUNNING';
    const scheduler = new ScheduledTaskScheduler(store, svc);
    await scheduler.scanAndExecute();
    await run();
    expect(enqueue).toHaveBeenCalledTimes(1);
    await svc.settleQueuedExecution(1, 'FAILED');
    expect(store.runs.find((row) => row.id === 2)?.status).toBe('FAILED');
    expect(store.runs.find((row) => row.id === 1)?.status).toBe('QUEUED');
  });

  it('待重试的一次性任务原样保存 cron 不会再开一档', async () => {
    const store = new MemoryStore({
      ...BASE, once: 1, retryMax: 2, cronExpression: '0 * * * * *', nextFireTime: '2026-10-09 09:00:00',
    });
    const { svc, phase, run } = serviceFor(store, { live: async () => { phase.value = 'FAILED'; } });
    await svc.executeTask({ ...(await store.selectById(1))! });
    await run();
    expect((await store.selectById(1))?.nextFireTime).toBeNull();
    await svc.updateTask(1, 7, '日报', 'hello', '0 * * * * *', null, true);
    expect((await store.selectById(1))?.nextFireTime).toBeNull();
    expect(store.runs[0]?.nextRetryAt).toBeTruthy();
    expect(await store.listDue('2099-01-01 00:00:00')).toHaveLength(0);
  });

  it('待重试时关掉一次性并保存，重试成功后仍有下一档', async () => {
    const store = new MemoryStore({
      ...BASE, once: 1, retryMax: 2, cronExpression: '0 * * * * *', nextFireTime: '2026-10-09 09:00:00',
    });
    const outcome = { value: 'FAILED' };
    const { svc, phase, run } = serviceFor(store, { live: async () => { phase.value = outcome.value; } });
    await svc.executeTask({ ...(await store.selectById(1))! });
    await run();
    expect((await store.selectById(1))?.nextFireTime).toBeNull();
    await svc.updateTask(1, 7, '日报', 'hello', '0 * * * * *', null, false);
    expect((await store.selectById(1))?.once).toBe(0);
    expect((await store.selectById(1))?.nextFireTime).not.toBeNull();
    outcome.value = 'COMPLETED';
    store.runs[0]!.nextRetryAt = '2000-01-01 00:00:00';
    phase.value = 'IDLE';
    await new ScheduledTaskScheduler(store, svc).scanAndExecute();
    await run();
    expect(store.runs[0]?.status).toBe('COMPLETED');
    expect((await store.selectById(1))?.nextFireTime).not.toBeNull();
    expect((await store.selectById(1))?.finished).toBe(0);
  });

  it('启动收敛会把会话已删除的排队行收成失败并停掉任务', async () => {
    const store = new MemoryStore({ ...BASE, once: 1, nextFireTime: null, cronExpression: '0 * * * * *' });
    store.runs.push({
      id: 1, taskId: 1, fireTime: '2026-10-09 09:00:00', attempt: 1, status: 'QUEUED', sessionId: 11,
    });
    const { svc } = serviceFor(store, {
      getSession: async () => { throw new BusinessException(ErrorCode.SESSION_NOT_FOUND); },
    });
    await svc.reconcileOnStartup(true);
    expect(store.runs[0]?.status).toBe('FAILED');
    expect(store.runs[0]?.errorSummary).toBe('会话已删除');
    expect((await store.selectById(1))?.finished).toBe(1);
    expect((await store.selectById(1))?.nextFireTime).toBeNull();
  });
});
