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
}

function makeHarness(options: { agentEnabled?: number | null; agentFound?: boolean } = {}): Harness {
  const sessionService = {
    getSession: vi.fn(async () => session()),
    updatePhase: vi.fn(async () => undefined),
    saveMessage: vi.fn(async () => message(101)),
    createSession: vi.fn(async (_userId: number, _agentId: number, _title: string | null, executionMode: string | null | undefined) => session({ id: 99, executionMode: executionMode ?? 'CLOUD' })),
  };
  const enqueue = vi.fn(async () => undefined);
  const finishExecution = vi.fn(async () => undefined);
  const liveExecution = vi.fn(async () => undefined);
  const deps: OpenRunDeps = {
    sessionService: sessionService as unknown as OpenRunDeps['sessionService'],
    messageQueueService: { enqueue },
    harnessService: { executeFromEvent: vi.fn(async () => undefined) },
    taskTerminalService: { finishExecution },
    agentLookup: { findById: vi.fn(async () => (options.agentFound === false ? null : { id: 5, name: 'A', enabled: options.agentEnabled ?? 1 })) },
    isSessionBusy: vi.fn(() => false),
    liveExecution,
  };
  return { service: new OpenRunService(deps), sessionService, enqueue, finishExecution, liveExecution, isSessionBusy: deps.isSessionBusy as unknown as Harness['isSessionBusy'] };
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
    expect(h.enqueue).toHaveBeenCalledWith(11, 7, 'go', null, null, 'WEBHOOK', 3);
    expect(h.sessionService.updatePhase).not.toHaveBeenCalled();
    expect(h.liveExecution).not.toHaveBeenCalled();
  });

  it('未指定会话：经 createSession 显式 CLOUD 新建', async () => {
    const h = makeHarness();
    const result = await h.service.run({ userId: 7, agentId: 5, message: 'go', source: 'API' });
    expect(result.sessionId).toBe(99);
    expect(h.sessionService.createSession).toHaveBeenCalledWith(7, 5, null, 'CLOUD');
  });

  it('saveMessage 失败：回滚 phase 到 IDLE 且异常上抛', async () => {
    const h = makeHarness();
    h.sessionService.saveMessage.mockRejectedValue(new Error('db down'));
    await expect(h.service.run({ userId: 7, agentId: 5, message: 'go', sessionId: 11, source: 'API' })).rejects.toThrow('db down');
    expect(h.sessionService.updatePhase).toHaveBeenLastCalledWith(11, 'IDLE');
  });
});
