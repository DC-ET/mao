import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebhookSecretCipher } from '../notification/task/webhook-secret-cipher.js';
import {
  WebhookTriggerService, TRIGGER_DISABLE_AFTER_FAILURES,
  TRIGGER_RATE_LIMIT_BOUND, TRIGGER_RATE_LIMIT_UNBOUND,
} from './webhook-trigger.service.js';
import { hmacSignature } from './hmac.js';
import type { FixedWindowRateLimiter } from './rate-limiter.js';
import type { MysqlWebhookTriggerRepository } from './openapi.repository.js';
import type { WebhookTrigger } from './types.js';
import type { Session } from '../domain/types.js';

function triggerRow(overrides: Partial<WebhookTrigger> = {}, secret = 'row-secret'): WebhookTrigger {
  return {
    id: 1, userId: 7, agentId: 5, sessionId: null, name: 'CI 触发器',
    pathToken: 'a'.repeat(32), secretCipher: null, enabled: 1,
    consecutiveFailures: 0, lastFiredAt: null,
    ...overrides,
  };
}

interface Harness {
  service: WebhookTriggerService;
  repo: {
    insert: ReturnType<typeof vi.fn>;
    findByPathToken: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    listByUser: ReturnType<typeof vi.fn>;
    countByUser: ReturnType<typeof vi.fn>;
    updateFields: ReturnType<typeof vi.fn>;
    deleteById: ReturnType<typeof vi.fn>;
    recordOutcome: ReturnType<typeof vi.fn>;
  };
  openRunRun: ReturnType<typeof vi.fn>;
  rateAllow: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  sessionGetSession: ReturnType<typeof vi.fn>;
}

function makeHarness(row: WebhookTrigger | null = triggerRow()): Harness {
  const cipher = new WebhookSecretCipher();
  const repo = {
    insert: vi.fn(async (t: WebhookTrigger) => 42),
    findByPathToken: vi.fn(async () => (row != null ? { ...row, secretCipher: row.secretCipher ?? cipher.encrypt('row-secret') } : null)),
    findById: vi.fn(async () => (row != null ? { ...row, secretCipher: row.secretCipher ?? cipher.encrypt('row-secret') } : null)),
    listByUser: vi.fn(async () => []),
    countByUser: vi.fn(async () => 0),
    updateFields: vi.fn(async () => undefined),
    deleteById: vi.fn(async () => true),
    recordOutcome: vi.fn(async () => ({ consecutiveFailures: 0, disabled: false })),
  };
  const getSession = vi.fn(async (id: number) => ({ id, userId: 7, executionMode: 'CLOUD', sessionType: 'NORMAL' }) as Session);
  const openRunRun = vi.fn(async () => ({ sessionId: 11, messageId: 1, queued: false, terminalPhase: 'COMPLETED' as const }));
  const rateAllow = vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 }));
  const notify = vi.fn(async () => undefined);
  const service = new WebhookTriggerService({
    triggerRepo: repo as unknown as MysqlWebhookTriggerRepository,
    sessionService: { getSession },
    agentLookup: { findById: vi.fn(async () => ({ id: 5, enabled: 1 })) },
    cipher,
    openRun: { run: openRunRun } as never,
    rateLimiter: { allow: rateAllow } as unknown as FixedWindowRateLimiter,
    disableNotifier: { notifyTriggerDisabled: notify },
  });
  return { service, repo, openRunRun, rateAllow, notify, sessionGetSession: getSession };
}

function signedHeaders(body: string, secret = 'row-secret', timestamp = String(Math.floor(Date.now() / 1000))) {
  return { timestamp, signature: hmacSignature(secret, timestamp, body) };
}

