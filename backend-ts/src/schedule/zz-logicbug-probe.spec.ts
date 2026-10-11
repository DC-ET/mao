import { describe, expect, it, vi } from 'vitest';
import {
  ScheduledTaskScheduler,
  ScheduledTaskService,
  type ScheduledTask,
  type ScheduledTaskRun,
  type ScheduledTaskStore,
  type TaskFailureOutcome,
} from './scheduled-task.service.js';

/**
 * 回归（BUG-1）：一次性任务失败待重试期间被暂停，再从 PAUSED 重新启用（status=ACTIVE，
 * 不带 cronExpression）时，reactivate 分支曾绕过 pendingOnceRetry 守卫重开下一档，
 * 与重试入口（listDueRetries）重复执行同一任务。
 *
 * 修复把 pendingOnceRetry 判据提到 cronExpression 分支之外，对所有保存路径生效。
 * 对照组（带 cronExpression 保存）的不变量原由
 * scheduled-task-reliability.spec.ts「待重试的一次性任务原样保存 cron 不会再开一档」固化。
 */
class MemoryStore implements ScheduledTaskStore {
  tasks = new Map<number, ScheduledTask>();
  runs: ScheduledTaskRun[] = [];
  nextRunId = 1;

  constructor(task: ScheduledTask) { this.tasks.set(task.id!, { ...task }); }
  async insert(task: ScheduledTask): Promise<number> { task.id = 1; this.tasks.set(1, task); return 1; }
  async updateById(patch: Partial<ScheduledTask> & { id: number }): Promise<void> {
    const cur = this.tasks.get(patch.id);
    if (cur) Object.assign(cur, patch);
  }
  async deleteById(id: number): Promise<void> { const t = this.tasks.get(id); if (t) t.deleted = 1; }
  async selectById(id: number): Promise<ScheduledTask | null> {
    const t = this.tasks.get(id);
    if (t == null || t.deleted === 1) return null;
    return { ...t };
  }
  async listByUser(): Promise<ScheduledTask[]> { return []; }
  async listAll(): Promise<{ records: ScheduledTask[]; total: number }> { return { records: [], total: 0 }; }
  async listDue(now: string): Promise<ScheduledTask[]> {
    return [...this.tasks.values()].filter((t) => t.deleted !== 1 && t.status === 'ACTIVE' && t.finished !== 1 && t.nextFireTime != null && t.nextFireTime <= now);
  }
  async selectRunById(id: number): Promise<ScheduledTaskRun | null> {
    const r = this.runs.find((row) => row.id === id);
    return r ? { ...r } : null;
  }
  async selectRunByFire(taskId: number, fireTime: string): Promise<ScheduledTaskRun | null> {
    const r = this.runs.find((row) => row.taskId === taskId && row.fireTime === fireTime);
    return r ? { ...r } : null;
  }
  async insertRun(run: ScheduledTaskRun): Promise<number> {
    if (this.runs.some((row) => row.taskId === run.taskId && row.fireTime === run.fireTime)) {
      const e = new Error('dup') as Error & { code: string };
      e.code = 'ER_DUP_ENTRY';
      throw e;
    }
    const id = this.nextRunId++;
    this.runs.push({ ...run, id, attempt: run.attempt ?? 1 });
    return id;
  }
  async updateRun(run: Partial<ScheduledTaskRun> & { id: number }): Promise<void> {
    const cur = this.runs.find((row) => row.id === run.id);
    if (cur) Object.assign(cur, run);
  }
  async deleteUnstartedRun(taskId: number, fireTime: string): Promise<void> {
    this.runs = this.runs.filter((r) => !(r.taskId === taskId && r.fireTime === fireTime && r.status === 'RUNNING' && r.startedAt == null));
  }
  async beginRetry(runId: number): Promise<ScheduledTaskRun | null> {
    const r = this.runs.find((row) => row.id === runId && row.status === 'FAILED' && row.nextRetryAt != null);
    if (r == null) return null;
    r.attempt += 1; r.status = 'RUNNING'; r.nextRetryAt = null;
    return { ...r };
  }
  async clearRunRetry(runId: number): Promise<void> {
    const r = this.runs.find((row) => row.id === runId && row.status === 'FAILED');
    if (r) r.nextRetryAt = null;
  }
  async clearPendingRetries(taskId: number): Promise<void> {
    for (const r of this.runs) if (r.taskId === taskId) r.nextRetryAt = null;
  }
  async oldestQueuedRun(taskId: number): Promise<ScheduledTaskRun | null> {
    const q = this.runs.filter((r) => r.taskId === taskId && r.status === 'QUEUED').sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    return q[0] ? { ...q[0] } : null;
  }
  async hasPendingRetry(taskId: number): Promise<boolean> {
    return this.runs.some((r) => r.taskId === taskId && r.nextRetryAt != null);
  }
  async listRuns(taskId: number, limit: number): Promise<ScheduledTaskRun[]> {
    return this.runs.filter((r) => r.taskId === taskId).sort((a, b) => b.fireTime.localeCompare(a.fireTime)).slice(0, limit);
  }
  async listDueRetries(now: string): Promise<ScheduledTaskRun[]> {
    return this.runs.filter((r) => {
      const t = this.tasks.get(r.taskId);
      return r.status === 'FAILED' && r.nextRetryAt != null && r.nextRetryAt <= now
        && t != null && t.deleted !== 1 && t.status === 'ACTIVE' && t.finished !== 1;
    });
  }
  async listMissedTasks(before: string): Promise<ScheduledTask[]> {
    return [...this.tasks.values()].filter((t) => t.deleted !== 1 && t.status === 'ACTIVE' && t.finished !== 1 && t.nextFireTime != null && t.nextFireTime < before);
  }
  async insertMissedIgnore(run: Pick<ScheduledTaskRun, 'taskId' | 'fireTime' | 'sessionId'>): Promise<void> {
    if (this.runs.some((r) => r.taskId === run.taskId && r.fireTime === run.fireTime)) return;
    this.runs.push({ ...run, id: this.nextRunId++, attempt: 1, status: 'MISSED' });
  }
  async casNextFire(id: number, expected: string, nextFireTime: string | null, finish?: { finishedAt: string }): Promise<boolean> {
    const t = this.tasks.get(id);
    if (t == null || t.deleted === 1 || t.nextFireTime !== expected) return false;
    t.nextFireTime = nextFireTime;
    if (finish) { t.finished = 1; t.finishedAt = finish.finishedAt; t.nextFireTime = null; }
    return true;
  }
  async listOpenRuns(): Promise<ScheduledTaskRun[]> { return this.runs.filter((r) => r.status === 'RUNNING' || r.status === 'QUEUED').map((r) => ({ ...r })); }
  async listOpenRunsBySession(sessionId: number): Promise<ScheduledTaskRun[]> {
    return this.runs.filter((r) => r.sessionId === sessionId && (r.status === 'RUNNING' || r.status === 'QUEUED'));
  }
  async listStaleRuns(): Promise<ScheduledTaskRun[]> { return []; }
  async deleteRunsBefore(): Promise<void> { /* unused */ }
  async recordTaskOutcome(taskId: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED', _pauseAfter: number): Promise<TaskFailureOutcome | null> {
    if (phase === 'CANCELLED') return null;
    const t = this.tasks.get(taskId);
    if (t == null || t.deleted === 1) return null;
    if (phase === 'COMPLETED') { t.consecutiveFailures = 0; return { consecutiveFailures: 0, paused: false }; }
    if (t.status !== 'ACTIVE' || t.finished === 1) return null;
    const next = Number(t.consecutiveFailures ?? 0) + 1;
    t.consecutiveFailures = next;
    return { consecutiveFailures: next, paused: false };
  }
}

