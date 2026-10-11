import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../common/error-code.js';
import { FeedbackService, type FeedbackMessageLookup } from './feedback.service.js';
import { FeedbackRepository } from './feedback.repository.js';
import type { Db } from '../db/db.js';
import type { RunTraceService } from '../session/run-trace.service.js';
import type { RunTraceVO } from '../session/session-vo.js';

/**
 * 事务与 CAS 的行为测试：不 mock SQL，用内存行表实现 message_feedback 的
 * 状态机与 agent_experiences 的插入，钉住「同事务、全或无、并发只一个成功」。
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

interface ExperienceRow {
  id: number;
  agentId: number;
  content: string;
  sortOrder: number;
  enabled: number;
}

function makeDb() {
  const feedbackRows = new Map<number, FeedbackRow>();
  const experiences: ExperienceRow[] = [];
  let nextExperienceId = 100;
  const log: string[] = [];
  /** 串行化事务：真实 MySQL 的行锁会让并发 CAS 排队，内存 fake 用链式队列模拟。 */
  let txChain: Promise<unknown> = Promise.resolve();

  const db = {
    log,
    feedbackRows,
    experiences,
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (/FROM message_feedback WHERE id IN/.test(sql)) {
        const ids = params as number[];
        // 与真实 MySQL 一致：只返回库中存在的行（列表里混入不存在的 id 时长度对不上）
        return ids.map((id) => feedbackRows.get(id)).filter((row) => row != null).map((row) => ({ ...row })) as T[];
      }
      if (/COUNT\(\*\) AS c FROM message_feedback f\s+WHERE f.status = 'PENDING'/.test(sql)) {
        const count = [...feedbackRows.values()].filter((r) => r.status === 'PENDING').length;
        return [{ c: count }] as T[];
      }
      return [] as T[];
    },
    async queryOne<T>(sql: string): Promise<T | null> {
      if (/COUNT\(\*\) AS c FROM message_feedback f\s+WHERE f.status = 'PENDING'/.test(sql)) {
        const count = [...feedbackRows.values()].filter((r) => r.status === 'PENDING').length;
        return { c: count } as T;
      }
      return null;
    },
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
      if (/UPDATE message_feedback SET experience_id = \?, handled_by = \?/.test(sql)) {
        const [experienceId, operatorId, ...ids] = params as [number, number, ...number[]];
        for (const id of ids) {
          const row = feedbackRows.get(id);
          if (row != null) {
            row.experienceId = experienceId;
            row.handledBy = operatorId;
          }
        }
        log.push(`bind:${experienceId}`);
        return { affectedRows: ids.length } as never;
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
    async insert(_table: string, data: Record<string, unknown>): Promise<number> {
      const row: ExperienceRow = {
        id: nextExperienceId++,
        agentId: Number(data.agentId),
        content: String(data.content),
        sortOrder: Number(data.sortOrder ?? 0),
        enabled: Number(data.enabled ?? 1),
      };
      experiences.push(row);
      log.push(`insert:${row.id}`);
      return row.id;
    },
    /** 把连接包成新 Db 传回调：与 Db.transaction 同语义（事务内仓储必须用这个 tx）。 */
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      // 排队执行：模拟同一连接上的事务串行，后一个事务看到前一个的提交结果
      const run = txChain.then(async () => {
        const tx = db as unknown as Db;
        const feedbackSnapshot = [...feedbackRows.values()].map((r) => ({ ...r }));
        const experienceCount = experiences.length;
        try {
          const result = await fn(tx);
          log.push('commit');
          return result;
        } catch (e) {
          log.push('rollback');
          // 回滚内存状态：恢复进入事务前的行与经验
          for (const row of feedbackRows.values()) {
            const before = feedbackSnapshot.find((s) => s.id === row.id);
            if (before) Object.assign(row, before);
          }
          experiences.length = experienceCount;
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
    findMessageContent: vi.fn(async () => '回复原文'),
  };
}

function run(over: Partial<RunTraceVO> = {}): RunTraceVO {
  return {
    runId: 5,
    userMessagePreview: '帮我修构建',
    startedAt: '2026-10-11T10:00',
    segments: [{ kind: 'current', rounds: [], unplacedTools: [] }],
    sideCalls: [],
    subagentLinks: [],
    markers: [],
    totals: {
      wallClockMs: 0, costMicros: null, promptTokens: 0, completionTokens: 0,
      cachedTokens: 0, cacheCreationTokens: 0, toolSuccess: 0, toolError: 0,
    },
    ...over,
  };
}

function makeService(db: Db, options: { runTrace?: RunTraceService | null; agentExists?: boolean } = {}) {
  const runTrace = options.runTrace === undefined
    ? { locateRunByMessageId: vi.fn(async () => run()) } as unknown as RunTraceService
    : options.runTrace;
  const service = new FeedbackService(
    new FeedbackRepository(db),
    makeLookup(),
    async () => 9,
    async () => 2,
    db,
    runTrace,
    async () => options.agentExists ?? true,
  );
  return { service, runTrace };
}

const CONTENT = '改构建脚本前先看 package.json 的 scripts，避免直接改 CI 配置。';

describe('FeedbackService.convertToExperience', () => {
  it('PENDING → CONVERTED：四列均正确，经验写入目标 Agent 且 enabled=1', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([{ id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: null }]);
    const { service } = makeService(db);
    const result = await service.convertToExperience(9, { feedbackIds: [1], agentId: 7, experiences: [{ content: CONTENT }] });
    expect(result.experienceId).toBe(100);
    const row = db.feedbackRows.get(1)!;
    expect(row.status).toBe('CONVERTED');
    expect(row.experienceId).toBe(100);
    expect(row.handledBy).toBe(9);
    expect(db.experiences).toHaveLength(1);
    expect(db.experiences[0]).toMatchObject({ agentId: 7, content: CONTENT, enabled: 1 });
    // CAS 在事务内第一行，先于经验插入
    expect(db.log.indexOf('cas:CONVERTED:1/1')).toBeLessThan(db.log.indexOf('insert:100'));
    expect(db.log).toContain('commit');
  });

  it('一次转换写两条经验时 experience_id 只记第一条', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([{ id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: null }]);
    const { service } = makeService(db);
    const result = await service.convertToExperience(9, {
      feedbackIds: [1],
      agentId: 7,
      experiences: [{ content: CONTENT }, { content: '第二条经验：跑测试前先确认依赖已安装。' }],
    });
    expect(db.experiences).toHaveLength(2);
    expect(result.experienceId).toBe(100);
    expect(db.feedbackRows.get(1)!.experienceId).toBe(100);
  });

  it('重复 convert：第二次抛 FEEDBACK_ALREADY_HANDLED，不重复写经验', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([{ id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: null }]);
    const { service } = makeService(db);
    await service.convertToExperience(9, { feedbackIds: [1], agentId: 7, experiences: [{ content: CONTENT }] });
    await expect(service.convertToExperience(9, { feedbackIds: [1], agentId: 7, experiences: [{ content: CONTENT }] }))
      .rejects.toMatchObject({ code: ErrorCode.FEEDBACK_ALREADY_HANDLED.code });
    expect(db.experiences).toHaveLength(1);
    expect(db.feedbackRows.get(1)!.experienceId).toBe(100);
  });

  it('并发 convert 同一批：只有一个事务成功，经验条数不翻倍', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([{ id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: null }]);
    const { service } = makeService(db);
    const results = await Promise.allSettled([
      service.convertToExperience(9, { feedbackIds: [1], agentId: 7, experiences: [{ content: CONTENT }] }),
      service.convertToExperience(9, { feedbackIds: [1], agentId: 7, experiences: [{ content: CONTENT }] }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.code).toBe(ErrorCode.FEEDBACK_ALREADY_HANDLED.code);
    expect(db.experiences).toHaveLength(1);
  });

  it('经验内容超 300 字：事务回滚，反馈仍为 PENDING（可重试）', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([{ id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: null }]);
    const { service } = makeService(db);
    await expect(service.convertToExperience(9, { feedbackIds: [1], agentId: 7, experiences: [{ content: 'x'.repeat(301) }] }))
      .rejects.toMatchObject({ code: ErrorCode.AGENT_EXPERIENCE_CONTENT_INVALID.code });
    expect(db.feedbackRows.get(1)!.status).toBe('PENDING');
    expect(db.experiences).toHaveLength(0);
    expect(db.log).not.toContain('commit');
  });

  it('convert 与 dismiss 混批（部分已处理）：整体失败，无部分写入', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([
      { id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: null },
      { id: 2, status: 'DISMISSED', agentId: 2, messageId: 12, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: 9 },
    ]);
    const { service } = makeService(db);
    await expect(service.convertToExperience(9, { feedbackIds: [1, 2], agentId: 7, experiences: [{ content: CONTENT }] }))
      .rejects.toMatchObject({ code: ErrorCode.FEEDBACK_ALREADY_HANDLED.code });
    expect(db.feedbackRows.get(1)!.status).toBe('PENDING');
    expect(db.experiences).toHaveLength(0);
  });

  it('agentId 不存在：AGENT_NOT_FOUND，不写任何东西', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([{ id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: null }]);
    const { service } = makeService(db, { agentExists: false });
    await expect(service.convertToExperience(9, { feedbackIds: [1], agentId: 999, experiences: [{ content: CONTENT }] }))
      .rejects.toMatchObject({ code: ErrorCode.AGENT_NOT_FOUND.code });
    expect(db.experiences).toHaveLength(0);
    expect(db.feedbackRows.get(1)!.status).toBe('PENDING');
    expect(db.log).toHaveLength(0);
  });

  it('反馈 id 不存在：PARAM_INVALID，不进事务', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([{ id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: null }]);
    const { service } = makeService(db);
    await expect(service.convertToExperience(9, { feedbackIds: [1, 42], agentId: 7, experiences: [{ content: CONTENT }] }))
      .rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    // 预校验就失败：没有开事务，也没有写经验
    expect(db.experiences).toHaveLength(0);
    expect(db.log).not.toContain('commit');
  });

  it('id 存在但已被处理：FEEDBACK_ALREADY_HANDLED（与「不存在」口径区分）', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([{ id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: null }]);
    seedFeedback([{ id: 2, status: 'DISMISSED', agentId: 2, messageId: 12, sessionId: 5, reason: 'OTHER', experienceId: null, handledBy: 9 }]);
    const { service } = makeService(db);
    await expect(service.convertToExperience(9, { feedbackIds: [1, 2], agentId: 7, experiences: [{ content: CONTENT }] }))
      .rejects.toMatchObject({ code: ErrorCode.FEEDBACK_ALREADY_HANDLED.code });
    expect(db.feedbackRows.get(1)!.status).toBe('PENDING');
    expect(db.experiences).toHaveLength(0);
  });

  it('批量去重：重复传同一个 id 不误判成并发冲突', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([{ id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: null }]);
    const { service } = makeService(db);
    const result = await service.convertToExperience(9, { feedbackIds: [1, 1, 1], agentId: 7, experiences: [{ content: CONTENT }] });
    expect(result.experienceId).toBe(100);
    expect(db.log).toContain('cas:CONVERTED:1/1');
  });

  it('空 id 列表 / 非法 id / 超上限均被拒绝', async () => {
    const { db } = makeDb();
    const { service } = makeService(db);
    await expect(service.convertToExperience(9, { feedbackIds: [], agentId: 7, experiences: [{ content: CONTENT }] }))
      .rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(service.convertToExperience(9, { feedbackIds: [0], agentId: 7, experiences: [{ content: CONTENT }] }))
      .rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(service.convertToExperience(9, {
      feedbackIds: Array.from({ length: 101 }, (_, i) => i + 1),
      agentId: 7,
      experiences: [{ content: CONTENT }],
    })).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
  });

  it('经验条数为 0 或超过 2 条被拒绝', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([{ id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: null }]);
    const { service } = makeService(db);
    await expect(service.convertToExperience(9, { feedbackIds: [1], agentId: 7, experiences: [] }))
      .rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(service.convertToExperience(9, {
      feedbackIds: [1], agentId: 7,
      experiences: [{ content: '甲' }, { content: '乙' }, { content: '丙' }],
    })).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    expect(db.experiences).toHaveLength(0);
  });
});

