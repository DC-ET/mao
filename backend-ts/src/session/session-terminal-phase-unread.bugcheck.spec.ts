import { describe, expect, it } from 'vitest';
import { SessionService } from './session.service.js';
import { TaskTerminalService } from './task-terminal.service.js';
import type { Session } from './types.js';

/**
 * 存在性证明：session.service.ts 自带的私有 isTerminalPhase 把 IDLE 也算成终态，
 * 与仓内其余口径全部矛盾：
 * - task-terminal.service.ts:14 `TERMINAL = new Set(['COMPLETED','FAILED','CANCELLED'])`
 * - streaming-ws-handler.ts:2142 私有 isTerminalPhase = COMPLETED/FAILED/CANCELLED
 * - session/util/session-group-key.ts:238 ACTIVE_PHASES = RUNNING/RESUMING/WAITING_APPROVAL/CANCELLING
 *   （IDLE 既不活跃也不终态；streaming-ws-handler.ts:1507 的注释也这么写）
 *
 * 后果一（误写未读）：RUNNING -> IDLE 的回滚路径被判成「任务刚结束」，
 * 写入 unread=1。回滚路径（openapi/open-run.service.ts:151、schedule/scheduled-task.service.ts:680）
 * 恰恰是「用户消息都没落库、助手更没有回复」的失败路径，会话却挂上红点，
 * 并被 desktop/src/utils/focusSort.ts 的未读优先级顶到列表最前。
 *
 * 后果二（漏写未读 / DB 与 WS 打架）：IDLE -> 终态 时 `!isTerminalPhase(oldPhase)` 为假，
 * DB 不写 unread；而同一次 finishExecution 里 task-terminal.service.ts:131-136 的
 * WS session_status 广播 unread=true（该行注释自称「与 updatePhase 的 DB 写入保持一致」）。
 * 前端收到红点，刷新后按 DB 渲染，红点丢失。
 */
function serviceWithSession(session: Session): {
  service: SessionService;
  lastFields: () => Record<string, unknown> | null;
} {
  let captured: Record<string, unknown> | null = null;
  const sessionRepo = {
    findById: async () => session,
    updateFields: async (_id: number, fields: Record<string, unknown>) => {
      captured = fields;
    },
  };
  const service = new SessionService(
    sessionRepo as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, lastFields: () => captured };
}

function sessionWith(overrides: Partial<Session>): Session {
  return {
    id: 1,
    userId: 7,
    sessionType: 'NORMAL',
    phase: 'RUNNING',
    projectKey: 'my-project',
    workspace: '/data/workspace/projects/my-project',
    startedAt: '2026-10-21 10:00:00',
    elapsedMs: 0,
    unread: 0,
    ...overrides,
  } as Session;
}

describe('SessionService.updatePhase 终态集合口径', () => {
  it('回滚到 IDLE 不应置未读（用户消息都没落库，助手更没有回复）', async () => {
    const { service, lastFields } = serviceWithSession(sessionWith({ phase: 'RUNNING' }));
    // openapi/open-run.service.ts:151 / schedule/scheduled-task.service.ts:680 的回滚路径
    await service.updatePhase(1, 'IDLE');
    expect(lastFields()?.unread).toBeUndefined();
  });

  it('从 IDLE 进入终态应置未读（与 WS session_status 的 unread=true 保持一致）', async () => {
    const { service, lastFields } = serviceWithSession(sessionWith({ phase: 'IDLE', startedAt: null }));
    await service.updatePhase(1, 'COMPLETED');
    expect(lastFields()?.unread).toBe(1);
  });

  it('从 IDLE 进入失败终态同样应置未读', async () => {
    const { service, lastFields } = serviceWithSession(sessionWith({ phase: 'IDLE', startedAt: null }));
    await service.updatePhase(1, 'FAILED');
    expect(lastFields()?.unread).toBe(1);
  });

  it('对照：RUNNING -> COMPLETED 仍置未读（现有正确行为不应被改坏）', async () => {
    const { service, lastFields } = serviceWithSession(sessionWith({ phase: 'RUNNING' }));
    await service.updatePhase(1, 'COMPLETED');
    expect(lastFields()?.unread).toBe(1);
  });

  it('对照：已经是终态再落一次终态不重复置未读', async () => {
    const { service, lastFields } = serviceWithSession(sessionWith({ phase: 'COMPLETED', startedAt: null }));
    await service.updatePhase(1, 'COMPLETED');
    expect(lastFields()?.unread).toBeUndefined();
  });
});

/**
 * 同一缺陷在 TaskTerminalService 出口的体现：DB 写入与 WS 广播必须一致。
 * 这里让 TaskTerminalService 复用真实的 SessionService.updatePhase，
 * 直接比对「DB 里写的 unread」与「WS session_status 广播的 unread」。
 */
function terminalHarness(session: Session): {
  service: TaskTerminalService;
  statusEvents: Array<Record<string, unknown>>;
  lastFields: () => Record<string, unknown> | null;
} {
  let captured: Record<string, unknown> | null = null;
  const sessionRepo = {
    findById: async () => session,
    updateFields: async (_id: number, fields: Record<string, unknown>) => {
      captured = fields;
    },
  };
  const real = new SessionService(
    sessionRepo as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const sessionService = {
    getSession: async (id: number) => real.getSession(id),
    updatePhase: async (id: number, phase: string) => {
      await real.updatePhase(id, phase);
    },
    updateRuntimeStatus: async () => {},
    markLastMessageFinished: async () => {},
  };
  const statusEvents: Array<Record<string, unknown>> = [];
  const registry = {
    clearSessionExecution: () => {},
    send: () => {},
    sendWithResult: async (_userId: number, event: { type: string; data: Record<string, unknown> }) => {
      if (event.type === 'session_status') statusEvents.push(event.data);
      return { successCount: 1 };
    },
  };
  const service = new TaskTerminalService(
    sessionService as never,
    registry as never,
    { prepare: async () => null } as never,
    { publish: () => {}, publishAtRoot: () => {} } as never,
    (fn) => { void fn(); },
    null,
    (fn) => { void fn(); },
    { recordTaskTerminal: async () => {} } as never,
  );
  return { service, statusEvents, lastFields: () => captured };
}

describe('TaskTerminalService 终态未读：DB 写入与 WS 广播一致', () => {
  it('会话仍在 IDLE 就进入终态时，DB 的 unread 应与 WS 广播的 unread 一致', async () => {
    const { service, statusEvents, lastFields } = terminalHarness(sessionWith({ phase: 'IDLE', startedAt: null }));
    await service.finishExecution(1, 7, 'COMPLETED', 'exec-1');
    expect({
      dbUnread: lastFields()?.unread,
      wsUnread: statusEvents[0]?.unread,
    }).toEqual({ dbUnread: 1, wsUnread: true });
  });

  it('对照组：RUNNING -> COMPLETED 时 DB 与 WS 也一致', async () => {
    const { service, statusEvents, lastFields } = terminalHarness(sessionWith({ phase: 'RUNNING' }));
    await service.finishExecution(1, 7, 'COMPLETED', 'exec-1');
    expect({
      dbUnread: lastFields()?.unread,
      wsUnread: statusEvents[0]?.unread,
    }).toEqual({ dbUnread: 1, wsUnread: true });
  });
});
