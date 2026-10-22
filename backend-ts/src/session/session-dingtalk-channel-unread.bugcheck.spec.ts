import { describe, expect, it } from 'vitest';
import { SessionService } from './session.service.js';
import { TaskTerminalService } from './task-terminal.service.js';
import type { Session } from './types.js';

/**
 * 存在性证明：钉钉机器人渠道会话与飞书/微信一致，终态不计未读。
 *
 * updatePhase 的注释写明「微信/飞书通道会话由机器人等外部触发，终态不计未读」；
 * 钉钉同属机器人渠道（workspace 含 /dingtalk-chat/、projectKey 为
 * dingtalk-{botId}-private-{userId} 或 dingtalk-chat-{botId}-{cid}），但条件漏判，
 * 终态会写 unread=1，会话被顶到列表前面并显示红点。
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

function runningSession(overrides: Partial<Session>): Session {
  return {
    id: 1,
    userId: 7,
    sessionType: 'NORMAL',
    phase: 'RUNNING',
    startedAt: '2026-10-21 10:00:00',
    elapsedMs: 0,
    ...overrides,
  } as Session;
}

describe('SessionService.updatePhase 通道会话未读', () => {
  it('钉钉私聊会话终态不置未读', async () => {
    const { service, lastFields } = serviceWithSession(runningSession({
      projectKey: 'dingtalk-2-private-42',
      workspace: '/data/workspace/dingtalk-chat/2/p2p-42',
    }));
    await service.updatePhase(1, 'COMPLETED');
    expect(lastFields()?.unread).toBeUndefined();
  });

  it('钉钉群聊会话终态不置未读', async () => {
    const { service, lastFields } = serviceWithSession(runningSession({
      projectKey: 'dingtalk-chat-2-cid-abc',
      workspace: '/data/workspace/dingtalk-chat/2/cid-abc',
    }));
    await service.updatePhase(1, 'FAILED');
    expect(lastFields()?.unread).toBeUndefined();
  });

  it('对照：普通手动会话终态仍置未读', async () => {
    const { service, lastFields } = serviceWithSession(runningSession({
      projectKey: 'my-project',
      workspace: '/data/workspace/projects/my-project',
    }));
    await service.updatePhase(1, 'COMPLETED');
    expect(lastFields()?.unread).toBe(1);
  });

  it('对照：飞书通道会话终态不置未读', async () => {
    const { service, lastFields } = serviceWithSession(runningSession({
      projectKey: 'feishu-chat-2-cid-abc',
      workspace: '/data/workspace/feishu-chat/2/cid-abc',
    }));
    await service.updatePhase(1, 'COMPLETED');
    expect(lastFields()?.unread).toBeUndefined();
  });
});

/**
 * 同一缺陷在 TaskTerminalService 的两个出口：session_status WS 事件的 unread，
 * 以及站内收件箱记录（注释同样写明「微信/飞书通道会话由机器人触发，没有用户等着看站内」）。
 */
function terminalHarness(session: Session): {
  service: TaskTerminalService;
  statusEvents: Array<Record<string, unknown>>;
  inboxRecords: Array<Record<string, unknown>>;
} {
  const statusEvents: Array<Record<string, unknown>> = [];
  const inboxRecords: Array<Record<string, unknown>> = [];
  const sessionService = {
    getSession: async () => session,
    updateRuntimeStatus: async () => {},
    updatePhase: async () => {},
    markLastMessageFinished: async () => {},
  };
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
    { recordTaskTerminal: async (input: Record<string, unknown>) => { inboxRecords.push(input); } } as never,
  );
  return { service, statusEvents, inboxRecords };
}

describe('TaskTerminalService 钉钉渠道终态', () => {
  it('钉钉私聊会话的 session_status 不置 unread', async () => {
    const { service, statusEvents } = terminalHarness(runningSession({
      projectKey: 'dingtalk-2-private-42',
      workspace: '/data/workspace/dingtalk-chat/2/p2p-42',
    }));
    await service.finishExecution(1, 7, 'COMPLETED', 'exec-1');
    expect(statusEvents[0]?.unread).toBe(false);
  });

  it('钉钉群聊会话不写站内收件箱', async () => {
    const { service, inboxRecords } = terminalHarness(runningSession({
      projectKey: 'dingtalk-chat-2-cid-abc',
      workspace: '/data/workspace/dingtalk-chat/2/cid-abc',
    }));
    await service.finishExecution(1, 7, 'COMPLETED', 'exec-1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(inboxRecords).toHaveLength(0);
  });

  it('对照：飞书会话既不置 unread 也不写收件箱', async () => {
    const { service, statusEvents, inboxRecords } = terminalHarness(runningSession({
      projectKey: 'feishu-chat-2-cid-abc',
      workspace: '/data/workspace/feishu-chat/2/cid-abc',
    }));
    await service.finishExecution(1, 7, 'COMPLETED', 'exec-1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(statusEvents[0]?.unread).toBe(false);
    expect(inboxRecords).toHaveLength(0);
  });
});