describe('FeedbackService.dismiss', () => {
  it('PENDING → DISMISSED 并记录处理人', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([{ id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: null }]);
    const { service } = makeService(db);
    await expect(service.dismiss(9, [1])).resolves.toEqual({ updated: 1 });
    const row = db.feedbackRows.get(1)!;
    expect(row.status).toBe('DISMISSED');
    expect(row.handledBy).toBe(9);
    // DISMISSED 不写 experience_id
    expect(row.experienceId).toBeNull();
    expect(db.experiences).toHaveLength(0);
  });

  it('重复 dismiss 抛 FEEDBACK_ALREADY_HANDLED（终态不可回退）', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([{ id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: null }]);
    const { service } = makeService(db);
    await service.dismiss(9, [1]);
    await expect(service.dismiss(9, [1])).rejects.toMatchObject({ code: ErrorCode.FEEDBACK_ALREADY_HANDLED.code });
  });

  it('批量里混入已处理行：整体失败', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([
      { id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: null },
      { id: 2, status: 'CONVERTED', agentId: 2, messageId: 12, sessionId: 5, reason: 'WRONG_RESULT', experienceId: 100, handledBy: 9 },
    ]);
    const { service } = makeService(db);
    await expect(service.dismiss(9, [1, 2])).rejects.toMatchObject({ code: ErrorCode.FEEDBACK_ALREADY_HANDLED.code });
    // 全或无：第一行也不被写
    expect(db.feedbackRows.get(1)!.status).toBe('PENDING');
  });
});

