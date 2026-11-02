import { describe, expect, it, vi } from 'vitest';
import { WebhookSecretCipher } from '../notification/task/webhook-secret-cipher.js';
import { OutboundSubscriptionService, assertGenericWebhookUrl, MAX_SUBSCRIPTIONS_PER_USER } from './outbound-subscription.service.js';
import { hmacSignature } from './hmac.js';
import type { MysqlOutboundDeliveryRepository, MysqlOutboundSubscriptionRepository } from './openapi.repository.js';
import type { OutboundSubscription } from './types.js';

function makeRepos(subscriptions: OutboundSubscription[] = []) {
  const subscriptionRepo = {
    insert: vi.fn(async (s: OutboundSubscription) => 9),
    listByUser: vi.fn(async () => subscriptions),
    listEnabledByEvent: vi.fn(async (_userId: number, event: string) => subscriptions.filter((s) => s.event === event && Number(s.enabled) === 1)),
    findById: vi.fn(async (id: number) => subscriptions.find((s) => s.id === id) ?? null),
    countByUser: vi.fn(async () => subscriptions.length),
    setEnabled: vi.fn(async () => true),
    deleteById: vi.fn(async () => true),
  };
  const deliveryRepo = {
    insert: vi.fn(async () => 1),
    listBySubscription: vi.fn(async () => []),
    listDue: vi.fn(async () => []),
    claim: vi.fn(async () => true),
    recoverInterrupted: vi.fn(async () => undefined),
    markSucceeded: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    scheduleRetry: vi.fn(async () => undefined),
    findById: vi.fn(async () => null),
    deleteHistory: vi.fn(async () => undefined),
  };
  return { subscriptionRepo, deliveryRepo };
}

function subRow(overrides: Partial<OutboundSubscription> = {}): OutboundSubscription {
  const cipher = new WebhookSecretCipher();
  return {
    id: 1, userId: 7, event: 'task.completed', targetUrl: 'https://hooks.example.com/x',
    secretCipher: cipher.encrypt('sub-secret'), enabled: 1,
    ...overrides,
  };
}

/** sendTest 依赖的发送器 stub（成功 2xx）。 */
function makeSender(result: { success: boolean; retryable: boolean; httpStatus: number | null; error: string | null } = { success: true, retryable: false, httpStatus: 200, error: null }) {
  return { send: vi.fn(async () => result) };
}

describe('assertGenericWebhookUrl（通用化 URL 校验）', () => {
  it('https 通过并归一化；http / userinfo / hash / 非法格式拒绝', () => {
    expect(assertGenericWebhookUrl('https://ci.example.com/hook?k=1')).toBe('https://ci.example.com/hook?k=1');
    expect(() => assertGenericWebhookUrl('http://ci.example.com/hook')).toThrow();
    expect(() => assertGenericWebhookUrl('https://user:pass@ci.example.com/hook')).toThrow();
    expect(() => assertGenericWebhookUrl('https://ci.example.com/hook#frag')).toThrow();
    expect(() => assertGenericWebhookUrl('not a url')).toThrow();
    expect(() => assertGenericWebhookUrl('')).toThrow();
    expect(() => assertGenericWebhookUrl(null)).toThrow();
  });

  it('放开域名白名单：任意域名的 https 地址均可（含 IP 直连）', () => {
    expect(assertGenericWebhookUrl('https://192.168.1.5:8443/callback')).toBeTruthy();
    expect(assertGenericWebhookUrl('https://oapi.dingtalk.com/robot/send')).toBeTruthy();
  });
});

