import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../common/error-code.js';
import { FeedbackService, type FeedbackMessageLookup } from './feedback.service.js';
import { FeedbackRepository } from './feedback.repository.js';
import type { Db } from '../db/db.js';

/**
 * 事务与 CAS 的行为测试：不 mock SQL，用内存行表实现 message_feedback 的状态机，
 * 钉住「同事务、全或无、重复处理被拒」。
 */

interface FeedbackRow {
  id: number;
  status: string;
  agentId: number | null;
  messageId: number;
  sessionId: number;
  reason: string;
  experienceId: number | null;
  handledBy: number | null;
}

function makeDb() {
  const feedbackRows = new Map<number, FeedbackRow>();
  const log: string[] = [];
  /** 串行化事务：真实 MySQL 的行锁会让并发 CAS 排队，内存 fake 用链式队列模拟。 */
  let txChain: Promise<unknown> = Promise.resolve();

  const db = {
    log,
    feedbackRows,
    async execute(sql: string, params: unknown[] = []) {
      if (/UPDATE message_feedback SET status = \?, handled_by = \?, handled_at = NOW\(3\)/.test(sql)) {
        const [status, operatorId, ...ids] = params as [string, number, ...number[]];
        // MySQL 真实语义：只更新仍为 PENDING 的行；affectedRows 可能小于 IN 列表长度
        let affected = 0;
        for (const id of ids) {
          const row = feedbackRows.get(id);
          if (row == null || row.status !== 'PENDING') continue;
          row.status = status;
          row.handledBy = operatorId;
          affected += 1;
        }
        log.push(`cas:${status}:${affected}/${ids.length}`);
        return { affectedRows: affected } as never;
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
    /** 把连接包成新 Db 传回调：与 Db.transaction 同语义（事务内仓储必须用这个 tx）。 */
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      // 排队执行：模拟同一连接上的事务串行，后一个事务看到前一个的提交结果
      const run = txChain.then(async () => {
        const tx = db as unknown as Db;
        const feedbackSnapshot = [...feedbackRows.values()].map((r) => ({ ...r }));
        try {
          const result = await fn(tx);
          log.push('commit');
          return result;
        } catch (e) {
          log.push('rollback');
          // 回滚内存状态：恢复进入事务前的行
          for (const row of feedbackRows.values()) {
            const before = feedbackSnapshot.find((s) => s.id === row.id);
            if (before) Object.assign(row, before);
          }
          throw e;
        }
      });
      // 队列只记录完成，不吞异常（异常由各自的调用方观察）
      txChain = run.then(() => undefined, () => undefined);
      return run;
    },
  };

  function seedFeedback(rows: FeedbackRow[]): void {
    for (const row of rows) feedbackRows.set(row.id, { ...row });
  }

  return { db, seedFeedback };
}

function makeLookup(): FeedbackMessageLookup {
  return {
    findAssistantMessageOwner: vi.fn(async () => null),
    findLatestAssistantMessageId: vi.fn(async () => null),
  };
}

function makeService(db: Db) {
  return new FeedbackService(
    new FeedbackRepository(db),
    makeLookup(),
    async () => 9,
    async () => 2,
    db,
  );
}

describe('FeedbackService.dismiss', () => {
  it('PENDING → DISMISSED 并记录处理人', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([{ id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: null }]);
    const service = makeService(db);
    await expect(service.dismiss(9, [1])).resolves.toEqual({ updated: 1 });
    const row = db.feedbackRows.get(1)!;
    expect(row.status).toBe('DISMISSED');
    expect(row.handledBy).toBe(9);
    expect(db.log).toContain('commit');
  });

  it('重复 dismiss 抛 FEEDBACK_ALREADY_HANDLED（终态不可回退）', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([{ id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: null }]);
    const service = makeService(db);
    await service.dismiss(9, [1]);
    await expect(service.dismiss(9, [1])).rejects.toMatchObject({ code: ErrorCode.FEEDBACK_ALREADY_HANDLED.code });
  });

  it('批量里混入已处理行：整体失败并回滚，无部分写入', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([
      { id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: null },
      { id: 2, status: 'CONVERTED', agentId: 2, messageId: 12, sessionId: 5, reason: 'WRONG_RESULT', experienceId: 100, handledBy: 9 },
    ]);
    const service = makeService(db);
    await expect(service.dismiss(9, [1, 2])).rejects.toMatchObject({ code: ErrorCode.FEEDBACK_ALREADY_HANDLED.code });
    // 全或无：CAS 先行改过第一行，但事务回滚后恢复 PENDING
    expect(db.feedbackRows.get(1)!.status).toBe('PENDING');
    expect(db.log).toContain('rollback');
  });

  it('并发 dismiss 同一批：只有一个事务成功', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([{ id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: null }]);
    const service = makeService(db);
    const results = await Promise.allSettled([
      service.dismiss(9, [1]),
      service.dismiss(9, [1]),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.code).toBe(ErrorCode.FEEDBACK_ALREADY_HANDLED.code);
  });

  it('批量去重：重复传同一个 id 不误判成并发冲突', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([{ id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: null }]);
    const service = makeService(db);
    await expect(service.dismiss(9, [1, 1, 1])).resolves.toEqual({ updated: 1 });
    expect(db.log).toContain('cas:DISMISSED:1/1');
  });

  it('空 id 列表 / 非法 id / 超上限均被拒绝', async () => {
    const { db } = makeDb();
    const service = makeService(db);
    await expect(service.dismiss(9, [])).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(service.dismiss(9, [0])).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(service.dismiss(9, Array.from({ length: 101 }, (_, i) => i + 1)))
      .rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
  });

  it('未装配事务连接时报内部错误，不写任何状态', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([{ id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: null }]);
    const service = new FeedbackService(
      new FeedbackRepository(db),
      makeLookup(),
      async () => 9,
      async () => 2,
      null,
    );
    await expect(service.dismiss(9, [1])).rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR.code });
    expect(db.feedbackRows.get(1)!.status).toBe('PENDING');
  });
});