describe('FeedbackService.buildDraftMaterials', () => {
  it('按消息定位 run：用户原话取锚点预览，轨迹序列化后进入原料', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([{ id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: null }]);
    const { service, runTrace } = makeService(db);
    const materials = await service.buildDraftMaterials([1]);
    expect(materials).toHaveLength(1);
    expect(materials[0]).toMatchObject({
      reason: 'WRONG_RESULT',
      reasonLabel: '结果错误',
      messageId: 11,
      userText: '帮我修构建',
      assistantText: '回复原文',
    });
    expect(materials[0].traceText).toBe('（该轮没有任何工具调用记录）');
    // 定位用会话 + 消息 id，不用翻页
    expect((runTrace as unknown as { locateRunByMessageId: ReturnType<typeof vi.fn> }).locateRunByMessageId)
      .toHaveBeenCalledWith(5, 11);
  });

  it('run 定位不到时仍能以原因 + 对话原文起草', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([{ id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'SLOW_RESPONSE', experienceId: null, handledBy: null }]);
    const { service } = makeService(db, { runTrace: { locateRunByMessageId: vi.fn(async () => null) } as unknown as RunTraceService });
    const materials = await service.buildDraftMaterials([1]);
    expect(materials[0].traceText).toBe('（该消息的运行轨迹不可用）');
    expect(materials[0].reasonLabel).toBe('处理速度慢');
    expect(materials[0].assistantText).toBe('回复原文');
  });

  it('已处理的反馈行不进入原料装配', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([{ id: 1, status: 'CONVERTED', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: 100, handledBy: 9 }]);
    const { service } = makeService(db);
    await expect(service.buildDraftMaterials([1])).rejects.toMatchObject({ code: ErrorCode.FEEDBACK_ALREADY_HANDLED.code });
  });

  it('未装配轨迹服务时报内部错误，不静默返回空原料', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([{ id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: null }]);
    const { service } = makeService(db, { runTrace: null });
    await expect(service.buildDraftMaterials([1])).rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR.code });
  });

  it('未装配事务连接时 convert 报内部错误，不写经验', async () => {
    const { db, seedFeedback } = makeDb();
    seedFeedback([{ id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT', experienceId: null, handledBy: null }]);
    const service = new FeedbackService(
      new FeedbackRepository(db),
      makeLookup(),
      async () => 9,
      async () => 2,
      null,
      { locateRunByMessageId: vi.fn(async () => run()) } as unknown as RunTraceService,
      async () => true,
    );
    await expect(service.convertToExperience(9, { feedbackIds: [1], agentId: 7, experiences: [{ content: CONTENT }] }))
      .rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR.code });
    expect(db.experiences).toHaveLength(0);
  });
});