describe('OutboundSubscriptionService（P3）', () => {
  it('创建：事件校验、URL 归一、secret 加密落库、明文只返回一次；上限拒绝', async () => {
    const { subscriptionRepo } = makeRepos();
    const cipher = new WebhookSecretCipher();
    const service = new OutboundSubscriptionService({ subscriptionRepo: subscriptionRepo as unknown as MysqlOutboundSubscriptionRepository, deliveryRepo: {} as never, cipher, sender: makeSender() as never });
    const created = await service.create(7, { event: 'task.failed', targetUrl: 'https://ci.example.com/hook' });
    expect(created.plainSecret).toMatch(/^[0-9a-f]{64}$/);
    const inserted = subscriptionRepo.insert.mock.calls[0][0] as OutboundSubscription;
    expect(inserted.secretCipher).not.toBe(created.plainSecret);
    expect(inserted.targetUrl).toBe('https://ci.example.com/hook');

    await expect(service.create(7, { event: 'agent.exploded', targetUrl: 'https://ci.example.com' })).rejects.toMatchObject({ code: 2001 });
    subscriptionRepo.countByUser.mockResolvedValue(MAX_SUBSCRIPTIONS_PER_USER);
    await expect(service.create(7, { event: 'task.failed', targetUrl: 'https://ci.example.com' })).rejects.toMatchObject({ code: 2001 });
  });

  it('dispatchTaskTerminal：COMPLETED → task.completed 订阅各落一条 PENDING 投递，payload 契约完整', async () => {
    const { subscriptionRepo, deliveryRepo } = makeRepos([subRow(), subRow({ id: 2, enabled: 0 }), subRow({ id: 3, event: 'task.failed' })]);
    const service = new OutboundSubscriptionService({ subscriptionRepo: subscriptionRepo as unknown as MysqlOutboundSubscriptionRepository, deliveryRepo: deliveryRepo as unknown as MysqlOutboundDeliveryRepository, cipher: new WebhookSecretCipher(), sender: makeSender() as never });
    service.dispatchTaskTerminal({ userId: 7, sessionId: 11, phase: 'COMPLETED', executionId: 'e-1', title: 'T', failureReason: null, source: 'WEBHOOK' });
    await vi.waitFor(() => expect(deliveryRepo.insert).toHaveBeenCalledTimes(1)); // 停用行与非本事件订阅不投
    const row = deliveryRepo.insert.mock.calls[0][0] as { subscriptionId: number; event: string; payload: string; status: string };
    expect(row.subscriptionId).toBe(1);
    expect(row.status).toBe('PENDING');
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect(payload).toMatchObject({ event: 'task.completed', sessionId: 11, userId: 7, executionId: 'e-1', phase: 'COMPLETED', title: 'T', source: 'WEBHOOK' });
    expect(payload.sentAt).toBeTruthy();

    // FAILED phase 只投 task.failed 订阅
    deliveryRepo.insert.mockClear();
    service.dispatchTaskTerminal({ userId: 7, sessionId: 11, phase: 'FAILED', executionId: 'e-2', title: 'T', failureReason: 'boom' });
    await vi.waitFor(() => expect(deliveryRepo.insert).toHaveBeenCalledTimes(1));
    expect((deliveryRepo.insert.mock.calls[0][0] as { event: string }).event).toBe('task.failed');
  });

  it('dispatchQuestionPending：落 question.pending 投递且带 requestId', async () => {
    const { deliveryRepo } = makeRepos([subRow({ event: 'question.pending' })]);
    const service = new OutboundSubscriptionService({ subscriptionRepo: { listEnabledByEvent: vi.fn(async () => [subRow({ event: 'question.pending' })]) } as never, deliveryRepo: deliveryRepo as unknown as MysqlOutboundDeliveryRepository, cipher: new WebhookSecretCipher(), sender: makeSender() as never });
    service.dispatchQuestionPending({ userId: 7, sessionId: 11, requestId: 'req-1' });
    await vi.waitFor(() => expect(deliveryRepo.insert).toHaveBeenCalled());
    const payload = JSON.parse((deliveryRepo.insert.mock.calls[0][0] as { payload: string }).payload) as Record<string, unknown>;
    expect(payload).toMatchObject({ event: 'question.pending', requestId: 'req-1', sessionId: 11 });
  });

  it('最近投递：他人订阅按不存在拒绝', async () => {
    const { subscriptionRepo } = makeRepos([subRow({ userId: 8 })]);
    const service = new OutboundSubscriptionService({ subscriptionRepo: subscriptionRepo as unknown as MysqlOutboundSubscriptionRepository, deliveryRepo: {} as never, cipher: new WebhookSecretCipher(), sender: makeSender() as never });
    await expect(service.listRecentDeliveries(7, 1)).rejects.toMatchObject({ code: 2001 });
  });
});