function serviceFor(store: MemoryStore, hooks?: { phase?: string; live?: () => Promise<void> }) {
  const phase = { value: hooks?.phase ?? 'IDLE' };
  const session = {
    getSession: vi.fn(async () => ({ id: 11, phase: phase.value, sessionType: 'NORMAL', userId: 7, agentId: 5 })),
    updatePhase: vi.fn(async (_id: number, next: string) => { phase.value = next; }),
    saveMessage: vi.fn(async () => ({ id: 88 })),
    getMessages: vi.fn(async () => []),
  };
  let ran: Promise<void> | null = null;
  const live = vi.fn(hooks?.live ?? (async () => { phase.value = 'COMPLETED'; }));
  const svc = new ScheduledTaskService(
    store,
    session as never,
    { enqueue: vi.fn(async () => undefined) } as never,
    { executeFromEvent: vi.fn() } as never,
    { finishExecution: vi.fn(async (_s: number, _u: number, next: string) => { phase.value = next; }) } as never,
    { sendText: vi.fn() } as never,
    { findByUserId: vi.fn() } as never,
    { findByAccountId: vi.fn() } as never,
    (fn) => { ran = Promise.resolve().then(() => fn()); },
    live as never,
  );
  return { svc, phase, run: () => ran };
}

const BASE: ScheduledTask = {
  id: 1, userId: 7, sessionId: 11, name: '日报', prompt: 'hello', cronExpression: '0 * * * * *',
  status: 'ACTIVE', once: 1, fireCount: 0, finished: 0, nextFireTime: '2026-10-09 09:00:00', retryMax: 2, retryIntervalMinutes: 5,
  missedPolicy: 'RUN_ONCE', consecutiveFailures: 0,
};

