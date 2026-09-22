import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { isOneShotCron, normalizeSpringCron, ScheduledTaskScheduler, ScheduledTaskService, type ScheduledTaskStore } from './scheduled-task.service.js';

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
    await expect(service.deleteTask(1, 7)).rejects.toBeInstanceOf(BusinessException);
  });

  it('allows admin update/delete for other users with allowNonOwner', async () => {
    vi.mocked(store.selectById).mockResolvedValue({
      id: 1, userId: 9, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE', fireCount: 0, prompt: 'hello',
    });
    const updated = await service.updateTask(1, 7, null, null, null, 'PAUSED', null, { allowNonOwner: true });
    expect(updated.status).toBe('PAUSED');
    expect(store.updateById).toHaveBeenCalled();
    await service.deleteTask(1, 7, { allowNonOwner: true });
    expect(store.deleteById).toHaveBeenCalledWith(1);
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
    await service.listAll(1, 10, { keyword: 'kw', userId: 7, agentId: 5, status: 'PAUSED', finished: false });
    expect(store.listAll).toHaveBeenLastCalledWith(1, 10, { keyword: 'kw', userId: 7, agentId: 5, status: 'PAUSED', finished: false });
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

  it('saves scheduled prompt with trigger envelope so agent executes instead of re-creating', async () => {
    const localStubs = {
      getSession: vi.fn(async () => ({ id: 11, phase: 'IDLE' })),
      updatePhase: vi.fn(),
      saveMessage: vi.fn(async () => ({ id: 88, content: 'hello' })),
      getMessages: vi.fn(async () => []),
    };
    const localStore: ScheduledTaskStore = {
      insert: vi.fn(),
      updateById: vi.fn(),
      deleteById: vi.fn(),
      selectById: vi.fn(async () => ({
        id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE', name: 'daily', prompt: 'hello', fireCount: 0,
      })),
      listByUser: vi.fn(async () => []),
      listAll: vi.fn(async () => ({ records: [], total: 0 })),
      listDue: vi.fn(async () => []),
    };
    let ran: Promise<void> | null = null;
    const svc = new ScheduledTaskService(
      localStore, localStubs as never, { enqueue: vi.fn() }, { executeFromEvent: vi.fn() }, { finishExecution: vi.fn() },
      { sendText: vi.fn() } as never,
      { findByUserId: vi.fn(async () => null) } as never, { findByAccountId: vi.fn(async () => []) } as never,
      (fn) => { ran = Promise.resolve().then(fn); },
    );
    await svc.executeTask({ id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', name: 'daily', prompt: 'hello', fireCount: 0 });
    await ran;
    const savedContent = String(vi.mocked(localStubs.saveMessage).mock.calls[0][2]);
    expect(savedContent).toContain('定时任务「daily」');
    expect(savedContent).toContain('不要创建、修改、暂停或删除任何定时任务');
    expect(savedContent).toContain('---\nhello');
  });

  it('auto-finishes one-shot task after a single run', async () => {
    const localStubs = {
      getSession: vi.fn(async () => ({ id: 11, phase: 'IDLE' })),
      updatePhase: vi.fn(),
      saveMessage: vi.fn(async () => ({ id: 88, content: 'hello' })),
      getMessages: vi.fn(async () => []),
    };
    const localStore: ScheduledTaskStore = {
      insert: vi.fn(),
      updateById: vi.fn(),
      deleteById: vi.fn(),
      selectById: vi.fn(async () => ({
        id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 8 15 8 ?', status: 'ACTIVE',
        name: '提醒', prompt: 'hello', once: 1, fireCount: 0,
      })),
      listByUser: vi.fn(async () => []),
      listAll: vi.fn(async () => ({ records: [], total: 0 })),
      listDue: vi.fn(async () => []),
    };
    let ran: Promise<void> | null = null;
    const svc = new ScheduledTaskService(
      localStore, localStubs as never, { enqueue: vi.fn() }, { executeFromEvent: vi.fn() }, { finishExecution: vi.fn() },
      { sendText: vi.fn() } as never,
      { findByUserId: vi.fn(async () => null) } as never, { findByAccountId: vi.fn(async () => []) } as never,
      (fn) => { ran = Promise.resolve().then(fn); },
    );
    await svc.executeTask({ id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 8 15 8 ?', prompt: 'hello', fireCount: 0 });
    await ran;
    const persisted = vi.mocked(localStore.updateById).mock.calls.map(([row]) => row);
    const final = persisted.at(-1)!;
    expect(final.finished).toBe(1);
    expect(final.finishedAt).toBeTruthy();
    expect(final.nextFireTime).toBeNull();
  });

  it('reclassifies once when the cron shape changes and once is omitted', async () => {
    vi.mocked(store.selectById).mockResolvedValue({
      id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE', once: 0, fireCount: 0, prompt: 'hello',
    });
    const toOneShot = await service.updateTask(1, 7, null, null, '0 0 8 15 8 ?');
    expect(toOneShot.once).toBe(1);

    vi.mocked(store.selectById).mockResolvedValue({
      id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 8 15 8 ?', status: 'ACTIVE', once: 1, fireCount: 0, prompt: 'hello',
    });
    const toDaily = await service.updateTask(1, 7, null, null, '0 0 9 * * *');
    expect(toDaily.once).toBe(0);
  });

  it('keeps an explicit once flag when the cron shape would say otherwise', async () => {
    vi.mocked(store.selectById).mockResolvedValue({
      id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE', once: 0, fireCount: 0, prompt: 'hello',
    });
    const updated = await service.updateTask(1, 7, null, null, '0 0 8 15 8 ?', null, false);
    expect(updated.once).toBe(0);
  });

  it('restores the due slot when the executor rejects the submit', async () => {
    const due = '2026-09-22 09:00:00';
    const localStore: ScheduledTaskStore = {
      insert: vi.fn(),
      updateById: vi.fn(),
      deleteById: vi.fn(),
      selectById: vi.fn(),
      listByUser: vi.fn(async () => []),
      listAll: vi.fn(async () => ({ records: [], total: 0 })),
      listDue: vi.fn(async () => []),
    };
    const rejected = new Error('pool full');
    rejected.name = 'AgentExecutorRejectedError';
    const svc = new ScheduledTaskService(
      localStore, stubs as never, { enqueue: vi.fn() }, { executeFromEvent: vi.fn() }, { finishExecution: vi.fn() },
      { sendText: vi.fn() } as never,
      { findByUserId: vi.fn(async () => null) } as never, { findByAccountId: vi.fn(async () => []) } as never,
      () => { throw rejected; },
    );
    await svc.executeTask({
      id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', prompt: 'hello', fireCount: 0, nextFireTime: due,
    });
    const writes = vi.mocked(localStore.updateById).mock.calls.map(([row]) => row);
    expect(writes.at(-1)?.nextFireTime).toBe(due);
    expect(writes.some((row) => row.lastExecutionStatus === 'FAILED')).toBe(false);
  });

  it('detects one-shot cron shapes', () => {
    expect(isOneShotCron('0 0 8 15 8 ?')).toBe(true);
    expect(isOneShotCron('23 0 18 13 8 *')).toBe(true);
    expect(isOneShotCron('0 0 9 * * ?')).toBe(false);
    expect(isOneShotCron('0 0 10 ? * MON-FRI')).toBe(false);
    expect(isOneShotCron('0 0 9 1 * ?')).toBe(false);
    expect(isOneShotCron('0 */30 * * * ?')).toBe(false);
    expect(isOneShotCron('0 0 10 * * MON')).toBe(false);
    expect(isOneShotCron('bad cron')).toBe(false);
  });

  it('pushesFinalAssistantReplyToFeishuPusher', async () => {    stubs.getSession.mockResolvedValue({ id: 11, phase: 'IDLE' });
    stubs.saveMessage.mockResolvedValue({ id: 88, content: 'hello' });
    stubs.getMessages.mockResolvedValue([
      { role: 'USER', content: 'hello' },
      { role: 'ASSISTANT', content: 'task result' },
    ]);
    const live = vi.fn(async () => undefined);
    const feishuPusher = vi.fn(async () => undefined);
    let ran: Promise<void> | null = null;
    const svc = new ScheduledTaskService(
      store, stubs as never, { enqueue: vi.fn() }, { executeFromEvent: vi.fn() }, { finishExecution: vi.fn() },
      { sendText: vi.fn() } as never,
      { findByUserId: vi.fn(async () => null) } as never, { findByAccountId: vi.fn(async () => []) } as never,
      (fn) => { ran = Promise.resolve().then(fn); },
      live,
    );
    svc.setFeishuResultPusher(feishuPusher);
    await svc.executeTask({ id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', prompt: 'hello', fireCount: 0 });
    await ran;
    expect(feishuPusher).toHaveBeenCalledWith(11, 'task result');
  });

  it('doesNotPushStaleAssistantReplyWhenLiveExecutionFails', async () => {
    vi.mocked(store.selectById).mockResolvedValue({ id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE', prompt: 'hello', fireCount: 0 });
    vi.mocked(store.updateById).mockClear();
    // 1st getSession: before execution (IDLE); 2nd: after liveExecution returns (FAILED)
    stubs.getSession.mockReset();
    stubs.getSession.mockResolvedValueOnce({ id: 11, phase: 'IDLE' });
    stubs.getSession.mockResolvedValueOnce({ id: 11, phase: 'FAILED' });
    stubs.saveMessage.mockResolvedValue({ id: 88, content: 'hello' });
    // Historical messages contain a stale ASSISTANT reply from a previous run
    stubs.getMessages.mockResolvedValue([
      { role: 'USER', content: 'previous run' },
      { role: 'ASSISTANT', content: 'stale old reply' },
    ]);
    // liveExecution swallows errors internally (runExecution catch) and returns normally
    const live = vi.fn(async () => undefined);
    const feishuPusher = vi.fn(async () => undefined);
    const weixinSend = { sendText: vi.fn() };
    let ran: Promise<void> | null = null;
    const svc = new ScheduledTaskService(
      store, stubs as never, { enqueue: vi.fn() }, { executeFromEvent: vi.fn() }, { finishExecution: vi.fn() },
      weixinSend as never,
      { findByUserId: vi.fn(async () => null) } as never, { findByAccountId: vi.fn(async () => []) } as never,
      (fn) => { ran = Promise.resolve().then(fn); },
      live,
    );
    svc.setFeishuResultPusher(feishuPusher);
    await svc.executeTask({ id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', prompt: 'hello', fireCount: 0 });
    await ran;
    expect(live).toHaveBeenCalledTimes(1);
    // Must NOT push the stale ASSISTANT reply to Feishu
    expect(feishuPusher).not.toHaveBeenCalled();
    expect(weixinSend.sendText).not.toHaveBeenCalled();
    // Must mark task as FAILED, not COMPLETED
    const persisted = vi.mocked(store.updateById).mock.calls.map(([row]) => row);
    expect(persisted.some((row) => row.lastExecutionStatus === 'FAILED')).toBe(true);
    expect(persisted.some((row) => row.lastExecutionStatus === 'COMPLETED')).toBe(false);
  });

  it('pusherFailureDoesNotFailTask', async () => {
    stubs.getSession.mockResolvedValue({ id: 11, phase: 'IDLE' });
    stubs.saveMessage.mockResolvedValue({ id: 88, content: 'hello' });
    stubs.getMessages.mockResolvedValue([{ role: 'ASSISTANT', content: 'task result' }]);
    const live = vi.fn(async () => undefined);
    const feishuPusher = vi.fn(async () => { throw new Error('send failed'); });
    let ran: Promise<void> | null = null;
    const svc = new ScheduledTaskService(
      store, stubs as never, { enqueue: vi.fn() }, { executeFromEvent: vi.fn() }, { finishExecution: vi.fn() },
      { sendText: vi.fn() } as never,
      { findByUserId: vi.fn(async () => null) } as never, { findByAccountId: vi.fn(async () => []) } as never,
      (fn) => { ran = Promise.resolve().then(fn); },
      live,
    );
    svc.setFeishuResultPusher(feishuPusher);
    await svc.executeTask({ id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', prompt: 'hello', fireCount: 0 });
    await ran;
    expect(live).toHaveBeenCalledTimes(1);
    const persisted = vi.mocked(store.updateById).mock.calls.map(([row]) => row);
    expect(persisted.some((row) => row.lastExecutionStatus === 'COMPLETED')).toBe(true);
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

  it('queued run counts fireCount/lastFireTime at enqueue and marks QUEUED', async () => {
    const localStore: ScheduledTaskStore = {
      insert: vi.fn(),
      updateById: vi.fn(),
      deleteById: vi.fn(),
      selectById: vi.fn(async () => ({
        id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE', prompt: 'q', fireCount: 3,
      })),
      listByUser: vi.fn(async () => []),
      listAll: vi.fn(async () => ({ records: [], total: 0 })),
      listDue: vi.fn(async () => []),
    };
    let ran: Promise<void> | null = null;
    const svc = new ScheduledTaskService(
      localStore, stubs as never, { enqueue: vi.fn() }, { executeFromEvent: vi.fn() },
      { finishExecution: vi.fn() }, { sendText: vi.fn() } as never,
      { findByUserId: vi.fn(async () => null) } as never, { findByAccountId: vi.fn(async () => []) } as never,
      (fn) => { ran = Promise.resolve().then(fn); },
    );
    stubs.getSession.mockResolvedValue({ id: 11, phase: 'RUNNING' });
    await svc.executeTask({ id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', prompt: 'q', fireCount: 3 });
    await ran;
    const persisted = vi.mocked(localStore.updateById).mock.calls.map(([row]) => row);
    // 入队成功即计数：消费侧无 scheduledTaskId 回写链路，不计会永久丢失
    expect(persisted.some((row) => row.fireCount === 4)).toBe(true);
    expect(persisted.some((row) => row.lastFireTime != null)).toBe(true);
    expect(persisted.some((row) => row.lastExecutionStatus === 'QUEUED')).toBe(true);
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

  it('executeTask start patches only nextFireTime, not the stale full row', async () => {
    const localStore: ScheduledTaskStore = {
      insert: vi.fn(),
      updateById: vi.fn(),
      deleteById: vi.fn(),
      selectById: vi.fn(async () => ({
        id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE', prompt: 'hello', fireCount: 0,
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
    );
    // T0 快照携带与库中不同的 name/prompt，若被整行回写将覆盖用户并发修改
    await svc.executeTask({
      id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', prompt: 'stale-prompt', name: 'stale-name', fireCount: 0,
    });
    await ran;
    const persisted = vi.mocked(localStore.updateById).mock.calls.map(([row]) => row);
    const first = persisted[0];
    expect(Object.keys(first).sort()).toEqual(['id', 'nextFireTime']);
    expect(persisted.some((row) => row.prompt === 'stale-prompt' || row.name === 'stale-name')).toBe(false);
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

  it('restores the due slot when the task is paused before it starts', async () => {
    const due = '2026-09-22 09:00:00';
    const row: Record<string, unknown> = {
      id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE',
      prompt: 'hello', once: 0, fireCount: 0, nextFireTime: due,
    };
    const localStore: ScheduledTaskStore = {
      insert: vi.fn(),
      updateById: vi.fn(async (patch) => { Object.assign(row, patch); }),
      deleteById: vi.fn(),
      selectById: vi.fn(async () => row),
      listByUser: vi.fn(async () => []),
      listAll: vi.fn(async () => ({ records: [], total: 0 })),
      listDue: vi.fn(async () => []),
    };
    const saveMessage = vi.fn();
    let ran: Promise<void> | null = null;
    const svc = new ScheduledTaskService(
      localStore, { getSession: vi.fn(), updatePhase: vi.fn(), saveMessage, getMessages: vi.fn() } as never,
      { enqueue: vi.fn() }, { executeFromEvent: vi.fn() }, { finishExecution: vi.fn() },
      { sendText: vi.fn() } as never,
      { findByUserId: vi.fn(async () => null) } as never, { findByAccountId: vi.fn(async () => []) } as never,
      (fn) => { row.status = 'PAUSED'; ran = Promise.resolve().then(fn); },
    );
    await svc.executeTask({
      id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', prompt: 'hello', once: 0, fireCount: 0, nextFireTime: due,
    });
    await ran;
    expect(saveMessage).not.toHaveBeenCalled();
    expect(row.nextFireTime).toBe(due);
    expect(row.status).toBe('PAUSED');
  });

  it('does not finish a task whose once flag was cleared while waiting to enqueue', async () => {
    const row: Record<string, unknown> = {
      id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE',
      prompt: 'q', once: 1, fireCount: 0, nextFireTime: '2026-09-22 09:00:00',
    };
    const localStore: ScheduledTaskStore = {
      insert: vi.fn(),
      updateById: vi.fn(async (patch) => { Object.assign(row, patch); }),
      deleteById: vi.fn(),
      selectById: vi.fn(async () => row),
      listByUser: vi.fn(async () => []),
      listAll: vi.fn(async () => ({ records: [], total: 0 })),
      listDue: vi.fn(async () => []),
    };
    const enqueue = vi.fn(async () => undefined);
    let ran: Promise<void> | null = null;
    const svc = new ScheduledTaskService(
      localStore, { getSession: vi.fn(async () => ({ id: 11, phase: 'RUNNING' })), updatePhase: vi.fn(), saveMessage: vi.fn(), getMessages: vi.fn() } as never,
      { enqueue }, { executeFromEvent: vi.fn() }, { finishExecution: vi.fn() },
      { sendText: vi.fn() } as never,
      { findByUserId: vi.fn(async () => null) } as never, { findByAccountId: vi.fn(async () => []) } as never,
      (fn) => { row.once = 0; ran = Promise.resolve().then(fn); },
    );
    await svc.executeTask({
      id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', prompt: 'q', once: 1, fireCount: 0,
    });
    await ran;
    expect(enqueue).toHaveBeenCalled();
    expect(row.finished).not.toBe(1);
    expect(row.nextFireTime).not.toBeNull();
  });

  it('rewrites nextFireTime from the cron changed during the run', async () => {
    const row: Record<string, unknown> = {
      id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE',
      prompt: 'hello', once: 0, fireCount: 0, nextFireTime: '2026-09-22 09:00:00',
    };
    const localStore: ScheduledTaskStore = {
      insert: vi.fn(),
      updateById: vi.fn(async (patch) => { Object.assign(row, patch); }),
      deleteById: vi.fn(),
      selectById: vi.fn(async () => row),
      listByUser: vi.fn(async () => []),
      listAll: vi.fn(async () => ({ records: [], total: 0 })),
      listDue: vi.fn(async () => []),
    };
    let ran: Promise<void> | null = null;
    const svc = new ScheduledTaskService(
      localStore,
      { getSession: vi.fn(async () => ({ id: 11, phase: 'IDLE' })), updatePhase: vi.fn(), saveMessage: vi.fn(async () => ({ id: 88 })), getMessages: vi.fn(async () => []) } as never,
      { enqueue: vi.fn() }, { executeFromEvent: vi.fn(async () => undefined) }, { finishExecution: vi.fn() },
      { sendText: vi.fn() } as never,
      { findByUserId: vi.fn(async () => null) } as never, { findByAccountId: vi.fn(async () => []) } as never,
      (fn) => { row.cronExpression = '0 0 * * * *'; ran = Promise.resolve().then(fn); },
    );
    await svc.executeTask({
      id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', prompt: 'hello', once: 0, fireCount: 0,
    });
    await ran;
    expect(row.cronExpression).toBe('0 0 * * * *');
    expect(row.nextFireTime).toBe(svc.calculateNextFireTime('0 0 * * * *'));
    expect(row.finished).not.toBe(1);
  });
});
