import { describe, expect, it, vi } from 'vitest';
import { OpenRunService, type OpenRunDeps } from './open-run.service.js';
import type { Message, Session } from '../domain/types.js';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 11, userId: 7, agentId: 5, executionMode: 'CLOUD', phase: 'IDLE',
    permissionLevel: 'READ_ONLY', status: 'ACTIVE', sessionType: 'NORMAL',
    ...overrides,
  } as Session;
}

function message(id: number): Message {
  return { id, sessionId: 11, role: 'USER', content: 'hello' } as Message;
}

interface Harness {
  service: OpenRunService;
  sessionService: {
    getSession: ReturnType<typeof vi.fn>;
    updatePhase: ReturnType<typeof vi.fn>;
    saveMessage: ReturnType<typeof vi.fn>;
    createSession: ReturnType<typeof vi.fn>;
  };
  enqueue: ReturnType<typeof vi.fn>;
  finishExecution: ReturnType<typeof vi.fn>;
  liveExecution: ReturnType<typeof vi.fn>;
  isSessionBusy: ReturnType<typeof vi.fn>;
  budgetCheck: ReturnType<typeof vi.fn>;
}

function makeHarness(options: { agentEnabled?: number | null; agentFound?: boolean; budgetCheck?: () => Promise<{ message: string } | null> } = {}): Harness {
  const sessionService = {
    getSession: vi.fn(async () => session()),
    updatePhase: vi.fn(async () => undefined),
    saveMessage: vi.fn(async () => message(101)),
    // 位置签名镜像 SessionService.createSession 的 16 参（装配层 as unknown as 强转，
    // 两边不一致编译期不报警）：第 4 参 executionMode、第 16 参 source 是本次断言重点。
    // domain/types.ts 的 Session 没有 source 字段，回传行只取 executionMode。
    createSession: vi.fn(async (...args: unknown[]) => {
      const executionMode = args[3] as string | null | undefined;
      return session({ id: 99, executionMode: executionMode ?? 'CLOUD' });
    }),
  };
  const enqueue = vi.fn(async () => undefined);
  const finishExecution = vi.fn(async () => undefined);
  const liveExecution = vi.fn(async () => undefined);
  const budgetCheck = vi.fn(options.budgetCheck ?? (async () => null));
  const deps: OpenRunDeps = {
    sessionService: sessionService as unknown as OpenRunDeps['sessionService'],
    messageQueueService: { enqueue },
    harnessService: { executeFromEvent: vi.fn(async () => undefined) },
    taskTerminalService: { finishExecution },
    agentLookup: { findById: vi.fn(async () => (options.agentFound === false ? null : { id: 5, name: 'A', enabled: options.agentEnabled ?? 1 })) },
    isSessionBusy: vi.fn(() => false),
    liveExecution,
    budgetCheck,
  };
  return { service: new OpenRunService(deps), sessionService, enqueue, finishExecution, liveExecution, isSessionBusy: deps.isSessionBusy as unknown as Harness['isSessionBusy'], budgetCheck };
}