describe('WebhookTriggerService（P2）', () => {
  let body: string;
  beforeEach(() => { body = '{"status":"failed"}'; });

  it('验签通过且启用：触发 run，source=WEBHOOK 并绑定 triggerId，payload 包装带触发器名', async () => {
    const h = makeHarness();
    const outcome = await h.service.handleFire('a'.repeat(32), signedHeaders(body), body);
    expect(outcome).toMatchObject({ ok: true, userId: 7, sessionId: 11, queued: false });
    expect(h.openRunRun).toHaveBeenCalledTimes(1);
    const input = h.openRunRun.mock.calls[0][0] as { source: string; triggerId: number; message: string };
    expect(input.source).toBe('WEBHOOK');
    expect(input.triggerId).toBe(1);
    expect(input.message).toContain('收到外部 Webhook 事件（触发器：CI 触发器）');
    expect(input.message).toContain(body);
  });

  it('不存在 / 停用 / 验签失败统一 not_found（统一 404 语义）', async () => {
    const h = makeHarness(null);
    expect(await h.service.handleFire('a'.repeat(32), signedHeaders(body, 'dummy'), body)).toEqual({ ok: false, reason: 'not_found' });
    expect(h.openRunRun).not.toHaveBeenCalled();

    const disabled = makeHarness(triggerRow({ enabled: 0 }));
    expect(await disabled.service.handleFire('a'.repeat(32), signedHeaders(body), body)).toEqual({ ok: false, reason: 'not_found' });

    const h2 = makeHarness();
    expect(await h2.service.handleFire('a'.repeat(32), { timestamp: signedHeaders(body).timestamp, signature: 'sha256=bad' }, body)).toEqual({ ok: false, reason: 'not_found' });
    expect(await h2.service.handleFire('a'.repeat(32), { timestamp: null, signature: null }, body)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('查无触发器也做等时 HMAC 比较（不抛错、时序不泄露），结果仍 not_found', async () => {
    const h = makeHarness(null);
    const outcome = await h.service.handleFire('f'.repeat(32), signedHeaders(body, 'any-secret'), body);
    expect(outcome).toEqual({ ok: false, reason: 'not_found' });
  });

  it('限流：绑定会话 30/min、未绑定 10/min，超限返回 retryAfter 且不触发 run', async () => {
    const bound = makeHarness(triggerRow({ sessionId: 11 }));
    expect(TRIGGER_RATE_LIMIT_BOUND).toBe(30);
    bound.rateAllow.mockReturnValue({ allowed: false, retryAfterSeconds: 42 });
    const blocked = await bound.service.handleFire('a'.repeat(32), signedHeaders(body), body);
    expect(blocked).toEqual({ ok: false, reason: 'rate_limited', retryAfterSeconds: 42 });
    expect(bound.openRunRun).not.toHaveBeenCalled();

    const unbound = makeHarness();
    unbound.rateAllow.mockClear();
    await unbound.service.handleFire('a'.repeat(32), signedHeaders(body), body);
    expect(unbound.rateAllow).toHaveBeenCalledWith('trigger:1', TRIGGER_RATE_LIMIT_UNBOUND);
    expect(TRIGGER_RATE_LIMIT_UNBOUND).toBe(10);
  });

  it('rotateSecret 换 secret 后旧签名失效、新签名通过', async () => {
    const h = makeHarness();
    const { plainSecret } = await h.service.rotateSecret(7, 1);
    const newCipherText = (h.repo.updateFields.mock.calls.at(-1)![1] as { secretCipher?: string }).secretCipher;
    expect(newCipherText).toBeTruthy();
    // 模拟库已更新：findByPathToken 返回新 secret
    const cipher = new WebhookSecretCipher();
    h.repo.findByPathToken.mockResolvedValue({ ...triggerRow(), secretCipher: cipher.encrypt(plainSecret) });
    expect(await h.service.handleFire('a'.repeat(32), signedHeaders(body, 'row-secret'), body)).toEqual({ ok: false, reason: 'not_found' });
    expect(await h.service.handleFire('a'.repeat(32), signedHeaders(body, plainSecret), body)).toMatchObject({ ok: true });
  });

  it('队列消费侧回写：FAILED 达阈值停用并通知；COMPLETED 清零；CANCELLED 不计数', async () => {
    const h = makeHarness();
    h.repo.recordOutcome.mockResolvedValue({ consecutiveFailures: 5, disabled: true });
    h.repo.findById.mockResolvedValue(triggerRow({ enabled: 0, consecutiveFailures: 5 }));
    await h.service.handleQueueSettled(1, 'FAILED');
    expect(h.repo.recordOutcome).toHaveBeenCalledWith(1, 'FAILED', TRIGGER_DISABLE_AFTER_FAILURES, expect.any(String));
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, triggerId: 1, failures: 5 }));

    h.notify.mockClear();
    h.repo.recordOutcome.mockResolvedValue({ consecutiveFailures: 0, disabled: false });
    await h.service.handleQueueSettled(1, 'COMPLETED');
    expect(h.notify).not.toHaveBeenCalled();

    h.repo.recordOutcome.mockClear();
    await h.service.handleQueueSettled(1, 'CANCELLED');
    expect(h.repo.recordOutcome).toHaveBeenCalledWith(1, 'CANCELLED', TRIGGER_DISABLE_AFTER_FAILURES, expect.any(String));
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('直跑路径（未排队）回写终态：三种终态都就地收敛（BUG-1 回归）', async () => {
    for (const phase of ['COMPLETED', 'FAILED', 'CANCELLED'] as const) {
      const h = makeHarness();
      h.openRunRun.mockResolvedValue({ sessionId: 11, messageId: 1, queued: false, terminalPhase: phase });
      expect(await h.service.handleFire('a'.repeat(32), signedHeaders(body), body)).toMatchObject({ ok: true, queued: false });
      // recordOutcome 调用在异步链首帧同步发生，handleFire 返回时必然已入队
      expect(h.repo.recordOutcome).toHaveBeenCalledWith(1, phase, TRIGGER_DISABLE_AFTER_FAILURES, expect.any(String));
    }
  });

  it('排队路径（queued=true）不就地回写：终态交给队列消费侧，防同一次执行重复计数', async () => {
    const h = makeHarness();
    h.openRunRun.mockResolvedValue({ sessionId: 11, messageId: 1, queued: true, terminalPhase: 'COMPLETED' });
    expect(await h.service.handleFire('a'.repeat(32), signedHeaders(body), body)).toMatchObject({ ok: true, queued: true });
    expect(h.repo.recordOutcome).not.toHaveBeenCalled();
  });

  it('连续 5 次直跑失败：累加计数、达阈值停用并通知，停用后触发归 404（内存表仿真端到端）', async () => {
    const h = makeHarness();
    // 仿真 recordOutcome 真实语义（openapi.repository.ts）：FAILED +1 达阈值置 enabled=0、COMPLETED 清零
    let row = triggerRow();
    h.repo.recordOutcome.mockImplementation(async (_id: number, phase: string) => {
      if (phase === 'COMPLETED') {
        row = { ...row, consecutiveFailures: 0 };
      } else if (phase === 'FAILED') {
        const failures = Number(row.consecutiveFailures ?? 0) + 1;
        row = { ...row, consecutiveFailures: failures };
        if (failures >= TRIGGER_DISABLE_AFTER_FAILURES) {
          row = { ...row, enabled: 0 };
          return { consecutiveFailures: failures, disabled: true };
        }
      }
      return { consecutiveFailures: Number(row.consecutiveFailures ?? 0), disabled: false };
    });
    h.repo.findById.mockImplementation(async () => row);
    // 读路径跟随内存行走：停用落库后，下一次触发必须已看不到 enabled=1 的行
    const cipher = new WebhookSecretCipher();
    h.repo.findByPathToken.mockImplementation(async () => (row != null ? { ...row, secretCipher: row.secretCipher ?? cipher.encrypt('row-secret') } : null));
    h.openRunRun.mockResolvedValue({ sessionId: 11, messageId: 1, queued: false, terminalPhase: 'FAILED' });

    for (let i = 0; i < TRIGGER_DISABLE_AFTER_FAILURES; i += 1) {
      expect(await h.service.handleFire('a'.repeat(32), signedHeaders(body), body)).toMatchObject({ ok: true, queued: false });
      expect(h.repo.recordOutcome).toHaveBeenCalledTimes(i + 1);
    }
    await vi.waitFor(() =>
      expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({
        userId: 7, triggerId: 1, failures: TRIGGER_DISABLE_AFTER_FAILURES,
      })));
    expect(Number(row.consecutiveFailures)).toBe(TRIGGER_DISABLE_AFTER_FAILURES);

    // 自动停用生效：后续同一触发器的请求验签再对也归 404（统一语义）
    h.repo.recordOutcome.mockClear();
    expect(await h.service.handleFire('a'.repeat(32), signedHeaders(body), body)).toEqual({ ok: false, reason: 'not_found' });
    expect(h.repo.recordOutcome).not.toHaveBeenCalled();
  });

  it('启停操作即重置 consecutive_failures（决策 8）', async () => {
    const h = makeHarness();
    await h.service.update(7, 1, { enabled: true });
    expect(h.repo.updateFields).toHaveBeenCalledWith(1, { enabled: 1, consecutiveFailures: 0 });
  });

  it('创建：校验 Agent 与会话、加密落库、返回明文 secret 一次；上限拒绝', async () => {
    const h = makeHarness();
    const created = await h.service.create(7, { name: '新触发器', agentId: 5, sessionId: 11 });
    expect(created.plainSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(created.pathToken).toMatch(/^[0-9a-f]{32}$/);
    const inserted = h.repo.insert.mock.calls[0][0] as WebhookTrigger;
    expect(inserted.enabled).toBe(1); // 创建即启用（决策 9）
    expect(inserted.secretCipher).not.toBe(created.plainSecret);

    h.repo.countByUser.mockResolvedValue(20);
    await expect(h.service.create(7, { name: '超限', agentId: 5 })).rejects.toMatchObject({ code: 2001 });

    const localSession = makeHarness();
    localSession.sessionGetSession.mockResolvedValue({ id: 11, userId: 7, executionMode: 'LOCAL', sessionType: 'NORMAL' });
    await expect(localSession.service.create(7, { name: '本地', agentId: 5, sessionId: 11 })).rejects.toMatchObject({ code: 2001 });
  });

  it('他人触发器不可改删（按不存在处理）', async () => {
    const h = makeHarness(triggerRow({ userId: 8 }));
    await expect(h.service.update(7, 1, { name: 'x' })).rejects.toMatchObject({ code: 2001 });
    await expect(h.service.delete(7, 1)).rejects.toMatchObject({ code: 2001 });
    await expect(h.service.rotateSecret(7, 1)).rejects.toMatchObject({ code: 2001 });
  });
});
