import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { normalizeSpringCron, ScheduledTaskScheduler, ScheduledTaskService, type ScheduledTaskStore } from './scheduled-task.service.js';

describe('ScheduledTaskService', () => {
  const store: ScheduledTaskStore = {
    insert: vi.fn(async (t) => { t.id = 1; return 1; }),
    updateById: vi.fn(),
    deleteById: vi.fn(),
    selectById: vi.fn(),
    listByUser: vi.fn(async () => []),
    listAll: vi.fn(async () => ({ records: [], total: 0 })),
    listDue: vi.fn(async () => []),
  };
  const stubs = {
    getSession: vi.fn(),
    updatePhase: vi.fn(),
    saveMessage: vi.fn(),
    getMessages: vi.fn(),
  };
  const service = new ScheduledTaskService(
    store,
    stubs as never,
    { enqueue: vi.fn() },
    { executeFromEvent: vi.fn() },
    { finishExecution: vi.fn() },
    { sendText: vi.fn() },
    { findByUserId: vi.fn() },
    { findByAccountId: vi.fn() },
  );

  it('rejects invalid cron', async () => {
    await expect(service.createTask(1, 1, 1, 'n', 'p', 'not-a-cron')).rejects.toBeInstanceOf(BusinessException);
  });

  it('creates active task with next fire time', async () => {
    const task = await service.createTask(7, 5, 11, 'morning', 'hello', '0 0 9 * * *');
    expect(task.status).toBe('ACTIVE');
    expect(task.fireCount).toBe(0);
    expect(task.nextFireTime).toBeTruthy();
    expect(store.insert).toHaveBeenCalled();
  });

  it('acceptsSpringQuestionMarkCron', async () => {
    expect(normalizeSpringCron('0 0 9 * * ? ')).toBe('0 0 9 * * *');
    const task = await service.createTask(7, 5, 11, 'morning', 'hello', '0 0 9 * * ?');
    expect(task.nextFireTime).toBeTruthy();
  });

  it('denies update for other users', async () => {
    vi.mocked(store.selectById).mockResolvedValue({ id: 1, userId: 9, cronExpression: '0 0 9 * * *' });
    await expect(service.updateTask(1, 7, 'x', null, null, null)).rejects.toBeInstanceOf(BusinessException);
  });

  it('updates deletes lists and executes idle session', async () => {
    vi.mocked(store.selectById).mockResolvedValue({
      id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'PAUSED', fireCount: 0, prompt: 'hello',
    });
    const updated = await service.updateTask(1, 7, 'n', 'p', '0 0 10 * * *', 'ACTIVE');
    expect(updated.status).toBe('ACTIVE');
    await service.deleteTask(1, 7);
    expect(store.deleteById).toHaveBeenCalledWith(1);
    await service.listByUser(7);
    vi.mocked(store.listAll).mockResolvedValue({ records: [{ id: 1 }], total: 1 });
    expect((await service.listAll(1, 10)).total).toBe(1);
    expect(await service.getById(1)).toBeTruthy();

    stubs.getSession.mockResolvedValue({ id: 11, phase: 'IDLE', projectKey: 'weixin-bot' });
    stubs.getMessages.mockResolvedValue([{ role: 'ASSISTANT', content: 'done' }]);
    const weixinAccount = { findByUserId: vi.fn(async () => ({ accountId: 'acc' })) };
    const weixinToken = { findByAccountId: vi.fn(async () => [{ wxUserId: 'wx1' }]) };
    const send = { sendText: vi.fn(async () => true) };
    const harness = { executeFromEvent: vi.fn(async () => undefined) };
    const terminal = { finishExecution: vi.fn() };
    const queue = { enqueue: vi.fn() };
    let ran: Promise<void> | null = null;
    const svc = new ScheduledTaskService(
      store, stubs as never, queue, harness, terminal, send as never,
      weixinAccount as never, weixinToken as never,
      (fn) => { ran = Promise.resolve().then(fn); },
    );
    await svc.executeTask({
      id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', prompt: 'hello', fireCount: 0,
    });
    await ran;
    expect(harness.executeFromEvent).toHaveBeenCalled();
    expect(send.sendText).toHaveBeenCalled();
  });

  it('liveExecutionPushesThroughWsPathAndSkipsDummyFinish', async () => {
    stubs.getSession.mockResolvedValue({ id: 11, phase: 'IDLE' });
    stubs.saveMessage.mockResolvedValue({ id: 88, content: 'hello' });
    const live = vi.fn(async () => undefined);
    const harness = { executeFromEvent: vi.fn() };
    const terminal = { finishExecution: vi.fn() };
    let ran: Promise<void> | null = null;
    const svc = new ScheduledTaskService(
      store, stubs as never, { enqueue: vi.fn() }, harness, terminal, { sendText: vi.fn() } as never,
      { findByUserId: vi.fn(async () => null) } as never, { findByAccountId: vi.fn(async () => []) } as never,
      (fn) => { ran = Promise.resolve().then(fn); },
      live,
    );
    await svc.executeTask({
      id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', prompt: 'hello', fireCount: 0,
    });
    await ran;
    expect(live).toHaveBeenCalledWith(
      expect.objectContaining({ id: 11 }), 7, expect.any(String), expect.objectContaining({ id: 88 }),
    );
    expect(harness.executeFromEvent).not.toHaveBeenCalled();
    expect(terminal.finishExecution).not.toHaveBeenCalled();
  });

  it('queues when session is running and fails when missing', async () => {
    const harness = { executeFromEvent: vi.fn() };
    const terminal = { finishExecution: vi.fn() };
    const queue = { enqueue: vi.fn() };
    let ran: Promise<void> | null = null;
    const svc = new ScheduledTaskService(
      store, stubs as never, queue, harness, terminal, { sendText: vi.fn() } as never,
      { findByUserId: vi.fn(async () => null) } as never, { findByAccountId: vi.fn(async () => []) } as never,
      (fn) => { ran = Promise.resolve().then(fn); },
    );
    stubs.getSession.mockResolvedValue({ id: 11, phase: 'RUNNING' });
    await svc.executeTask({ id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', prompt: 'q', fireCount: 0 });
    await ran;
    expect(queue.enqueue).toHaveBeenCalled();
    stubs.getSession.mockResolvedValue(null);
    ran = null;
    await svc.executeTask({ id: 2, userId: 7, sessionId: 12, cronExpression: '0 0 9 * * *', prompt: 'q', fireCount: 0 });
    await ran;
    expect(store.updateById).toHaveBeenCalled();
  });

  it('skips a second trigger while the first execution is still in flight', async () => {
    let release!: () => void;
    const hang = new Promise<void>((r) => { release = r; });
    const live = vi.fn(async () => hang);
    const localStore: ScheduledTaskStore = {
      insert: vi.fn(),
      updateById: vi.fn(),
      deleteById: vi.fn(),
      selectById: vi.fn(async () => ({
        id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE', fireCount: 5, prompt: 'hello',
      })),
      listByUser: vi.fn(async () => []),
      listAll: vi.fn(async () => ({ records: [], total: 0 })),
      listDue: vi.fn(async () => []),
    };
    stubs.getSession.mockResolvedValue({ id: 11, phase: 'IDLE' });
    stubs.saveMessage.mockResolvedValue({ id: 88, content: 'hello' });
    let ran: Promise<void> | null = null;
    const svc = new ScheduledTaskService(
      localStore, stubs as never, { enqueue: vi.fn() }, { executeFromEvent: vi.fn() },
      { finishExecution: vi.fn() }, { sendText: vi.fn() } as never,
      { findByUserId: vi.fn(async () => null) } as never, { findByAccountId: vi.fn(async () => []) } as never,
      (fn) => { ran = Promise.resolve().then(fn); },
      live,
    );
    const task = { id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', prompt: 'hello', fireCount: 5 };
    await svc.executeTask(task);
    await vi.waitFor(() => expect(live).toHaveBeenCalledTimes(1));
    await svc.executeTask({ ...task, fireCount: 5 });
    release();
    await ran;
    expect(live).toHaveBeenCalledTimes(1);
    const persisted = vi.mocked(localStore.updateById).mock.calls.map(([row]) => row);
    expect(persisted.some((row) => row.fireCount === 6)).toBe(true);
  });

  it('scanAndExecute skips overlapping scans', async () => {
    let resolveList!: (v: Array<{ id: number }>) => void;
    const listDue = vi.fn(() => new Promise<Array<{ id: number }>>((r) => { resolveList = r; }));
    const executeTask = vi.fn(async () => undefined);
    const scheduler = new ScheduledTaskScheduler(
      { listDue, updateById: vi.fn() } as never,
      { executeTask } as never,
    );
    const first = scheduler.scanAndExecute();
    const second = scheduler.scanAndExecute();
    resolveList([]);
    await Promise.all([first, second]);
    expect(listDue).toHaveBeenCalledTimes(1);
    expect(executeTask).not.toHaveBeenCalled();
  });
});