describe('OpenRunService（P1/P2 共用执行流）', () => {
  it('Agent 不存在 / 停用拒绝', async () => {
    const missing = makeHarness({ agentFound: false });
    await expect(missing.service.run({ userId: 7, agentId: 5, message: 'go', source: 'API' })).rejects.toMatchObject({ code: 3001 });
    const disabled = makeHarness({ agentEnabled: 0 });
    await expect(disabled.service.run({ userId: 7, agentId: 5, message: 'go', source: 'API' })).rejects.toMatchObject({ code: 2001 });
  });

  it('message 为空 / 超长拒绝', async () => {
    const h = makeHarness();
    await expect(h.service.run({ userId: 7, agentId: 5, message: '   ', source: 'API' })).rejects.toMatchObject({ code: 2001 });
    await expect(h.service.run({ userId: 7, agentId: 5, message: 'a'.repeat(32001), source: 'API' })).rejects.toMatchObject({ code: 2001 });
  });

  it('指定会话的 Agent 与请求 Agent 不一致时拒绝，且不执行', async () => {
    const h = makeHarness();
    h.sessionService.getSession.mockResolvedValue(session({ agentId: 1 }));
    await expect(h.service.run({ userId: 7, agentId: 2, message: 'go', sessionId: 11, source: 'API' }))
      .rejects.toMatchObject({ code: 2001 });
    expect(h.liveExecution).not.toHaveBeenCalled();
    expect(h.sessionService.updatePhase).not.toHaveBeenCalled();
  });

  it('指定会话：归属不匹配按不存在拒绝；SUBAGENT / LOCAL 会话拒绝', async () => {
    const h = makeHarness();
    h.sessionService.getSession.mockResolvedValue(session({ userId: 8 }));
    await expect(h.service.run({ userId: 7, agentId: 5, message: 'go', sessionId: 11, source: 'API' })).rejects.toMatchObject({ code: 3002 });

    h.sessionService.getSession.mockResolvedValue(session({ sessionType: 'SUBAGENT' }));
    await expect(h.service.run({ userId: 7, agentId: 5, message: 'go', sessionId: 11, source: 'API' })).rejects.toMatchObject({ code: 2001 });

    h.sessionService.getSession.mockResolvedValue(session({ executionMode: 'LOCAL' }));
    await expect(h.service.run({ userId: 7, agentId: 5, message: 'go', sessionId: 11, source: 'API' })).rejects.toMatchObject({ code: 2001 });
  });

  it('空闲直跑：updatePhase RUNNING → saveMessage → liveExecution 透传 source，响应带 messageId', async () => {
    const h = makeHarness();
    const result = await h.service.run({ userId: 7, agentId: 5, message: 'go', sessionId: 11, source: 'WEBHOOK', triggerId: 3 });
    expect(result).toEqual({ sessionId: 11, messageId: 101, queued: false, terminalPhase: 'COMPLETED' });
    expect(h.sessionService.updatePhase).toHaveBeenCalledWith(11, 'RUNNING');
    expect(h.sessionService.saveMessage).toHaveBeenCalledWith(11, 'USER', 'go', null, null, null, 0, null);
    expect(h.liveExecution).toHaveBeenCalledTimes(1);
    const args = h.liveExecution.mock.calls[0] as unknown[];
    expect(args[6]).toBe('WEBHOOK'); // 第 7 参 source 透传（收件箱徽标）
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.finishExecution).not.toHaveBeenCalled();
  });

  it('liveExecution 返回后会话仍 FAILED：terminalPhase=FAILED，不得标 COMPLETED', async () => {
    const h = makeHarness();
    h.sessionService.getSession
      .mockResolvedValueOnce(session()) // run 入口
      .mockResolvedValueOnce(session()) // 锁内重读
      .mockResolvedValueOnce(session({ phase: 'FAILED' })); // liveExecution 后回读
    const result = await h.service.run({ userId: 7, agentId: 5, message: 'go', sessionId: 11, source: 'API' });
    expect(result.terminalPhase).toBe('FAILED');
  });

  it('busy：入队并落 source/open_trigger_id 两列，queued=true、messageId=null', async () => {
    const h = makeHarness();
    h.isSessionBusy.mockReturnValue(true);
    const result = await h.service.run({ userId: 7, agentId: 5, message: 'go', sessionId: 11, source: 'WEBHOOK', triggerId: 3 });
    expect(result).toEqual({ sessionId: 11, messageId: null, queued: true, terminalPhase: 'COMPLETED' });
    expect(h.enqueue).toHaveBeenCalledWith(11, 7, 'go', null, null, 'WEBHOOK', 3, null);
    expect(h.sessionService.updatePhase).not.toHaveBeenCalled();
    expect(h.liveExecution).not.toHaveBeenCalled();
  });

  it('未指定会话：经 createSession 显式 CLOUD 新建', async () => {
    const h = makeHarness();
    const result = await h.service.run({ userId: 7, agentId: 5, message: 'go', source: 'API' });
    expect(result.sessionId).toBe(99);
    // 16 个位置参数逐个钉死：装配层是 as unknown as 强转，接口与真实签名不一致编译期
    // 不报警，错位会把 source 静默写进 workspace/gitCloneUrl（技术方案 §7 第 3 行）。
    // API 触发的新会话落 'openapi'（技术方案 2026-10-29 §2.1-2），不再回落默认 'web'。
    expect(h.sessionService.createSession).toHaveBeenCalledWith(
      7, 5, null, 'CLOUD',
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      'openapi',
    );
  });

  it('未指定会话 + source=SIGNAL：第 16 参落 signal（哨兵会话进独立分组）', async () => {
    const h = makeHarness();
    await h.service.run({ userId: 7, agentId: 5, message: 'go', source: 'SIGNAL' });
    const args = h.sessionService.createSession.mock.calls[0]!;
    expect(args).toHaveLength(16);
    expect(args[15]).toBe('signal');
    // 前 15 参与 API 路完全一致（只有 source 不同）
    expect(args.slice(0, 15)).toEqual([7, 5, null, 'CLOUD', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
  });

  it('未指定会话 + source=WEBHOOK：第 16 参落 openapi（与 API 同为开放接口触发）', async () => {
    const h = makeHarness();
    await h.service.run({ userId: 7, agentId: 5, message: 'go', source: 'WEBHOOK', triggerId: 3 });
    const args = h.sessionService.createSession.mock.calls[0]!;
    expect(args[15]).toBe('openapi');
  });

  it('复用既有会话（sessionId 指定）时不改写原 source', async () => {
    const h = makeHarness();
    const existing = session({ id: 11, source: 'feishu' });
    h.sessionService.getSession.mockResolvedValue(existing);
    await h.service.run({ userId: 7, agentId: 5, message: 'go', sessionId: 11, source: 'API' });
    // 复用路径不新建会话：原 source（'feishu'）保持创建时的值
    expect(h.sessionService.createSession).not.toHaveBeenCalled();
  });

  it('saveMessage 失败：回滚 phase 到 IDLE 且异常上抛', async () => {
    const h = makeHarness();
    h.sessionService.saveMessage.mockRejectedValue(new Error('db down'));
    await expect(h.service.run({ userId: 7, agentId: 5, message: 'go', sessionId: 11, source: 'API' })).rejects.toThrow('db down');
    expect(h.sessionService.updatePhase).toHaveBeenLastCalledWith(11, 'IDLE');
  });

  it('预算 BLOCK：抛 BUDGET_EXCEEDED（3041）且不建会话、不落消息（§5.7）', async () => {
    const h = makeHarness({ budgetCheck: async () => ({ message: '本月全局预算已超限：当期消耗 12 / 上限 10（成本 口径）' }) });
    await expect(h.service.run({ userId: 7, agentId: 5, message: 'go', source: 'API' }))
      .rejects.toMatchObject({ code: 3041 });
    // 检查点在 createSession / withSessionLock 之前：拒绝不留孤儿空会话
    expect(h.sessionService.createSession).not.toHaveBeenCalled();
    expect(h.sessionService.saveMessage).not.toHaveBeenCalled();
    expect(h.liveExecution).not.toHaveBeenCalled();
    expect(h.budgetCheck).toHaveBeenCalledWith({ userId: 7, agentId: 5 });
  });

  it('预算 BLOCK：指定会话路径同样在建会话前拒绝', async () => {
    const h = makeHarness({ budgetCheck: async () => ({ message: 'blocked' }) });
    await expect(h.service.run({ userId: 7, agentId: 5, message: 'go', sessionId: 11, source: 'WEBHOOK', triggerId: 3 }))
      .rejects.toMatchObject({ code: 3041 });
    expect(h.sessionService.getSession).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('预算未命中 → 正常放行（budgetCheck 返回 null）', async () => {
    const h = makeHarness();
    const result = await h.service.run({ userId: 7, agentId: 5, message: 'go', sessionId: 11, source: 'API' });
    expect(result.terminalPhase).toBe('COMPLETED');
    expect(h.budgetCheck).toHaveBeenCalledTimes(1);
  });
});
