import { describe, expect, it, vi } from 'vitest';
import { TaskNotificationDeliveryService } from './delivery.service.js';
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

  it('createsPendingAskUserDeliveryForEnabledUser', async () => {
    const askStore: DeliveryStore = { insert: vi.fn(async () => 1), updateById: vi.fn(), updateIfStatus: vi.fn(async () => true) };
    const askMetrics = { created: vi.fn(), suppressedByWebSocket: vi.fn(), sent: vi.fn(), retried: vi.fn(), pending: vi.fn() } as TaskNotificationMetrics;
    const askService = new TaskNotificationDeliveryService(askStore, preferenceService, queueService, askMetrics);
    vi.mocked(preferenceService.findEnabled).mockResolvedValue({
      userId: 7, channel: 'DINGTALK', webhookCiphertext: 'encrypted', enabled: 1,
    });
    const result = await askService.prepareAskUser(10, 7, 'req-uuid-1', '任务标题');
    expect(result).not.toBeNull();
    const inserted = vi.mocked(askStore.insert).mock.calls[0][0];
    expect(inserted.eventKey).toBe('ask-user:10:req-uuid-1');
    expect(inserted.terminalPhase).toBe('ASK_USER');
    expect(inserted.status).toBe('PENDING');
    expect(inserted.titleSnapshot).toBe('任务标题');
    expect(askMetrics.created).toHaveBeenCalledWith('DINGTALK', 'ASK_USER');
  });

  it('skipsAskUserDeliveryWhenPreferenceMissing', async () => {
    const skipStore: DeliveryStore = { insert: vi.fn(async () => 1), updateById: vi.fn() };
    const skipService = new TaskNotificationDeliveryService(skipStore, preferenceService, queueService, metrics);
    vi.mocked(preferenceService.findEnabled).mockResolvedValue(null);
    const result = await skipService.prepareAskUser(10, 7, 'req-uuid-2', '任务标题');
    expect(result).toBeNull();
    expect(skipStore.insert).not.toHaveBeenCalled();
  });

  it('suppressesPendingAskUserDeliveryViaStatusCas', async () => {
    const askStore: DeliveryStore = { insert: vi.fn(async () => 1), updateById: vi.fn(), updateIfStatus: vi.fn(async () => true) };
    const askService = new TaskNotificationDeliveryService(askStore, preferenceService, queueService, metrics);
    await askService.suppressPending({ id: 5 });
    expect(askStore.updateIfStatus).toHaveBeenCalledWith(5, 'PENDING', {
      status: 'SUPPRESSED_WS',
      nextRetryAt: null,
    });
  });

  it('suppressPendingIgnoresRowsWithoutCasSupport', async () => {
    const plainStore: DeliveryStore = { insert: vi.fn(async () => 1), updateById: vi.fn() };
    const plainService = new TaskNotificationDeliveryService(plainStore, preferenceService, queueService, metrics);
    await expect(plainService.suppressPending({ id: 5 })).resolves.toBeUndefined();
    expect(plainStore.updateById).not.toHaveBeenCalled();
  });
});