describe('OutboundSubscriptionService.sendTest（测试投递，零写库）', () => {
  const baseDeps = (subscriptionRepo: unknown, deliveryRepo: unknown = {}, sender?: { send: ReturnType<typeof vi.fn> }) => ({
    subscriptionRepo: subscriptionRepo as unknown as MysqlOutboundSubscriptionRepository,
    deliveryRepo: deliveryRepo as never,
    cipher: new WebhookSecretCipher(),
    sender: (sender ?? makeSender()) as never,
  });

  it('属主：解密 secret、按订阅事件同步投递并返回 HTTP 状态与耗时；签名函数复用 hmacSignature', async () => {
    const { subscriptionRepo } = makeRepos([subRow({ event: 'task.completed' })]);
    const sender = makeSender();
    const service = new OutboundSubscriptionService(baseDeps(subscriptionRepo, {}, sender));
    const result = await service.sendTest(7, 1);
    expect(result).toMatchObject({ success: true, httpStatus: 200, error: null });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(sender.send).toHaveBeenCalledTimes(1);
    const [url, secret, event, payload, sign] = sender.send.mock.calls[0];
    expect(url).toBe('https://hooks.example.com/x');
    expect(secret).toBe('sub-secret'); // secretCipher 解密后的明文
    expect(event).toBe('task.completed');
    expect(sign).toBe(hmacSignature);
    expect(payload).toMatchObject({
      event: 'task.completed', test: true, sessionId: 0, userId: 7, executionId: null,
      phase: 'COMPLETED', title: '【Mao 测试】出站订阅连通性验证', failureReason: null, source: 'MANUAL',
    });
    expect((payload as Record<string, unknown>).sentAt).toBeTruthy();
  });

  it('四种事件的测试 payload 均带 test:true 且与真实事件同构', async () => {
    for (const event of ['task.completed', 'task.failed', 'question.pending', 'digest.daily'] as const) {
      const { subscriptionRepo } = makeRepos([subRow({ event })]);
      const sender = makeSender();
      const service = new OutboundSubscriptionService(baseDeps(subscriptionRepo, {}, sender));
      await service.sendTest(7, 1);
      const payload = sender.send.mock.calls[0][3] as Record<string, unknown>;
      expect(payload.test).toBe(true);
      expect(payload.event).toBe(event);
      expect(payload.sentAt).toBeTruthy();
      if (event === 'task.failed') expect(payload.failureReason).toBe('【Mao 测试】模拟任务失败');
      if (event === 'question.pending') expect(typeof payload.requestId).toBe('string');
      if (event === 'digest.daily') expect(payload.coveredDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('目标失败 / 网络异常结果透传（不抛、不重试）；非属主与不存在拒绝且不发送', async () => {
    const { subscriptionRepo } = makeRepos([subRow()]);
    const failSender = makeSender({ success: false, retryable: false, httpStatus: 401, error: '目标返回 401' });
    const service = new OutboundSubscriptionService(baseDeps(subscriptionRepo, {}, failSender));
    await expect(service.sendTest(7, 1)).resolves.toMatchObject({ success: false, httpStatus: 401, error: '目标返回 401' });

    const netSender = makeSender({ success: false, retryable: true, httpStatus: null, error: 'The operation was aborted due to timeout' });
    const service2 = new OutboundSubscriptionService(baseDeps(subscriptionRepo, {}, netSender));
    await expect(service2.sendTest(7, 1)).resolves.toMatchObject({ success: false, httpStatus: null });

    const { subscriptionRepo: repo2 } = makeRepos([subRow({ userId: 8 })]);
    const notCalledSender = { send: vi.fn() };
    const service3 = new OutboundSubscriptionService(baseDeps(repo2, {}, notCalledSender as never));
    await expect(service3.sendTest(7, 1)).rejects.toMatchObject({ code: 2001, message: '订阅不存在' });
    await expect(service3.sendTest(7, 999)).rejects.toMatchObject({ code: 2001, message: '订阅不存在' });
    expect(notCalledSender.send).not.toHaveBeenCalled();
  });

  it('停用订阅同样可测试；deliveryRepo 全程零写入', async () => {
    const deliveryRepo = { insert: vi.fn() };
    const { subscriptionRepo } = makeRepos([subRow({ enabled: 0 })]);
    const sender = makeSender({ success: true, retryable: false, httpStatus: 204, error: null });
    const service = new OutboundSubscriptionService(baseDeps(subscriptionRepo, deliveryRepo, sender));
    await expect(service.sendTest(7, 1)).resolves.toMatchObject({ success: true, httpStatus: 204 });
    expect(deliveryRepo.insert).not.toHaveBeenCalled();
  });
});

describe('GenericHttpWebhookSender（经 scheduler 联测）', () => {
  it('签名头齐全且逐字节签名请求体；2xx 成功、429/5xx 可重试、4xx 不可重试', async () => {
    const { GenericHttpWebhookSender } = await import('./generic-webhook-sender.js');
    const { OutboundDeliveryScheduler } = await import('./outbound-delivery.scheduler.js');
    const cipher = new WebhookSecretCipher();
    const secret = 'sub-secret';
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
      seen.push({ url, headers: init.headers, body: init.body });
      return { ok: false, status: seen.length === 1 ? 500 : 400, text: async () => '' };
    });
    const sender = new GenericHttpWebhookSender(fetchImpl as never);
    const subscriptionRepo = {
      findById: vi.fn(async () => subRow()),
    };
    let deliveredRow: { id: number; attempt: number; status: string; http: number | null } | null = null;
    const deliveryRepo = {
      findById: vi.fn(async () => ({ id: 5, subscriptionId: 1, event: 'task.completed', payload: '{"event":"task.completed"}', attemptCount: 0 })),
      markFailed: vi.fn(async (id: number, attempt: number, http: number | null) => { deliveredRow = { id, attempt, status: 'FAILED', http }; }),
      scheduleRetry: vi.fn(async () => undefined),
      markSucceeded: vi.fn(async () => undefined),
      recoverInterrupted: vi.fn(async () => undefined),
      listDue: vi.fn(async () => []),
    };
    const scheduler = new OutboundDeliveryScheduler({
      deliveryRepo: deliveryRepo as never,
      subscriptionRepo: subscriptionRepo as never,
      cipher,
      sender,
      execute: (fn) => void Promise.resolve().then(fn),
    });
    // 第 1 次投递：500 → scheduleRetry（可重试）
    await (scheduler as unknown as { deliver(id: number): Promise<void> }).deliver(5);
    expect(deliveryRepo.scheduleRetry).toHaveBeenCalled();
    // 第 2 次直接构造 attempt=3（≥ 退避表长度-1 后）400 → 不可重试 → FAILED
    deliveryRepo.findById.mockResolvedValue({ id: 5, subscriptionId: 1, event: 'task.completed', payload: '{"event":"task.completed"}', attemptCount: 3 });
    await (scheduler as unknown as { deliver(id: number): Promise<void> }).deliver(5);
    expect(deliveryRepo.markFailed).toHaveBeenCalledWith(5, 4, 400, '目标返回 400');
    void deliveredRow;

    // 签名头与请求体逐字节一致
    const first = seen[0];
    const timestamp = first.headers['X-Mao-Timestamp'];
    expect(first.headers['X-Mao-Event']).toBe('task.completed');
    expect(first.headers['X-Mao-Signature']).toBe(hmacSignature(secret, timestamp, first.body));
    expect(first.body).toBe('{"event":"task.completed"}');
  });
});
