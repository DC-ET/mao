import { describe, expect, it, vi } from 'vitest';
import { OutboundDeliveryScheduler } from './outbound-delivery.scheduler.js';
import type { OutboundDelivery } from './types.js';

/**
 * 抛出型失败收口回归（docs/code-review/2026-11-10-logic-bug-audit-01.md BUG-3）：
 * deliver 的 catch 只打日志会让行停在 SENDING，被 recoverInterrupted 反复复位重认领
 * 且 attempt_count 不推进，永远到不了 3 次重试后的 FAILED 终态与审计。
 * 修复口径：抛出与 result 失败同走 attempt+1 的退避/终态链。
 */

type DeliveryRow = OutboundDelivery & { id: number };

/** 内存版投递行：claim PENDING→SENDING、scheduleRetry/markFailed/markSucceeded 与 SQL 同字段语义。 */
function fakeDeliveryRepo(row: DeliveryRow) {
  const calls = { scheduleRetry: 0, markFailed: 0, markSucceeded: 0 };
  const repo = {
    async listDue(): Promise<OutboundDelivery[]> {
      return row.status === 'PENDING' ? [{ ...row }] : [];
    },
    async claim(id: number): Promise<boolean> {
      if (row.id !== id || row.status !== 'PENDING') return false;
      row.status = 'SENDING';
      return true;
    },
    async findById(id: number): Promise<OutboundDelivery | null> {
      return row.id === id ? { ...row } : null;
    },
    async recoverInterrupted(): Promise<void> {},
    async scheduleRetry(id: number, attemptCount: number, httpStatus: number | null, error: string | null, nextRetryAt: string): Promise<void> {
      void id;
      calls.scheduleRetry++;
      row.status = 'PENDING';
      row.attemptCount = attemptCount;
      row.lastHttpStatus = httpStatus;
      row.lastError = error;
      row.nextRetryAt = nextRetryAt;
    },
    async markFailed(id: number, attemptCount: number, httpStatus: number | null, error: string | null): Promise<void> {
      void id;
      calls.markFailed++;
      row.status = 'FAILED';
      row.attemptCount = attemptCount;
      row.lastHttpStatus = httpStatus;
      row.lastError = error;
      row.nextRetryAt = null;
    },
    async markSucceeded(id: number, attemptCount: number, httpStatus: number | null, now: string): Promise<void> {
      void id;
      calls.markSucceeded++;
      row.status = 'SUCCEEDED';
      row.attemptCount = attemptCount;
      row.lastHttpStatus = httpStatus;
      row.sentAt = now;
    },
  };
  return { repo, calls };
}

const SUBSCRIPTION = {
  id: 5,
  userId: 7,
  event: 'task.completed',
  targetUrl: 'https://hook.example/x',
  secretCipher: 'cipher-text',
  enabled: 1,
};

function baseRow(): DeliveryRow {
  return {
    id: 1,
    subscriptionId: 5,
    event: 'task.completed',
    payload: '{}',
    status: 'PENDING',
    attemptCount: 0,
    nextRetryAt: null,
    lastHttpStatus: null,
    lastError: null,
    createdAt: null,
    sentAt: null,
  };
}

function makeScheduler(
  row: DeliveryRow,
  overrides?: { decrypt?: () => string; send?: () => Promise<{ success: boolean; httpStatus: number | null; error?: string | null }> },
) {
  const { repo, calls } = fakeDeliveryRepo(row);
  const audit = { recordDeliveryFailed: vi.fn(async () => undefined) };
  // execute 捕获 deliver 的 promise：dispatchDueDeliveries 只负责认领，回写在异步链里
  const pending: Promise<unknown>[] = [];
  const scheduler = new OutboundDeliveryScheduler({
    deliveryRepo: repo as never,
    subscriptionRepo: { findById: vi.fn(async () => ({ ...SUBSCRIPTION })) } as never,
    cipher: { decrypt: overrides?.decrypt ?? (() => 'secret') } as never,
    sender: { send: overrides?.send ?? (async () => ({ success: true, httpStatus: 200 })) } as never,
    auditRecorder: audit,
    execute: (fn: () => unknown) => { pending.push(Promise.resolve().then(fn)); },
  });
  const dispatchOnce = async () => {
    await scheduler.dispatchDueDeliveries();
    await Promise.all(pending.splice(0));
  };
  return { scheduler, calls, audit, dispatchOnce };
}

describe('OutboundDeliveryScheduler 抛出型失败收口', () => {
  it('secret 解密抛出走退避重试而不是停在 SENDING', async () => {
    const row = baseRow();
    const { calls, dispatchOnce } = makeScheduler(row, {
      decrypt: () => { throw new Error('解密失败: key rotated'); },
    });

    await dispatchOnce();

    expect(calls.scheduleRetry).toBe(1);
    expect(calls.markFailed).toBe(0);
    expect(row.status).toBe('PENDING');
    expect(row.attemptCount).toBe(1);
    expect(row.lastError).toContain('解密失败');
    expect(row.nextRetryAt).toBeTruthy();
  });

  it('连续抛出共 4 次尝试后终态 FAILED 并落审计', async () => {
    const row = baseRow();
    const { calls, audit, dispatchOnce } = makeScheduler(row, {
      decrypt: () => { throw new Error('解密失败: key rotated'); },
    });

    for (let round = 0; round < 4; round++) {
      await dispatchOnce();
    }

    // 1/5/25 分钟退避共 3 次，第 4 次尝试失败进终态
    expect(calls.scheduleRetry).toBe(3);
    expect(calls.markFailed).toBe(1);
    expect(row.status).toBe('FAILED');
    expect(row.attemptCount).toBe(4);
    expect(row.nextRetryAt).toBeNull();
    expect(audit.recordDeliveryFailed).toHaveBeenCalledTimes(1);
    expect(audit.recordDeliveryFailed).toHaveBeenCalledWith(expect.objectContaining({
      subscriptionId: 5,
      event: 'task.completed',
      targetUrl: 'https://hook.example/x',
      userId: 7,
    }));
  });

  it('解密成功且发送成功时照常 markSucceeded（对照：收口链不误伤正常路径）', async () => {
    const row = baseRow();
    const { calls, audit, dispatchOnce } = makeScheduler(row);

    await dispatchOnce();

    expect(calls.markSucceeded).toBe(1);
    expect(row.status).toBe('SUCCEEDED');
    expect(row.attemptCount).toBe(1);
    expect(audit.recordDeliveryFailed).not.toHaveBeenCalled();
  });
});