/** 一次性任务执行失败并排下次重试，随后被暂停（真实入口：连败自动暂停 / 手动暂停）。 */
async function makePausedPendingRetryOnceTask() {
  const store = new MemoryStore({ ...BASE });
  const { svc, phase, run } = serviceFor(store, { live: async () => { phase.value = 'FAILED'; } });
  await svc.executeTask({ ...(await store.selectById(1))! });
  await run();
  store.tasks.get(1)!.status = 'PAUSED';
  const t = await store.selectById(1);
  expect(t?.status).toBe('PAUSED');
  expect(t?.nextFireTime).toBeNull();
  expect(store.runs[0]?.nextRetryAt).toBeTruthy();
  return store;
}

describe('BUG-1 回归：一次性任务待重试期间重新启用不得重开档期', () => {
  it('B1 PAUSED→ACTIVE 重新启用（admin/桌面启停开关只发 { status }）不重开下一档', async () => {
    const store = await makePausedPendingRetryOnceTask();
    const { svc } = serviceFor(store);
    await svc.updateTask(1, 7, null, null, null, 'ACTIVE', null);
    const after = await store.selectById(1);
    console.log('B1 nextFireTime =', JSON.stringify(after?.nextFireTime), '（应为 null）');
    expect(after?.nextFireTime).toBeNull();
  });

  it('B2 对照组：带相同 cronExpression 保存时同样不重开', async () => {
    const store = await makePausedPendingRetryOnceTask();
    const { svc } = serviceFor(store);
    await svc.updateTask(1, 7, '日报', 'hello', '0 * * * * *', 'ACTIVE', true);
    const after = await store.selectById(1);
    expect(after?.nextFireTime).toBeNull();
  });

  it('B3 重试到期前 listDue 不命中该任务，只有 listDueRetries 一个入口', async () => {
    const store = await makePausedPendingRetryOnceTask();
    const { svc } = serviceFor(store);
    await svc.updateTask(1, 7, null, null, null, 'ACTIVE', null);
    expect((await store.selectById(1))?.nextFireTime).toBeNull();
    // 重试排在很远的将来：此刻两个入口都不该触发
    store.runs[0]!.nextRetryAt = '2099-01-01 00:00:00';
    expect(await store.listDue('2098-01-01 00:00:00')).toHaveLength(0);
    expect(await store.listDueRetries('2098-01-01 00:00:00')).toHaveLength(0);
    // 重试到期后只由重试入口驱动一次
    expect(await store.listDueRetries('2099-01-01 00:00:00')).toHaveLength(1);
    expect(await store.listDue('2099-01-01 00:00:00')).toHaveLength(0);
  });

  it('B4 agent 工具 update_scheduled_task 只回传 status=ACTIVE 同样不重开', async () => {
    const store = await makePausedPendingRetryOnceTask();
    const { svc } = serviceFor(store);
    // 工具层签名：updateTask(taskId, userId, name, prompt, cron, status, once)
    await svc.updateTask(1, 7, null, null, null, 'ACTIVE', null);
    expect((await store.selectById(1))?.nextFireTime).toBeNull();
  });

  it('B5 对照组：显式关掉一次性（once=0）后仍要按循环任务重开下一档', async () => {
    const store = await makePausedPendingRetryOnceTask();
    const { svc } = serviceFor(store);
    await svc.updateTask(1, 7, '日报', 'hello', '0 * * * * *', null, false);
    const after = await store.selectById(1);
    expect(after?.once).toBe(0);
    expect(after?.nextFireTime).not.toBeNull();
  });

  it('B6 对照组：没有待重试的一次性任务重新启用时正常重开下一档', async () => {
    const store = new MemoryStore({ ...BASE, nextFireTime: null, finished: 1 });
    const { svc } = serviceFor(store);
    await svc.updateTask(1, 7, null, null, null, 'ACTIVE', null);
    expect((await store.selectById(1))?.nextFireTime).not.toBeNull();
  });

  it('B7 扫描器在重试到期前不会执行该一次性任务', async () => {
    const store = await makePausedPendingRetryOnceTask();
    const { svc } = serviceFor(store);
    await svc.updateTask(1, 7, null, null, null, 'ACTIVE', null);
    store.runs[0]!.nextRetryAt = '2099-01-01 00:00:00';
    const scheduler = new ScheduledTaskScheduler(store, svc);
    await scheduler.scanAndExecute();
    // 只有一次 executeTask（初始化时那次），扫描没有新增触发
    expect(store.runs).toHaveLength(1);
  });
});
