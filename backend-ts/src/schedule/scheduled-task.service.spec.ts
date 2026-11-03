import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { isOneShotCron, normalizeSpringCron, ScheduledTaskScheduler, ScheduledTaskService, shiftSeconds, type ScheduledTaskStore } from './scheduled-task.service.js';

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

  it('does not reactivate a finished task when only the name changes', async () => {
    vi.mocked(store.selectById).mockResolvedValue({
      id: 1, userId: 7, sessionId: 11, name: 'old', cronExpression: '0 0 9 * * *',
      status: 'ACTIVE', once: 1, finished: 1, nextFireTime: null, fireCount: 1, prompt: 'hello',
    });
    vi.mocked(store.updateById).mockClear();
    const updated = await service.updateTask(1, 7, 'new name', null, null, null);
    expect(updated.name).toBe('new name');
    expect(updated.finished).toBe(1);
    expect(updated.nextFireTime).toBeNull();
  });

  it('reactivates a finished task when status is set back to ACTIVE', async () => {
    vi.mocked(store.selectById).mockResolvedValue({
      id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *',
      status: 'ACTIVE', once: 0, finished: 1, nextFireTime: null, fireCount: 1, prompt: 'hello',
    });
    const updated = await service.updateTask(1, 7, null, null, null, 'ACTIVE');
    expect(updated.finished).toBe(0);
    expect(updated.nextFireTime).toBeTruthy();
  });

  it('finishes a task when its session has been deleted', async () => {
    const localStore: ScheduledTaskStore = {
      insert: vi.fn(),
      updateById: vi.fn(),
      deleteById: vi.fn(),
      selectById: vi.fn(async () => ({
        id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE',
        name: 'daily', prompt: 'hello', once: 0, fireCount: 0, finished: 0,
      })),
      listByUser: vi.fn(async () => []),
      listAll: vi.fn(async () => ({ records: [], total: 0 })),
      listDue: vi.fn(async () => []),
    };
    const missing = new BusinessException(ErrorCode.SESSION_NOT_FOUND);
    let ran: Promise<void> | null = null;
    const svc = new ScheduledTaskService(
      localStore,
      { ...stubs, getSession: vi.fn(async () => { throw missing; }) } as never,
      { enqueue: vi.fn() }, { executeFromEvent: vi.fn() }, { finishExecution: vi.fn() },
      { sendText: vi.fn() } as never,
      { findByUserId: vi.fn(async () => null) } as never,
      { findByAccountId: vi.fn(async () => []) } as never,
      (fn) => { ran = Promise.resolve().then(fn); },
    );
    await svc.executeTask({
      id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', prompt: 'hello',
      status: 'ACTIVE', once: 0, fireCount: 0, finished: 0, nextFireTime: '2026-09-28 09:00:00',
    });
    await ran;
    const persisted = vi.mocked(localStore.updateById).mock.calls.map(([row]) => row);
    const final = persisted.at(-1)!;
    expect(final.finished).toBe(1);
    expect(final.nextFireTime).toBeNull();
    expect(final.lastExecutionStatus).toBe('FAILED');
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
    expect(isOneShotCron('0 8 15 8 *')).toBe(true);
    expect(isOneShotCron('0 9 * * *')).toBe(false);
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
      expect.any(Number), 1,
    );
    expect(harness.executeFromEvent).not.toHaveBeenCalled();
    expect(terminal.finishExecution).not.toHaveBeenCalled();
  });

  it('legacyDummyExecutionPathMarksFinishedAsScheduled（无 liveExecution 的遗留/测试路径传 SCHEDULED）', async () => {
    // 生产走 liveExecution（由 WS 处理器传 SCHEDULED，见 streaming-ws-handler spec）；
    // 这里锁定遗留分支：窄接口缺参会静默回落 MANUAL，必须显式断言。
    vi.mocked(store.selectById).mockResolvedValue({
      id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE', prompt: 'hello', fireCount: 0,
    });
    stubs.getSession.mockResolvedValue({ id: 11, phase: 'IDLE' });
    stubs.saveMessage.mockResolvedValue({ id: 88, content: 'hello' });
    stubs.getMessages.mockResolvedValue([{ role: 'ASSISTANT', content: 'done' }]);
    const terminal = { finishExecution: vi.fn() };
    let ran: Promise<void> | null = null;
    const svc = new ScheduledTaskService(
      store, stubs as never, { enqueue: vi.fn() }, { executeFromEvent: vi.fn(async () => undefined) },
      terminal,
      { sendText: vi.fn() } as never,
      { findByUserId: vi.fn(async () => null) } as never, { findByAccountId: vi.fn(async () => []) } as never,
      (fn) => { ran = Promise.resolve().then(fn); },
    );
    await svc.executeTask({ id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', prompt: 'hello', fireCount: 0 });
    await ran;
    expect(terminal.finishExecution).toHaveBeenCalledWith(
      11, 7, 'COMPLETED', expect.any(String), undefined, 'SCHEDULED',
    );
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

  it('rejects blank or over-long name/prompt on create', async () => {
    await expect(service.createTask(7, 5, 11, '   ', 'hello', '0 0 9 * * *')).rejects.toThrow('任务名称不能为空');
    await expect(service.createTask(7, 5, 11, null as never, 'hello', '0 0 9 * * *')).rejects.toThrow('任务名称不能为空');
    await expect(service.createTask(7, 5, 11, 'n', '  ', '0 0 9 * * *')).rejects.toThrow('任务提示词不能为空');
    await expect(service.createTask(7, 5, 11, 'n'.repeat(201), 'hello', '0 0 9 * * *')).rejects.toThrow('任务名称不能超过 200 字符');
    await expect(service.createTask(7, 5, 11, 'n', 'p'.repeat(10001), '0 0 9 * * *')).rejects.toThrow('任务提示词不能超过 10000 字符');
  });

  it('trims name/prompt on create and only validates fields present in update', async () => {
    const created = await service.createTask(7, 5, 11, '  morning  ', '  do it  ', '0 0 9 * * *');
    expect(created.name).toBe('morning');
    expect(created.prompt).toBe('do it');

    vi.mocked(store.selectById).mockResolvedValue({
      id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE', once: 0, fireCount: 0, name: 'n', prompt: 'p',
    });
    // 只改状态：不校验也不覆盖 name/prompt
    const toggled = await service.updateTask(1, 7, null, null, null, 'PAUSED');
    expect(toggled.name).toBe('n');
    expect(toggled.prompt).toBe('p');
    await expect(service.updateTask(1, 7, '  ', null, null, null)).rejects.toThrow('任务名称不能为空');
    await expect(service.updateTask(1, 7, null, '', null, null)).rejects.toThrow('任务提示词不能为空');
  });

  it('previews cron runs with the same parser and timezone as the scheduler', () => {
    const daily = service.previewCron('0 0 9 * * ?', 3);
    expect(daily.valid).toBe(true);
    expect(daily.oneShot).toBe(false);
    expect(daily.message).toBeNull();
    expect(daily.nextFireTimes).toHaveLength(3);
    expect(daily.nextFireTimes[0]).toMatch(/^\d{4}-\d{2}-\d{2} 09:00:00$/);
    // 同日多次触发时严格递增
    expect(daily.nextFireTimes[1] > daily.nextFireTimes[0]).toBe(true);

    const oneShot = service.previewCron('0 0 8 15 8 ?', 2);
    expect(oneShot.valid).toBe(true);
    expect(oneShot.oneShot).toBe(true);
    expect(oneShot.nextFireTimes[0]).toMatch(/^\d{4}-08-15 08:00:00$/);
  });

  it('reports invalid cron without throwing and clamps the preview count', () => {
    const invalid = service.previewCron('not-a-cron');
    expect(invalid.valid).toBe(false);
    expect(invalid.nextFireTimes).toEqual([]);
    expect(invalid.message).toContain('无效的 cron 表达式');

    const empty = service.previewCron('   ');
    expect(empty.valid).toBe(false);
    expect(empty.message).toBe('cron 表达式不能为空');

    expect(service.previewCron('0 0 9 * * *', 0).nextFireTimes).toHaveLength(1);
    expect(service.previewCron('0 0 9 * * *', 999).nextFireTimes).toHaveLength(10);
    expect(service.previewCron('0 0 9 * * *', Number.NaN).nextFireTimes).toHaveLength(3);
  });
});

describe('ScheduledTaskService 预算 BLOCK 闸门（§5.7）', () => {
  function build(budgetCheck: ((target: { userId: number | null; agentId: number | null }) => Promise<{ message: string } | null>) | null) {
    const store = {
      ...stubStore(),
      selectById: vi.fn(async () => ({
        id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE', fireCount: 0, prompt: 'hello', once: 0,
      })),
    };
    const stubs2 = {
      getSession: vi.fn(async () => ({ id: 11, phase: 'IDLE', sessionType: 'NORMAL', userId: 7, agentId: 5 })),
      updatePhase: vi.fn(),
      saveMessage: vi.fn(async () => ({ id: 88, content: 'hello' })),
      getMessages: vi.fn(async () => []),
    };
    const queue = { enqueue: vi.fn() };
    const harness = { executeFromEvent: vi.fn(async () => undefined) };
    const terminal = { finishExecution: vi.fn(async () => undefined) };
    const liveExecution = vi.fn(async () => undefined);
    let ran: Promise<void> | null = null;
    const service = new ScheduledTaskService(
      store as never, stubs2 as never, queue as never, harness as never, terminal as never,
      { sendText: vi.fn(async () => true) } as never, { findByUserId: vi.fn() } as never, { findByAccountId: vi.fn() } as never,
      (fn) => { ran = Promise.resolve().then(fn); },
      liveExecution as never,
      null,
      budgetCheck,
    );
    return { service, store, stubs2, queue, harness, terminal, liveExecution, run: () => ran };
  }

  const TASK = { id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', prompt: 'hello', fireCount: 0 };

  it('BLOCK 命中：直跑分支不执行、不落消息、本轮标记 FAILED', async () => {
    const h = build(async () => ({ message: '本月全局预算已超限：当期消耗 12 / 上限 10（成本 口径）' }));
    await h.service.executeTask(TASK as never);
    await h.run();
    expect(h.stubs2.updatePhase).not.toHaveBeenCalledWith(11, 'RUNNING');
    expect(h.stubs2.saveMessage).not.toHaveBeenCalled();
    expect(h.liveExecution).not.toHaveBeenCalled();
    expect(h.harness.executeFromEvent).not.toHaveBeenCalled();
    // 本轮执行按 FAILED 收尾（lastExecutionStatus 可见），档期照常推进
    expect(h.store.updateById).toHaveBeenCalledWith(expect.objectContaining({ id: 1, lastExecutionStatus: 'FAILED' }));
  });

  it('检查点传入会话归属（userId/agentId 可为 null）', async () => {
    const budgetCheck = vi.fn(async () => null);
    const h = build(budgetCheck as never);
    await h.service.executeTask(TASK as never);
    await h.run();
    expect(budgetCheck).toHaveBeenCalledWith({ userId: 7, agentId: 5 });
    expect(h.liveExecution).toHaveBeenCalled();
  });

  it('未命中：正常执行', async () => {
    const h = build(async () => null);
    await h.service.executeTask(TASK as never);
    await h.run();
    expect(h.stubs2.updatePhase).toHaveBeenCalledWith(11, 'RUNNING');
    expect(h.stubs2.saveMessage).toHaveBeenCalled();
    expect(h.liveExecution).toHaveBeenCalledTimes(1);
  });

  it('busy 入队分支不检查预算（排队消息由队列消费侧再查）', async () => {
    const budgetCheck = vi.fn(async () => ({ message: 'blocked' }));
    const store = {
      ...stubStore(),
      selectById: vi.fn(async () => ({
        id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE', fireCount: 0, prompt: 'hello', once: 0,
      })),
    };
    const stubs2 = {
      getSession: vi.fn(async () => ({ id: 11, phase: 'RUNNING', sessionType: 'NORMAL', userId: 7, agentId: 5 })),
      updatePhase: vi.fn(),
      saveMessage: vi.fn(),
      getMessages: vi.fn(async () => []),
    };
    const queue = { enqueue: vi.fn(async () => undefined) };
    let ran: Promise<void> | null = null;
    const service = new ScheduledTaskService(
      store as never, stubs2 as never, queue as never, { executeFromEvent: vi.fn() } as never,
      { finishExecution: vi.fn() } as never, { sendText: vi.fn() } as never,
      { findByUserId: vi.fn() } as never, { findByAccountId: vi.fn() } as never,
      (fn) => { ran = Promise.resolve().then(fn); },
      vi.fn(async () => undefined) as never,
      null,
      budgetCheck as never,
    );
    await service.executeTask(TASK as never);
    await ran;
    expect(queue.enqueue).toHaveBeenCalled();
    expect(budgetCheck).not.toHaveBeenCalled();
  });

  it('子代理/边路会话不单独检查（跟随父会话准入结论）', async () => {
    for (const sessionType of ['SUBAGENT', 'SIDE_TASK']) {
      const budgetCheck = vi.fn(async () => ({ message: 'blocked' }));
      const store = {
        ...stubStore(),
        selectById: vi.fn(async () => ({
          id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE', fireCount: 0, prompt: 'hello', once: 0,
        })),
      };
      const stubs2 = {
        getSession: vi.fn(async () => ({ id: 11, phase: 'IDLE', sessionType, userId: 7, agentId: 5 })),
        updatePhase: vi.fn(),
        saveMessage: vi.fn(async () => ({ id: 88 })),
        getMessages: vi.fn(async () => []),
      };
      const liveExecution = vi.fn(async () => undefined);
      let ran: Promise<void> | null = null;
      const service = new ScheduledTaskService(
        store as never, stubs2 as never, { enqueue: vi.fn() } as never, { executeFromEvent: vi.fn() } as never,
        { finishExecution: vi.fn() } as never, { sendText: vi.fn() } as never,
        { findByUserId: vi.fn() } as never, { findByAccountId: vi.fn() } as never,
        (fn) => { ran = Promise.resolve().then(fn); },
        liveExecution as never,
        null,
        budgetCheck as never,
      );
      await service.executeTask(TASK as never);
      await ran;
      expect(budgetCheck, sessionType).not.toHaveBeenCalled();
      expect(liveExecution, sessionType).toHaveBeenCalled();
    }
  });

  it('一次性任务排队被取消后恢复未完结和下次触发时间', async () => {
    const row: Record<string, unknown> = {
      id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE',
      once: 1, finished: 1, finishedAt: '2026-10-08 09:00:00', nextFireTime: null, lastExecutionStatus: 'QUEUED',
    };
    const store: ScheduledTaskStore = {
      insert: vi.fn(),
      updateById: vi.fn(async (patch) => { Object.assign(row, patch); }),
      deleteById: vi.fn(),
      selectById: vi.fn(async () => ({ ...row })),
      listByUser: vi.fn(async () => []),
      listAll: vi.fn(async () => ({ records: [], total: 0 })),
      listDue: vi.fn(async () => []),
    };
    const service = new ScheduledTaskService(
      store, {} as never, { enqueue: vi.fn() } as never, { executeFromEvent: vi.fn() } as never,
      { finishExecution: vi.fn() } as never, { sendText: vi.fn() } as never,
      { findByUserId: vi.fn() } as never, { findByAccountId: vi.fn() } as never,
    );
    await service.settleQueuedExecution(1, 'CANCELLED');
    expect(row.finished).toBe(0);
    expect(row.finishedAt).toBeNull();
    expect(row.lastExecutionStatus).toBe('CANCELLED');
    expect(row.nextFireTime).toEqual(expect.any(String));

    row.finished = 1;
    row.nextFireTime = null;
    row.lastExecutionStatus = 'QUEUED';
    await service.settleQueuedExecution(1, 'COMPLETED');
    expect(row.finished).toBe(1);
    expect(row.nextFireTime).toBeNull();
    expect(row.lastExecutionStatus).toBe('COMPLETED');
  });

  // 回归：once 收口曾把 status==='ACTIVE' 与 once===1 耦合，PAUSED 期间整个分支被跳过，
  // 任务停在 finished=0 + nextFireTime=null；重新启用时 reactivate 分支命中并重开下一档，
  // once 任务被执行第二次。暂停只影响「是否重开档期」，不影响「这一档是否算跑完」。
  it('settles a paused one-shot task instead of leaving it to re-run', async () => {
    const row: Record<string, unknown> = {
      id: 1, userId: 7, sessionId: 11, cronExpression: '0 * * * * *', status: 'PAUSED',
      once: 1, finished: 0, finishedAt: null, nextFireTime: null, lastExecutionStatus: 'QUEUED',
    };
    const store: ScheduledTaskStore = {
      insert: vi.fn(),
      updateById: vi.fn(async (patch) => { Object.assign(row, patch); }),
      deleteById: vi.fn(),
      selectById: vi.fn(async () => ({ ...row })),
      listByUser: vi.fn(async () => []),
      listAll: vi.fn(async () => ({ records: [], total: 0 })),
      listDue: vi.fn(async () => []),
    };
    const service = new ScheduledTaskService(
      store, {} as never, { enqueue: vi.fn() } as never, { executeFromEvent: vi.fn() } as never,
      { finishExecution: vi.fn() } as never, { sendText: vi.fn() } as never,
      { findByUserId: vi.fn() } as never, { findByAccountId: vi.fn() } as never,
    );
    await service.settleQueuedExecution(1, 'COMPLETED');
    // 收口：finished=1 且无档期 → 重新启用时 reactivate 判据（nextFireTime==null）虽成立，
    // 但 finished 已置 1，列表显示已完结，不会再排下一档
    expect(row.finished).toBe(1);
    expect(row.finishedAt).toEqual(expect.any(String));
    expect(row.nextFireTime).toBeNull();
    expect(row.lastExecutionStatus).toBe('COMPLETED');
  });

  // 取消同样不收口也不行：PAUSED 下不重开档期（用户已要求别再跑），
  // 但必须离开「nextFireTime=null + finished=0」的悬空态——否则列表里既非已完结也无档期。
  // 收口后由 reactivate 在用户显式重新启用时按当前 cron 排期，属文档明示的设计口径。
  it('settles a paused one-shot task on CANCELLED without reopening a slot', async () => {
    const row: Record<string, unknown> = {
      id: 1, userId: 7, sessionId: 11, cronExpression: '0 * * * * *', status: 'PAUSED',
      once: 1, finished: 0, finishedAt: null, nextFireTime: null, lastExecutionStatus: 'QUEUED',
    };
    const store: ScheduledTaskStore = {
      insert: vi.fn(),
      updateById: vi.fn(async (patch) => { Object.assign(row, patch); }),
      deleteById: vi.fn(),
      selectById: vi.fn(async () => ({ ...row })),
      listByUser: vi.fn(async () => []),
      listAll: vi.fn(async () => ({ records: [], total: 0 })),
      listDue: vi.fn(async () => []),
    };
    const service = new ScheduledTaskService(
      store, {} as never, { enqueue: vi.fn() } as never, { executeFromEvent: vi.fn() } as never,
      { finishExecution: vi.fn() } as never, { sendText: vi.fn() } as never,
      { findByUserId: vi.fn() } as never, { findByAccountId: vi.fn() } as never,
    );
    await service.settleQueuedExecution(1, 'CANCELLED');
    // PAUSED 下不重开档期；这一档取消未跑完，等用户显式重新启用时再由 reactivate 排期
    expect(row.finished).toBe(0);
    expect(row.nextFireTime).toBeNull();
    expect(row.lastExecutionStatus).toBe('CANCELLED');
  });

  // 对照组：ACTIVE 行为不变（取消仍恢复下一档，已有 spec 覆盖，此处锁定不被本次改动破坏）
  it('still reopens the next slot for an active one-shot task on CANCELLED', async () => {
    const row: Record<string, unknown> = {
      id: 1, userId: 7, sessionId: 11, cronExpression: '0 * * * * *', status: 'ACTIVE',
      once: 1, finished: 0, finishedAt: null, nextFireTime: null, lastExecutionStatus: 'QUEUED',
    };
    const store: ScheduledTaskStore = {
      insert: vi.fn(),
      updateById: vi.fn(async (patch) => { Object.assign(row, patch); }),
      deleteById: vi.fn(),
      selectById: vi.fn(async () => ({ ...row })),
      listByUser: vi.fn(async () => []),
      listAll: vi.fn(async () => ({ records: [], total: 0 })),
      listDue: vi.fn(async () => []),
    };
    const service = new ScheduledTaskService(
      store, {} as never, { enqueue: vi.fn() } as never, { executeFromEvent: vi.fn() } as never,
      { finishExecution: vi.fn() } as never, { sendText: vi.fn() } as never,
      { findByUserId: vi.fn() } as never, { findByAccountId: vi.fn() } as never,
    );
    await service.settleQueuedExecution(1, 'CANCELLED');
    expect(row.finished).toBe(0);
    expect(row.nextFireTime).toEqual(expect.any(String));
    expect(row.lastExecutionStatus).toBe('CANCELLED');
  });

  it('微信回复：超过24小时主动发送窗口时不打 ilink，改发站内通知', async () => {
    // selectById 返回 ACTIVE：锁内重读最新任务状态，null 会让整轮直接 return
    const store: ScheduledTaskStore = {
      insert: vi.fn(async (t) => { t.id = 1; return 1; }),
      updateById: vi.fn(),
      deleteById: vi.fn(),
      selectById: vi.fn(async () => ({
        id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE', name: 'daily', prompt: 'hello', fireCount: 0,
      })),
      listByUser: vi.fn(async () => []),
      listAll: vi.fn(async () => ({ records: [], total: 0 })),
      listDue: vi.fn(async () => []),
    } as never;
    const stubs = {
      getSession: vi.fn(async () => ({ id: 11, phase: 'IDLE', projectKey: 'weixin-bot' })),
      updatePhase: vi.fn(),
      saveMessage: vi.fn(async () => ({ id: 88, content: 'x' })),
      getMessages: vi.fn(async () => [{ role: 'ASSISTANT', content: 'done' }]),
    };
    const send = { sendText: vi.fn(async () => true) };
    const notified: Array<Record<string, unknown>> = [];
    let ran: Promise<void> | null = null;
    const svc = new ScheduledTaskService(
      store, stubs as never, { enqueue: vi.fn() }, { executeFromEvent: vi.fn(async () => undefined) },
      { finishExecution: vi.fn() }, send as never,
      { findByUserId: vi.fn(async () => ({ accountId: 'acc' })) } as never,
      { findByAccountId: vi.fn(async () => [{ wxUserId: 'wx1' }]) } as never,
      (fn) => { ran = Promise.resolve().then(fn); },
    );
    // 最近一次入站在 70 小时前：超过 24 小时窗口
    svc.setWeixinInboundRepository({ findLatestInboundAt: vi.fn(async () => new Date(Date.now() - 70 * 60 * 60 * 1000)) } as never);
    svc.setWeixinWindowNotifier(async (input) => { notified.push(input as unknown as Record<string, unknown>); });
    await svc.executeTask({ id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', prompt: 'hello', fireCount: 0 } as never);
    await ran;
    expect(send.sendText).not.toHaveBeenCalled();
    expect(notified).toHaveLength(1);
    expect(notified[0].body).toContain('24 小时');
  });

  it('微信回复：超过24小时窗口时也把回复降级推送到 webhook（勿只写站内通知）', async () => {
    // 回归：预检短路此前只写站内收件箱就 return，webhook 降级分支只在 sendText 失败后
    // 才触发，导致「超过 24 小时无对话」时微信与 webhook 两边都收不到任何内容。
    const store: ScheduledTaskStore = {
      insert: vi.fn(async (t) => { t.id = 1; return 1; }),
      updateById: vi.fn(),
      deleteById: vi.fn(),
      selectById: vi.fn(async () => ({
        id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE', name: 'daily', prompt: 'hello', fireCount: 0,
      })),
      listByUser: vi.fn(async () => []),
      listAll: vi.fn(async () => ({ records: [], total: 0 })),
      listDue: vi.fn(async () => []),
    } as never;
    const stubs = {
      getSession: vi.fn(async () => ({ id: 11, phase: 'IDLE', projectKey: 'weixin-bot' })),
      updatePhase: vi.fn(),
      saveMessage: vi.fn(async () => ({ id: 88, content: 'x' })),
      getMessages: vi.fn(async () => [{ role: 'ASSISTANT', content: '定时任务回答' }]),
    };
    const send = { sendText: vi.fn(async () => true) };
    const sendFallback = vi.fn(async () => true);
    const notified: Array<Record<string, unknown>> = [];
    let ran: Promise<void> | null = null;
    const svc = new ScheduledTaskService(
      store, stubs as never, { enqueue: vi.fn() }, { executeFromEvent: vi.fn(async () => undefined) },
      { finishExecution: vi.fn() }, send as never,
      { findByUserId: vi.fn(async () => ({ accountId: 'acc' })) } as never,
      { findByAccountId: vi.fn(async () => [{ wxUserId: 'wx1' }]) } as never,
      (fn) => { ran = Promise.resolve().then(fn); },
    );
    svc.setWeixinInboundRepository({ findLatestInboundAt: vi.fn(async () => new Date(Date.now() - 30 * 60 * 60 * 1000)) } as never);
    svc.setWeixinWindowNotifier(async (input) => { notified.push(input as unknown as Record<string, unknown>); });
    svc.setWeixinWebhookFallback({ sendFallback } as never);
    await svc.executeTask({ id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', prompt: 'hello', fireCount: 0 } as never);
    await ran;
    // 超窗不打 ilink，但回复原文必须抵达 webhook，站内通知照旧
    expect(send.sendText).not.toHaveBeenCalled();
    expect(sendFallback).toHaveBeenCalledWith(7, '定时任务回答');
    expect(notified).toHaveLength(1);
  });

  it('微信回复：窗口内正常发送且不发窗口通知', async () => {
    const stubs = {
      getSession: vi.fn(async () => ({ id: 11, phase: 'IDLE', projectKey: 'weixin-bot' })),
      updatePhase: vi.fn(),
      saveMessage: vi.fn(async () => ({ id: 88, content: 'x' })),
      getMessages: vi.fn(async () => [{ role: 'ASSISTANT', content: 'done' }]),
    };
    const store: ScheduledTaskStore = {
      insert: vi.fn(async (t) => { t.id = 1; return 1; }),
      updateById: vi.fn(),
      deleteById: vi.fn(),
      selectById: vi.fn(async () => ({
        id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE', name: 'daily', prompt: 'hello', fireCount: 0,
      })),
      listByUser: vi.fn(async () => []),
      listAll: vi.fn(async () => ({ records: [], total: 0 })),
      listDue: vi.fn(async () => []),
    } as never;
    const send = { sendText: vi.fn(async () => true) };
    const notified: Array<Record<string, unknown>> = [];
    let ran: Promise<void> | null = null;
    const svc = new ScheduledTaskService(
      store, stubs as never, { enqueue: vi.fn() }, { executeFromEvent: vi.fn(async () => undefined) },
      { finishExecution: vi.fn() }, send as never,
      { findByUserId: vi.fn(async () => ({ accountId: 'acc' })) } as never,
      { findByAccountId: vi.fn(async () => [{ wxUserId: 'wx1' }]) } as never,
      (fn) => { ran = Promise.resolve().then(fn); },
    );
    svc.setWeixinInboundRepository({ findLatestInboundAt: vi.fn(async () => new Date(Date.now() - 60 * 60 * 1000)) } as never);
    svc.setWeixinWindowNotifier(async (input) => { notified.push(input as unknown as Record<string, unknown>); });
    await svc.executeTask({ id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', prompt: 'hello', fireCount: 0 } as never);
    await ran;
    expect(send.sendText).toHaveBeenCalledWith('acc', 'wx1', 'done');
    expect(notified).toHaveLength(0);
  });

  it('微信回复：发送失败时降级推送到 webhook', async () => {
    const stubs = {
      getSession: vi.fn(async () => ({ id: 11, phase: 'IDLE', projectKey: 'weixin-bot' })),
      updatePhase: vi.fn(),
      saveMessage: vi.fn(async () => ({ id: 88, content: 'x' })),
      getMessages: vi.fn(async () => [{ role: 'ASSISTANT', content: '定时任务回答' }]),
    };
    const store: ScheduledTaskStore = {
      insert: vi.fn(async (t) => { t.id = 1; return 1; }),
      updateById: vi.fn(),
      deleteById: vi.fn(),
      selectById: vi.fn(async () => ({
        id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE', name: 'daily', prompt: 'hello', fireCount: 0,
      })),
      listByUser: vi.fn(async () => []),
      listAll: vi.fn(async () => ({ records: [], total: 0 })),
      listDue: vi.fn(async () => []),
    } as never;
    const send = { sendText: vi.fn(async () => false) };
    const sendFallback = vi.fn(async () => true);
    let ran: Promise<void> | null = null;
    const svc = new ScheduledTaskService(
      store, stubs as never, { enqueue: vi.fn() }, { executeFromEvent: vi.fn(async () => undefined) },
      { finishExecution: vi.fn() }, send as never,
      { findByUserId: vi.fn(async () => ({ accountId: 'acc' })) } as never,
      { findByAccountId: vi.fn(async () => [{ wxUserId: 'wx1' }]) } as never,
      (fn) => { ran = Promise.resolve().then(fn); },
    );
    svc.setWeixinWebhookFallback({ sendFallback } as never);
    await svc.executeTask({ id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', prompt: 'hello', fireCount: 0 } as never);
    await ran;
    expect(sendFallback).toHaveBeenCalledWith(7, '定时任务回答');
  });

  it('微信回复：剥离 [^n^] 引用标记后再发送（渠道不渲染来源区）', async () => {
    const stubs = {
      getSession: vi.fn(async () => ({ id: 11, phase: 'IDLE', projectKey: 'weixin-bot' })),
      updatePhase: vi.fn(),
      saveMessage: vi.fn(async () => ({ id: 88, content: 'x' })),
      getMessages: vi.fn(async () => [
        { role: 'USER', content: '截止时间是几号' },
        { role: 'ASSISTANT', content: '截止时间是 11 月 30 日[^1^]，详见通知[^2^]。' },
      ]),
    };
    const store: ScheduledTaskStore = {
      insert: vi.fn(async (t) => { t.id = 1; return 1; }),
      updateById: vi.fn(),
      deleteById: vi.fn(),
      selectById: vi.fn(async () => ({
        id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE', name: 'daily', prompt: 'hello', fireCount: 0,
      })),
      listByUser: vi.fn(async () => []),
      listAll: vi.fn(async () => ({ records: [], total: 0 })),
      listDue: vi.fn(async () => []),
    } as never;
    const send = { sendText: vi.fn(async () => true) };
    let ran: Promise<void> | null = null;
    const svc = new ScheduledTaskService(
      store, stubs as never, { enqueue: vi.fn() }, { executeFromEvent: vi.fn(async () => undefined) },
      { finishExecution: vi.fn() }, send as never,
      { findByUserId: vi.fn(async () => ({ accountId: 'acc' })) } as never,
      { findByAccountId: vi.fn(async () => [{ wxUserId: 'wx1' }]) } as never,
      (fn) => { ran = Promise.resolve().then(fn); },
    );
    await svc.executeTask({ id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', prompt: 'hello', fireCount: 0 } as never);
    await ran;
    expect(send.sendText).toHaveBeenCalledWith('acc', 'wx1', '截止时间是 11 月 30 日，详见通知。');
  });

  it('飞书结果回流：剥离 [^n^] 引用标记后再推送（渠道不渲染来源区）', async () => {
    const stubs = {
      getSession: vi.fn(async () => ({ id: 11, phase: 'IDLE', projectKey: 'mao' })),
      updatePhase: vi.fn(),
      saveMessage: vi.fn(async () => ({ id: 88, content: 'x' })),
      getMessages: vi.fn(async () => [
        { role: 'USER', content: '截止时间是几号' },
        { role: 'ASSISTANT', content: '截止时间是 11 月 30 日[^1^]，详见通知[^2^]。' },
      ]),
    };
    const store: ScheduledTaskStore = {
      insert: vi.fn(async (t) => { t.id = 1; return 1; }),
      updateById: vi.fn(),
      deleteById: vi.fn(),
      selectById: vi.fn(async () => ({
        id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE', name: 'daily', prompt: 'hello', fireCount: 0,
      })),
      listByUser: vi.fn(async () => []),
      listAll: vi.fn(async () => ({ records: [], total: 0 })),
      listDue: vi.fn(async () => []),
    } as never;
    const pusher = vi.fn(async () => undefined);
    let ran: Promise<void> | null = null;
    const svc = new ScheduledTaskService(
      store, stubs as never, { enqueue: vi.fn() }, { executeFromEvent: vi.fn(async () => undefined) },
      { finishExecution: vi.fn() }, { sendText: vi.fn() } as never,
      { findByUserId: vi.fn(async () => ({ accountId: 'acc' })) } as never,
      { findByAccountId: vi.fn(async () => [{ wxUserId: 'wx1' }]) } as never,
      (fn) => { ran = Promise.resolve().then(fn); },
    );
    svc.setFeishuResultPusher(pusher as never);
    await svc.executeTask({ id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', prompt: 'hello', fireCount: 0 } as never);
    await ran;
    expect(pusher).toHaveBeenCalledWith(11, '截止时间是 11 月 30 日，详见通知。');
  });
});

// 手动「立即执行」（docs/plan/2026-11-03-scheduled-task-run-now-technical-design.md §7.1）。
// 核心不变量：runNow 全链路不得出现 nextFireTime / finished / finishedAt / once / status /
// consecutiveFailures 写键；手动行 attempt=0：不重试、不计连续失败。
describe('ScheduledTaskService runNow（手动立即执行）', () => {
  /** 带运行记录方法的 store fake：每个用例全新 vi.fn，互不串扰。 */
  function runNowStore(task: Record<string, unknown> | null, overrides: Record<string, unknown> = {}) {
    return {
      insert: vi.fn(),
      updateById: vi.fn(),
      deleteById: vi.fn(),
      selectById: vi.fn(async () => task),
      listByUser: vi.fn(async () => []),
      listAll: vi.fn(async () => ({ records: [], total: 0 })),
      listDue: vi.fn(async () => []),
      selectRunById: vi.fn(async () => ({ id: 501, taskId: 1, fireTime: '2026-11-03 10:00:00', attempt: 0, status: 'RUNNING', sessionId: 11, startedAt: null })),
      selectRunByFire: vi.fn(async () => null),
      insertRun: vi.fn(async () => 501),
      updateRun: vi.fn(),
      ...overrides,
    } as unknown as ScheduledTaskStore & Record<string, ReturnType<typeof vi.fn>>;
  }

  function runNowService(store: ScheduledTaskStore, opts: { live?: unknown; busy?: boolean | (() => boolean); session?: unknown; budget?: unknown } = {}) {
    let ran: Promise<void> | null = null;
    const localStubs = {
      getSession: vi.fn(async () => ('session' in opts
        ? opts.session
        : { id: 11, phase: 'IDLE', sessionType: 'MAIN', userId: 7, agentId: 5 })),
      updatePhase: vi.fn(),
      saveMessage: vi.fn(async () => ({ id: 88, content: 'hello' })),
      getMessages: vi.fn(async () => []),
    };
    const busy = typeof opts.busy === 'function' ? opts.busy : opts.busy ? () => true : null;
    const svc = new ScheduledTaskService(
      store, localStubs as never, { enqueue: vi.fn() }, { executeFromEvent: vi.fn(async () => undefined) },
      { finishExecution: vi.fn() }, { sendText: vi.fn() } as never,
      { findByUserId: vi.fn(async () => null) } as never, { findByAccountId: vi.fn(async () => []) } as never,
      (fn) => { ran = Promise.resolve().then(fn); },
      (opts.live ?? null) as never,
      busy as never,
      (opts.budget ?? null) as never,
    );
    return { svc, ran: () => ran as unknown as Promise<void>, stubs: localStubs };
  }

  const ACTIVE_TASK = {
    id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 * * *', status: 'ACTIVE', name: 'daily',
    prompt: 'hello', fireCount: 3, nextFireTime: '2030-01-01 00:00:00',
  };
  /** 收尾不变量：任务行任何 patch 都不得携带档期/完结/状态键。 */
  const FORBIDDEN_KEYS = ['nextFireTime', 'finished', 'finishedAt', 'once', 'status', 'consecutiveFailures'];

  it('正常循环任务试跑：attempt=0 落行、结果字段回写、不碰档期、不计连续失败', async () => {
    const live = vi.fn(async () => undefined);
    const outcome = vi.fn(async () => ({ consecutiveFailures: 1, paused: false }));
    const store = runNowStore(ACTIVE_TASK, { recordTaskOutcome: outcome });
    const { svc, ran } = runNowService(store, { live });
    const res = await svc.runNow(1, 7);
    expect(res.taskId).toBe(1);
    expect(res.sessionId).toBe(11);
    expect(res.fireTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    await ran();
    const inserted = vi.mocked(store.insertRun).mock.calls[0][0];
    expect(inserted).toMatchObject({ taskId: 1, sessionId: 11, attempt: 0, status: 'RUNNING' });
    const runPatches = vi.mocked(store.updateRun).mock.calls.map(([r]) => r);
    expect(runPatches.some((r) => r.status === 'COMPLETED')).toBe(true);
    const persisted = vi.mocked(store.updateById).mock.calls.map(([row]) => row);
    expect(persisted.length).toBeGreaterThan(0);
    const merged = Object.assign({}, ...persisted);
    expect(merged.fireCount).toBe(4);
    expect(merged.lastFireTime).toBeTruthy();
    expect(merged.lastExecutionStatus).toBe('COMPLETED');
    for (const key of FORBIDDEN_KEYS) {
      expect(persisted.every((row) => !(key in row))).toBe(true);
    }
    expect(outcome).not.toHaveBeenCalled();
  });

  it('一次性任务试跑后 finished 仍为 0 且 nextFireTime 逐字符不变（提案点名锁死）', async () => {
    const store = runNowStore({
      id: 1, userId: 7, sessionId: 11, cronExpression: '0 0 9 1 1 *', status: 'ACTIVE', once: 1,
      prompt: 'hello', fireCount: 0, nextFireTime: '2027-01-01 09:00:00',
    });
    const { svc, ran } = runNowService(store, { live: vi.fn(async () => undefined) });
    await svc.runNow(1, 7);
    await ran();
    const persisted = vi.mocked(store.updateById).mock.calls.map(([row]) => row);
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted.every((row) => !('finished' in row) && !('nextFireTime' in row))).toBe(true);
    const runPatches = vi.mocked(store.updateRun).mock.calls.map(([r]) => r);
    expect(runPatches.some((r) => r.status === 'COMPLETED')).toBe(true);
  });

  it('PAUSED 任务试跑后仍 PAUSED（任何 patch 不含 status 键）', async () => {
    const store = runNowStore({ ...ACTIVE_TASK, status: 'PAUSED' });
    const { svc, ran } = runNowService(store, { live: vi.fn(async () => undefined) });
    await svc.runNow(1, 7);
    await ran();
    const persisted = vi.mocked(store.updateById).mock.calls.map(([row]) => row);
    expect(persisted.every((row) => !('status' in row))).toBe(true);
    const runPatches = vi.mocked(store.updateRun).mock.calls.map(([r]) => r);
    expect(runPatches.some((r) => r.status === 'COMPLETED')).toBe(true);
  });

  it('已完结（finished=1）任务试跑后不复活', async () => {
    const store = runNowStore({ ...ACTIVE_TASK, finished: 1, finishedAt: '2026-11-01 09:00:00', nextFireTime: null });
    const { svc, ran } = runNowService(store, { live: vi.fn(async () => undefined) });
    await svc.runNow(1, 7);
    await ran();
    const persisted = vi.mocked(store.updateById).mock.calls.map(([row]) => row);
    for (const key of FORBIDDEN_KEYS) {
      expect(persisted.every((row) => !(key in row))).toBe(true);
    }
  });

  it('执行失败不重试、不计连续失败（nextRetryAt 为 null、recordTaskOutcome 零调用）', async () => {
    const live = vi.fn(async () => undefined);
    const outcome = vi.fn(async () => ({ consecutiveFailures: 1, paused: false }));
    // FAILED 不是活跃相位：预检/锁内复核都放行，回读终态即 FAILED
    const store = runNowStore(ACTIVE_TASK, { recordTaskOutcome: outcome });
    const { svc, ran } = runNowService(store, { live, session: { id: 11, phase: 'FAILED', sessionType: 'MAIN', userId: 7, agentId: 5 } });
    await svc.runNow(1, 7);
    await ran();
    const runPatches = vi.mocked(store.updateRun).mock.calls.map(([r]) => r);
    const failed = runPatches.find((r) => r.status === 'FAILED');
    expect(failed).toBeTruthy();
    expect(failed?.nextRetryAt).toBeNull();
    expect(outcome).not.toHaveBeenCalled();
  });

  it('在飞中第二次 runNow 报 3055 且不落运行行', async () => {
    let release!: () => void;
    const hang = new Promise<void>((r) => { release = r; });
    const live = vi.fn(async () => hang);
    const store = runNowStore(ACTIVE_TASK);
    const { svc, ran } = runNowService(store, { live });
    await svc.runNow(1, 7);
    await vi.waitFor(() => expect(live).toHaveBeenCalledTimes(1));
    await expect(svc.runNow(1, 7)).rejects.toMatchObject({ code: ErrorCode.SCHEDULED_TASK_RUNNING.code });
    expect(store.insertRun).toHaveBeenCalledTimes(1);
    release();
    await ran();
  });

  it('会话忙时预检拒绝（3055），认领前即失败不落运行行', async () => {
    const store = runNowStore(ACTIVE_TASK);
    const { svc } = runNowService(store, { busy: true });
    await expect(svc.runNow(1, 7)).rejects.toMatchObject({
      code: ErrorCode.SCHEDULED_TASK_RUNNING.code,
      message: '绑定会话正在执行中，请稍后再试',
    });
    expect(store.insertRun).not.toHaveBeenCalled();
    expect(store.updateRun).not.toHaveBeenCalled();
  });

  it('锁内复核竞态忙：CANCELLED 收口、不计 fireCount/lastFireTime', async () => {
    let busy = false;
    const live = vi.fn(async () => undefined);
    const store = runNowStore({ ...ACTIVE_TASK, fireCount: 2 });
    const { svc, ran } = runNowService(store, { busy: () => busy, live });
    await svc.runNow(1, 7);
    busy = true; // 核心已在锁内 selectById 挂起，复核命中忙
    await ran();
    expect(live).not.toHaveBeenCalled();
    const runPatches = vi.mocked(store.updateRun).mock.calls.map(([r]) => r);
    expect(runPatches.some((r) => r.status === 'CANCELLED')).toBe(true);
    const persisted = vi.mocked(store.updateById).mock.calls.map(([row]) => row);
    expect(persisted.some((row) => 'fireCount' in row || 'lastFireTime' in row)).toBe(false);
    expect(persisted.some((row) => row.lastExecutionStatus === 'CANCELLED')).toBe(true);
  });

  it('他人任务无权限拒绝（3026）；allowNonOwner 管理员旁路放行', async () => {
    const store = runNowStore({ ...ACTIVE_TASK, userId: 9 });
    const { svc } = runNowService(store, { live: vi.fn(async () => undefined) });
    await expect(svc.runNow(1, 7)).rejects.toMatchObject({ code: ErrorCode.SCHEDULED_TASK_ACCESS_DENIED.code });
    const res = await svc.runNow(1, 7, { allowNonOwner: true });
    expect(res.taskId).toBe(1);
  });

  it('绑定会话不存在报参数错误且不落运行行（null 与抛 3002 两种契约同口径）', async () => {
    const store = runNowStore(ACTIVE_TASK);
    const { svc } = runNowService(store, { session: null });
    await expect(svc.runNow(1, 7)).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    expect(store.insertRun).not.toHaveBeenCalled();

    // 生产契约：getSession 对已删会话抛 BusinessException(SESSION_NOT_FOUND) 而非返回 null（round1 C1）
    const store2 = runNowStore(ACTIVE_TASK);
    const wrap2 = runNowService(store2, {});
    wrap2.stubs.getSession.mockRejectedValue(new BusinessException(ErrorCode.SESSION_NOT_FOUND));
    await expect(wrap2.svc.runNow(1, 7)).rejects.toMatchObject({
      code: ErrorCode.PARAM_INVALID.code,
      message: '绑定会话已不存在，无法执行',
    });
    expect(store2.insertRun).not.toHaveBeenCalled();
  });

  it('锁内任务已删除：运行行标 FAILED（任务已删除），无任务行回写', async () => {
    const store = runNowStore(ACTIVE_TASK, {
      selectById: vi.fn()
        .mockResolvedValueOnce(ACTIVE_TASK) // getTaskOwnedByUser 预检时任务还在
        .mockResolvedValue(null), // 拿锁后已被删除
    });
    const { svc, ran } = runNowService(store, { live: vi.fn(async () => undefined) });
    await svc.runNow(1, 7);
    await ran();
    const runPatches = vi.mocked(store.updateRun).mock.calls.map(([r]) => r);
    const failed = runPatches.find((r) => r.status === 'FAILED');
    expect(failed).toBeTruthy();
    expect(failed?.errorSummary).toBe('任务已删除');
    expect(store.updateById).not.toHaveBeenCalled();
  });

  it('预算 BLOCK：FAILED 收口、不执行、不计连续失败、不碰档期', async () => {
    const live = vi.fn(async () => undefined);
    const outcome = vi.fn(async () => ({ consecutiveFailures: 1, paused: false }));
    const budget = vi.fn(async () => ({ message: '超出预算' }));
    const store = runNowStore(ACTIVE_TASK, { recordTaskOutcome: outcome });
    const { svc, ran } = runNowService(store, { live, budget });
    await svc.runNow(1, 7);
    await ran();
    expect(live).not.toHaveBeenCalled();
    const runPatches = vi.mocked(store.updateRun).mock.calls.map(([r]) => r);
    expect(runPatches.some((r) => r.status === 'FAILED')).toBe(true);
    const persisted = vi.mocked(store.updateById).mock.calls.map(([row]) => row);
    expect(persisted.some((row) => row.lastExecutionStatus === 'FAILED')).toBe(true);
    for (const key of FORBIDDEN_KEYS) {
      expect(persisted.every((row) => !(key in row))).toBe(true);
    }
    expect(outcome).not.toHaveBeenCalled();
  });

  it('claimManualRun 预偏移：触发点等于 cron 档期时 +1s，绝不占用周期档期行', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-03T10:00:00+08:00'));
    try {
      const store = runNowStore({ ...ACTIVE_TASK, nextFireTime: '2026-11-03 10:00:00' });
      const { svc, ran } = runNowService(store, { live: vi.fn(async () => undefined) });
      const res = await svc.runNow(1, 7);
      await ran();
      expect(res.fireTime).toBe('2026-11-03 10:00:01');
      expect(vi.mocked(store.insertRun).mock.calls[0][0].fireTime).toBe('2026-11-03 10:00:01');
      expect(vi.mocked(store.insertRun).mock.calls[0][0].attempt).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('同秒唯一键冲突时 +1s 重试认领', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-03T10:00:00+08:00'));
    try {
      const store = runNowStore({ ...ACTIVE_TASK, nextFireTime: null }, {
        selectRunByFire: vi.fn()
          .mockResolvedValueOnce({ id: 9, taskId: 1, fireTime: '2026-11-03 10:00:00', attempt: 1, status: 'COMPLETED', sessionId: 11 })
          .mockResolvedValue(null),
      });
      const { svc, ran } = runNowService(store, { live: vi.fn(async () => undefined) });
      const res = await svc.runNow(1, 7);
      await ran();
      expect(res.fireTime).toBe('2026-11-03 10:00:01');
      expect(vi.mocked(store.insertRun).mock.calls[0][0].fireTime).toBe('2026-11-03 10:00:01');
    } finally {
      vi.useRealTimers();
    }
  });

  it('同秒冲突偏移后仍避开 cron 档期，绝不把手动行插到下一档上（round1 C2 回归）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-03T10:00:00+08:00'));
    try {
      // cron 每秒一跳，下一档 = 10:00:01；首候选 10:00:00 被既有行占用。
      // 修复前：+1s 直接落 10:00:01（cron 档期）→ 扫描器到点撞 COMPLETED 手动行 → 任务永久停摆。
      const store = runNowStore({ ...ACTIVE_TASK, cronExpression: '* * * * * *', nextFireTime: '2026-11-03 10:00:01' }, {
        selectRunByFire: vi.fn()
          .mockResolvedValueOnce({ id: 9, taskId: 1, fireTime: '2026-11-03 10:00:00', attempt: 1, status: 'COMPLETED', sessionId: 11 })
          .mockResolvedValue(null),
      });
      const { svc, ran } = runNowService(store, { live: vi.fn(async () => undefined) });
      const res = await svc.runNow(1, 7);
      await ran();
      expect(res.fireTime).toBe('2026-11-03 10:00:02');
      expect(vi.mocked(store.insertRun).mock.calls[0][0].fireTime).toBe('2026-11-03 10:00:02');
    } finally {
      vi.useRealTimers();
    }
  });

  it('触发点连续冲突 3 次后报「触发过于频繁」', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-03T10:00:00+08:00'));
    try {
      const store = runNowStore({ ...ACTIVE_TASK, nextFireTime: null }, {
        selectRunByFire: vi.fn(async () => ({ id: 9, taskId: 1, fireTime: 'x', attempt: 1, status: 'COMPLETED', sessionId: 11 })),
      });
      const { svc } = runNowService(store, { live: vi.fn(async () => undefined) });
      await expect(svc.runNow(1, 7)).rejects.toMatchObject({ code: ErrorCode.SCHEDULED_TASK_RUNNING.code });
      expect(store.insertRun).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('启动收敛不误完结手动行：attempt=0 的 RUNNING 未开跑行只标 FAILED', async () => {
    const manualRun = { id: 501, taskId: 1, fireTime: '2026-11-03 10:00:00', attempt: 0, status: 'RUNNING', sessionId: 11, startedAt: null };
    const store = runNowStore(
      { ...ACTIVE_TASK, once: 1, cronExpression: '0 0 9 1 1 *', nextFireTime: '2027-01-01 09:00:00' },
      {
        listOpenRuns: vi.fn(async () => [manualRun]),
        selectRunById: vi.fn(async () => manualRun),
      },
    );
    const { svc } = runNowService(store);
    await svc.reconcileOnStartup(true);
    const runPatches = vi.mocked(store.updateRun).mock.calls.map(([r]) => r);
    expect(runPatches.some((r) => r.id === 501 && r.status === 'FAILED' && r.nextRetryAt === null)).toBe(true);
    // 一次性任务不被补完结：updateById 零调用
    expect(store.updateById).not.toHaveBeenCalled();
  });

  it('shiftSeconds 按上海时区跨日偏移', () => {
    expect(shiftSeconds('2026-11-03 23:59:59', 2)).toBe('2026-11-04 00:00:01');
    expect(shiftSeconds('2026-11-03 10:00:00', 1)).toBe('2026-11-03 10:00:01');
    expect(shiftSeconds('bad-date', 1)).toBe('bad-date');
  });
});

function stubStore() {
  return {
    insert: vi.fn(async (t) => { t.id = 1; return 1; }),
    updateById: vi.fn(),
    deleteById: vi.fn(),
    selectById: vi.fn(async () => null),
    listByUser: vi.fn(async () => []),
    listAll: vi.fn(async () => ({ records: [], total: 0 })),
    listDue: vi.fn(async () => []),
  };
}
