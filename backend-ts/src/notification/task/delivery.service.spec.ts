import { describe, expect, it, vi } from 'vitest';
import { PENDING_ESCALATION_DELAY_MS, TaskNotificationDeliveryService } from './delivery.service.js';
import type { DeliveryStore, QueueLister, TaskNotificationMetrics } from './delivery.service.js';
import type { TaskNotificationPreferenceService } from './preference.service.js';
import { WEIXIN_PROJECT_KEY } from '../../domain/types.js';
import type { Session } from '../../domain/types.js';

describe('TaskNotificationDeliveryService', () => {
  const store: DeliveryStore = { insert: vi.fn(async () => 1), updateById: vi.fn() };
  const preferenceService = { findEnabled: vi.fn() } as unknown as TaskNotificationPreferenceService;
  const queueService: QueueLister = { listPending: vi.fn(async () => []) };
  const metrics = { created: vi.fn(), suppressedByWebSocket: vi.fn(), sent: vi.fn(), retried: vi.fn(), pending: vi.fn() } as TaskNotificationMetrics;
  const service = new TaskNotificationDeliveryService(store, preferenceService, queueService, metrics);

  function session(type: string): Session {
    return { id: 10, userId: 7, title: '任务标题', sessionType: type };
  }

  it('createsWaitingDeliveryForEnabledUserTask', async () => {
    vi.mocked(queueService.listPending).mockResolvedValue([]);
    vi.mocked(preferenceService.findEnabled).mockResolvedValue({
      userId: 7, channel: 'FEISHU', webhookCiphertext: 'encrypted', enabled: 1,
    });
    const result = await service.prepare(session('NORMAL'), 'COMPLETED', 'exec-1', null);
    expect(result).not.toBeNull();
    expect(store.insert).toHaveBeenCalled();
    const inserted = vi.mocked(store.insert).mock.calls[0][0];
    expect(inserted.eventKey).toBe('10:exec-1:COMPLETED');
    expect(inserted.status).toBe('WAITING_WS');
  });

  it('excludesCancelledSubagentAndQueuedIntermediateRound', async () => {
    vi.mocked(store.insert).mockClear();
    expect(await service.prepare(session('NORMAL'), 'CANCELLED', 'exec-1', null)).toBeNull();
    expect(await service.prepare(session('SUBAGENT'), 'COMPLETED', 'exec-2', null)).toBeNull();
    vi.mocked(queueService.listPending).mockResolvedValueOnce([{ id: 1, sessionId: 10 }]);
    expect(await service.prepare(session('NORMAL'), 'FAILED', 'exec-3', null)).toBeNull();
    expect(store.insert).not.toHaveBeenCalled();
  });

  it('excludesWeixinSession', async () => {
    vi.mocked(store.insert).mockClear();
    const weixin = session('NORMAL');
    weixin.projectKey = WEIXIN_PROJECT_KEY;
    expect(await service.prepare(weixin, 'COMPLETED', 'exec-1', null)).toBeNull();
    expect(store.insert).not.toHaveBeenCalled();
  });

  function shanghaiMs(text: string): number {
    return new Date(text.replace(' ', 'T') + '+08:00').getTime();
  }

  function enabledPreference() {
    vi.mocked(preferenceService.findEnabled).mockResolvedValue({
      userId: 7, channel: 'DINGTALK', webhookCiphertext: 'encrypted', enabled: 1,
    });
  }

  it('createsPendingAskUserEscalationForEnabledUser', async () => {
    const askStore: DeliveryStore = { insert: vi.fn(async () => 1), updateById: vi.fn(), updateIfStatus: vi.fn(async () => true) };
    const askMetrics = { created: vi.fn(), suppressedByWebSocket: vi.fn(), sent: vi.fn(), retried: vi.fn(), pending: vi.fn() } as TaskNotificationMetrics;
    const askService = new TaskNotificationDeliveryService(askStore, preferenceService, queueService, askMetrics);
    enabledPreference();
    const before = Date.now();
    const result = await askService.prepareEscalation({
      session: session('NORMAL'), phase: 'ASK_USER', requestId: 'req-uuid-1', delayMs: 0,
    });
    expect(result).not.toBeNull();
    const inserted = vi.mocked(askStore.insert).mock.calls[0][0];
    expect(inserted.eventKey).toBe('ask-user:10:req-uuid-1');
    expect(inserted.terminalPhase).toBe('ASK_USER');
    expect(inserted.status).toBe('PENDING');
    expect(inserted.titleSnapshot).toBe('任务标题');
    expect(inserted.executionId).toBe('req-uuid-1');
    expect(Math.abs(shanghaiMs(inserted.nextRetryAt!) - before)).toBeLessThan(2000);
    expect(askMetrics.created).toHaveBeenCalledWith('DINGTALK', 'ASK_USER');
  });

  it('delaysApprovalEscalationByThreeMinutes', async () => {
    const askStore: DeliveryStore = { insert: vi.fn(async () => 1), updateById: vi.fn() };
    const askMetrics = { created: vi.fn(), suppressedByWebSocket: vi.fn(), sent: vi.fn(), retried: vi.fn(), pending: vi.fn() } as TaskNotificationMetrics;
    const askService = new TaskNotificationDeliveryService(askStore, preferenceService, queueService, askMetrics);
    enabledPreference();
    const before = Date.now();
    const result = await askService.prepareEscalation({
      session: session('NORMAL'), phase: 'APPROVAL', requestId: 'req-approval', delayMs: PENDING_ESCALATION_DELAY_MS,
    });
    expect(result).not.toBeNull();
    const inserted = vi.mocked(askStore.insert).mock.calls[0][0];
    expect(inserted.eventKey).toBe('approval:10:req-approval');
    expect(inserted.terminalPhase).toBe('APPROVAL');
    expect(inserted.status).toBe('PENDING');
    expect(Math.abs(shanghaiMs(inserted.nextRetryAt!) - (before + PENDING_ESCALATION_DELAY_MS))).toBeLessThan(2000);
    expect(askMetrics.created).toHaveBeenCalledWith('DINGTALK', 'APPROVAL');
  });

  it('escalationSkipsAskUserOnSubagentButStillWritesApproval', async () => {
    const askStore: DeliveryStore = { insert: vi.fn(async () => 1), updateById: vi.fn() };
    const askService = new TaskNotificationDeliveryService(askStore, preferenceService, queueService, metrics);
    enabledPreference();
    expect(await askService.prepareEscalation({
      session: session('SUBAGENT'), phase: 'ASK_USER', requestId: 'q', delayMs: 0,
    })).toBeNull();
    const approval = await askService.prepareEscalation({
      session: session('SUBAGENT'), phase: 'APPROVAL', requestId: 'a', delayMs: PENDING_ESCALATION_DELAY_MS,
    });
    expect(approval).not.toBeNull();
    expect(vi.mocked(askStore.insert).mock.calls[0][0].userId).toBe(7);
    expect(vi.mocked(askStore.insert).mock.calls[0][0].eventKey).toBe('approval:10:a');
  });

  it('escalationSkipsWeixinNullSessionAndDisabledPreference', async () => {
    const askStore: DeliveryStore = { insert: vi.fn(async () => 1), updateById: vi.fn() };
    const askService = new TaskNotificationDeliveryService(askStore, preferenceService, queueService, metrics);
    enabledPreference();
    const weixin = session('NORMAL');
    weixin.projectKey = WEIXIN_PROJECT_KEY;
    expect(await askService.prepareEscalation({
      session: weixin, phase: 'APPROVAL', requestId: 'w', delayMs: 0,
    })).toBeNull();
    expect(await askService.prepareEscalation({
      session: null, phase: 'ASK_USER', requestId: 'n', delayMs: 0,
    })).toBeNull();
    expect(await askService.prepareEscalation({
      session: { id: 10, title: 'x' }, phase: 'APPROVAL', requestId: 'u', delayMs: 0,
    })).toBeNull();
    vi.mocked(preferenceService.findEnabled).mockResolvedValue(null);
    expect(await askService.prepareEscalation({
      session: session('NORMAL'), phase: 'ASK_USER', requestId: 'off', delayMs: 0,
    })).toBeNull();
    expect(askStore.insert).not.toHaveBeenCalled();
  });

  it('escalationDoesNotReadTheMessageQueue', async () => {
    const askStore: DeliveryStore = { insert: vi.fn(async () => 1), updateById: vi.fn() };
    const throwingQueue: QueueLister = { listPending: vi.fn(async () => { throw new Error('should not read queue'); }) };
    const askService = new TaskNotificationDeliveryService(askStore, preferenceService, throwingQueue, metrics);
    enabledPreference();
    const result = await askService.prepareEscalation({
      session: session('NORMAL'), phase: 'APPROVAL', requestId: 'q', delayMs: 0,
    });
    expect(result).not.toBeNull();
    expect(throwingQueue.listPending).not.toHaveBeenCalled();
  });

  it('escalationDuplicateEventKeyReturnsNull', async () => {
    const askStore: DeliveryStore = {
      insert: vi.fn(async () => { throw new Error("Duplicate entry 'approval:10:same' for key 'uk_task_notification_event'"); }),
      updateById: vi.fn(),
    };
    const askService = new TaskNotificationDeliveryService(askStore, preferenceService, queueService, metrics);
    enabledPreference();
    await expect(askService.prepareEscalation({
      session: session('NORMAL'), phase: 'APPROVAL', requestId: 'same', delayMs: 0,
    })).resolves.toBeNull();
  });

  it('suppressByEventKeyReusesPendingSuppression', async () => {
    const askStore: DeliveryStore = {
      insert: vi.fn(async () => 1),
      updateById: vi.fn(),
      updateIfStatus: vi.fn(async () => true),
      findByEventKey: vi.fn(async () => ({ id: 21, eventKey: 'approval:10:rid', status: 'PENDING' })),
    };
    const askService = new TaskNotificationDeliveryService(askStore, preferenceService, queueService, metrics);
    await askService.suppressByEventKey('approval:10:rid');
    expect(askStore.updateIfStatus).toHaveBeenCalledWith(21, 'PENDING', {
      status: 'SUPPRESSED_WS',
      nextRetryAt: null,
    });
  });

  it('suppressByEventKeyNoopsWhenRowMissing', async () => {
    const askStore: DeliveryStore = {
      insert: vi.fn(async () => 1),
      updateById: vi.fn(),
      updateIfStatus: vi.fn(async () => true),
      findByEventKey: vi.fn(async () => null),
    };
    const askService = new TaskNotificationDeliveryService(askStore, preferenceService, queueService, metrics);
    await expect(askService.suppressByEventKey('approval:10:missing')).resolves.toBeUndefined();
    expect(askStore.updateIfStatus).not.toHaveBeenCalled();
  });

  it('suppressesPendingAskUserDeliveryViaStatusCas', async () => {
    const askStore: DeliveryStore = { insert: vi.fn(async () => 1), updateById: vi.fn(), updateIfStatus: vi.fn(async () => true) };
    const askService = new TaskNotificationDeliveryService(askStore, preferenceService, queueService, metrics);
    await askService.suppressPending({ id: 5 });
    expect(askStore.updateIfStatus).toHaveBeenCalledWith(5, 'PENDING', {
      status: 'SUPPRESSED_WS',
      nextRetryAt: null,
    });
    expect(askStore.updateIfStatus).toHaveBeenCalledTimes(1);
  });

  it('suppressesAskUserDeliveryAlreadyClaimedAsSending', async () => {
    // 提问超时（15 分钟）后抑制：行已被调度器 claim 成 SENDING，仅 CAS PENDING 会静默失败，
    // 用户仍会收到已失效的提问通知。必须补 SENDING 兜底。
    const askStore: DeliveryStore = {
      insert: vi.fn(async () => 1),
      updateById: vi.fn(),
      updateIfStatus: vi.fn(async (_id, expected) => expected === 'SENDING'),
    };
    const askService = new TaskNotificationDeliveryService(askStore, preferenceService, queueService, metrics);
    await askService.suppressPending({ id: 9 });
    expect(vi.mocked(askStore.updateIfStatus)!.mock.calls.map((c) => c[1])).toEqual(['PENDING', 'SENDING']);
  });

  it('suppressPendingDoesNotTouchTerminalRows', async () => {
    // 已 SUCCEEDED / FAILED 的行不应被改状态，也不应报错中断等待方。
    const askStore: DeliveryStore = { insert: vi.fn(async () => 1), updateById: vi.fn(), updateIfStatus: vi.fn(async () => false) };
    const askService = new TaskNotificationDeliveryService(askStore, preferenceService, queueService, metrics);
    await expect(askService.suppressPending({ id: 11 })).resolves.toBeUndefined();
    expect(askStore.updateById).not.toHaveBeenCalled();
  });

  it('suppressPendingFallsBackToUpdateWithoutCasSupport', async () => {
    const plainStore: DeliveryStore = { insert: vi.fn(async () => 1), updateById: vi.fn() };
    const plainService = new TaskNotificationDeliveryService(plainStore, preferenceService, queueService, metrics);
    await plainService.suppressPending({ id: 5 });
    expect(plainStore.updateById).toHaveBeenCalledWith({
      id: 5,
      status: 'SUPPRESSED_WS',
      nextRetryAt: null,
    });
  });
});
