import { describe, expect, it, vi } from 'vitest';
import { ApprovalRegistry } from './approval-registry.js';
import type { SessionMapper, SessionService, StreamingWsRegistry } from '../deps.js';

describe('ApprovalRegistry', () => {
  function session(id: number) {
    return { id, userId: 7 };
  }

  function registry(sessionService: SessionService, sessionMapper: SessionMapper, ws: StreamingWsRegistry) {
    return new ApprovalRegistry(sessionService, sessionMapper, ws);
  }

  it('firstRegistrationEntersWaitingApprovalAndPublishes', async () => {
    const sessionMapper = { selectById: vi.fn().mockResolvedValue(session(10)) } as unknown as SessionMapper;
    const sessionService = {
      enterWaitingApproval: vi.fn().mockResolvedValue(true),
      restoreRunningAfterApproval: vi.fn(),
    } as unknown as SessionService;
    const ws = { send: vi.fn() } as unknown as StreamingWsRegistry;
    await registry(sessionService, sessionMapper, ws).register(10, 'r1');
    expect(sessionService.enterWaitingApproval).toHaveBeenCalledWith(10);
    expect(ws.send).toHaveBeenCalledTimes(2);
  });

  it('registrationDoesNotOverwriteTerminalPhase', async () => {
    const sessionMapper = { selectById: vi.fn() } as unknown as SessionMapper;
    const sessionService = {
      enterWaitingApproval: vi.fn().mockResolvedValue(false),
      restoreRunningAfterApproval: vi.fn(),
    } as unknown as SessionService;
    const ws = { send: vi.fn() } as unknown as StreamingWsRegistry;
    await registry(sessionService, sessionMapper, ws).register(10, 'r1');
    expect(sessionService.enterWaitingApproval).toHaveBeenCalledWith(10);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('parallelApprovalsStayWaitingUntilAllResolved', async () => {
    const sessionMapper = { selectById: vi.fn().mockResolvedValue(session(10)) } as unknown as SessionMapper;
    const sessionService = {
      enterWaitingApproval: vi.fn().mockResolvedValue(true),
      restoreRunningAfterApproval: vi.fn().mockResolvedValue(true),
    } as unknown as SessionService;
    const ws = { send: vi.fn() } as unknown as StreamingWsRegistry;
    const reg = registry(sessionService, sessionMapper, ws);
    await reg.register(10, 'r1');
    await reg.register(10, 'r2');
    expect(sessionService.enterWaitingApproval).toHaveBeenCalledTimes(1);
    expect(reg.countForSession(10)).toBe(2);
    await reg.unregister(10, 'r1');
    expect(sessionService.restoreRunningAfterApproval).not.toHaveBeenCalled();
    expect(reg.countForSession(10)).toBe(1);
    await reg.unregister(10, 'r2');
    expect(sessionService.restoreRunningAfterApproval).toHaveBeenCalledWith(10);
    expect(reg.countForSession(10)).toBe(0);
  });

  it('singleApprovalRestoresImmediatelyOnUnregister', async () => {
    const sessionMapper = { selectById: vi.fn().mockResolvedValue(session(10)) } as unknown as SessionMapper;
    const sessionService = {
      enterWaitingApproval: vi.fn().mockResolvedValue(true),
      restoreRunningAfterApproval: vi.fn().mockResolvedValue(true),
    } as unknown as SessionService;
    const ws = { send: vi.fn() } as unknown as StreamingWsRegistry;
    const reg = registry(sessionService, sessionMapper, ws);
    await reg.register(10, 'r1');
    await reg.unregister(10, 'r1');
    expect(sessionService.restoreRunningAfterApproval).toHaveBeenCalledWith(10);
  });

  it('unregisterUnknownRequestIsNoOp', async () => {
    const sessionService = {
      enterWaitingApproval: vi.fn(),
      restoreRunningAfterApproval: vi.fn(),
      updatePhase: vi.fn(),
    } as unknown as SessionService;
    const sessionMapper = { selectById: vi.fn() } as unknown as SessionMapper;
    const ws = { send: vi.fn() } as unknown as StreamingWsRegistry;
    await registry(sessionService, sessionMapper, ws).unregister(10, 'missing');
    expect(sessionService.restoreRunningAfterApproval).not.toHaveBeenCalled();
    expect(sessionService.updatePhase).not.toHaveBeenCalled();
    expect(sessionService.enterWaitingApproval).not.toHaveBeenCalled();
  });

  it('countForSessionIdsReturnsOnlyPositiveCounts', async () => {
    const sessionService = { enterWaitingApproval: vi.fn().mockResolvedValue(true) } as unknown as SessionService;
    const sessionMapper = { selectById: vi.fn().mockResolvedValue(session(10)) } as unknown as SessionMapper;
    const ws = { send: vi.fn() } as unknown as StreamingWsRegistry;
    const reg = registry(sessionService, sessionMapper, ws);
    await reg.register(10, 'r1');
    await reg.register(10, 'r2');
    await reg.register(11, 'r3');
    const counts = reg.countForSessionIds([10, 11, 12]);
    expect(counts.get(10)).toBe(2);
    expect(counts.get(11)).toBe(1);
    expect(counts.has(12)).toBe(false);
  });

  it('nullInputsAreIgnored', async () => {
    const sessionService = {
      enterWaitingApproval: vi.fn(),
      restoreRunningAfterApproval: vi.fn(),
      updatePhase: vi.fn(),
    } as unknown as SessionService;
    const sessionMapper = { selectById: vi.fn() } as unknown as SessionMapper;
    const ws = { send: vi.fn() } as unknown as StreamingWsRegistry;
    const reg = registry(sessionService, sessionMapper, ws);
    await reg.register(null, 'r1');
    await reg.register(10, null);
    await reg.unregister(null, 'r1');
    await reg.unregister(10, null);
    expect(reg.countForSession(null)).toBe(0);
    expect(reg.countForSessionIds(null).size).toBe(0);
    expect(sessionService.updatePhase).not.toHaveBeenCalled();
    expect(sessionService.enterWaitingApproval).not.toHaveBeenCalled();
    expect(sessionService.restoreRunningAfterApproval).not.toHaveBeenCalled();
  });

  it('hintRoundTripsThroughTakeHintExactlyOnce', async () => {
    const sessionService = {
      enterWaitingApproval: vi.fn().mockResolvedValue(true),
      restoreRunningAfterApproval: vi.fn().mockResolvedValue(true),
    } as unknown as SessionService;
    const sessionMapper = { selectById: vi.fn().mockResolvedValue(session(10)) } as unknown as SessionMapper;
    const ws = { send: vi.fn() } as unknown as StreamingWsRegistry;
    const reg = registry(sessionService, sessionMapper, ws);
    const hint = { ruleType: 'SHELL_PREFIX' as const, ruleValue: 'npm run', label: '本会话总是允许以 npm run 开头的命令' };
    await reg.register(10, 'r1', hint);
    expect(reg.takeHint(10, 'r1')).toEqual(hint);
    // 恰好一次消费：取走即删，重发帧拿不到
    expect(reg.takeHint(10, 'r1')).toBeNull();
  });

  it('hintIsClearedOnUnregisterAndIsolatedPerRequest', async () => {
    const sessionService = {
      enterWaitingApproval: vi.fn().mockResolvedValue(true),
      restoreRunningAfterApproval: vi.fn().mockResolvedValue(true),
    } as unknown as SessionService;
    const sessionMapper = { selectById: vi.fn().mockResolvedValue(session(10)) } as unknown as SessionMapper;
    const ws = { send: vi.fn() } as unknown as StreamingWsRegistry;
    const reg = registry(sessionService, sessionMapper, ws);
    await reg.register(10, 'r1', { ruleType: 'MCP_TOOL', ruleValue: 'mcp__a__b', label: 'x' });
    await reg.register(10, 'r2', { ruleType: 'SHELL_PREFIX', ruleValue: 'git push', label: 'y' });
    // 同会话多张 pending 卡各自 hint 互不串
    expect(reg.takeHint(10, 'r2')?.ruleValue).toBe('git push');
    await reg.unregister(10, 'r1');
    expect(reg.takeHint(10, 'r1')).toBeNull();
  });

  it('takeHintReturnsNullWithoutHint', async () => {
    const sessionService = {
      enterWaitingApproval: vi.fn(),
      restoreRunningAfterApproval: vi.fn(),
    } as unknown as SessionService;
    const sessionMapper = { selectById: vi.fn() } as unknown as SessionMapper;
    const ws = { send: vi.fn() } as unknown as StreamingWsRegistry;
    const reg = registry(sessionService, sessionMapper, ws);
    await reg.register(10, 'r1');
    expect(reg.takeHint(10, 'r1')).toBeNull();
    expect(reg.takeHint(10, 'missing')).toBeNull();
  });

  describe('多端审批（技术方案 2026-11-06）', () => {
    const context = {
      toolName: 'shell',
      arguments: '{"command":"npm run build"}',
      workspace: '/repo',
      dangerReason: '写入工作区',
    };

    function deps(overrides: { session?: Record<string, unknown> } = {}) {
      const sessionMapper = {
        selectById: vi.fn().mockResolvedValue({ id: 10, userId: 7, ...overrides.session }),
      } as unknown as SessionMapper;
      const sessionService = {
        enterWaitingApproval: vi.fn().mockResolvedValue(true),
        restoreRunningAfterApproval: vi.fn().mockResolvedValue(true),
      } as unknown as SessionService;
      const ws = { send: vi.fn() } as unknown as StreamingWsRegistry;
      return { sessionMapper, sessionService, ws, reg: new ApprovalRegistry(sessionService, sessionMapper, ws) };
    }

    function events(ws: StreamingWsRegistry, type: string) {
      return (ws.send as unknown as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => call[1] as { type: string; sessionId: number; data: Record<string, unknown> })
        .filter((event) => event.type === type);
    }

    it('registerBroadcastsApprovalRequestWithDeviceAndContext', async () => {
      const { ws, reg } = deps({ session: { targetDeviceId: 'dev-1', targetDeviceName: 'MacBook' } });
      await reg.register(10, 'r1', null, context);
      const requests = events(ws, 'tool_approval_request');
      expect(requests).toHaveLength(1);
      expect(requests[0].sessionId).toBe(10);
      expect(requests[0].data).toMatchObject({
        requestId: 'r1',
        toolName: 'shell',
        arguments: context.arguments,
        argumentsTruncated: false,
        workspace: '/repo',
        dangerReason: '写入工作区',
        deviceName: 'MacBook',
      });
    });

    it('truncatesArgumentsToBroadcastLimitAndReplaysTruncatedPayload', async () => {
      const { ws, reg } = deps();
      const long = JSON.stringify({ content: 'x'.repeat(9000) });
      await reg.register(10, 'r1', null, { ...context, arguments: long });
      const requests = events(ws, 'tool_approval_request');
      expect(requests[0].data.argumentsTruncated).toBe(true);
      expect(Buffer.byteLength(String(requests[0].data.arguments), 'utf8')).toBeLessThanOrEqual(8192);
      const pending = reg.getPendingForSession(10);
      expect(pending).toHaveLength(1);
      expect(pending[0].argumentsTruncated).toBe(true);
      expect(pending[0].arguments).toBe(requests[0].data.arguments);
    });

    it('doesNotBroadcastWhenSessionHasNoOwner', async () => {
      const { ws, reg } = deps({ session: { userId: null } });
      await reg.register(10, 'r1', null, context);
      expect(events(ws, 'tool_approval_request')).toHaveLength(0);
      expect(reg.countForSession(10)).toBe(1);
    });

    it('broadcastsResolvedAfterClaimWithDecision', async () => {
      const { ws, reg } = deps();
      await reg.register(10, 'r1', null, context);
      await reg.unregister(10, 'r1', { approved: true, alwaysAllow: true });
      const resolved = events(ws, 'tool_approval_resolved');
      expect(resolved).toHaveLength(1);
      expect(resolved[0].data).toEqual({ requestId: 'r1', approved: true, alwaysAllow: true });
    });

    it('claimsExactlyOnceAndReturnsHintOnlyToWinner', async () => {
      const { ws, reg } = deps();
      const hint = { ruleType: 'SHELL_PREFIX' as const, ruleValue: 'npm run', label: 'x' };
      await reg.register(10, 'r1', hint, context);
      const first = await reg.unregister(10, 'r1', { approved: false, alwaysAllow: false });
      const second = await reg.unregister(10, 'r1', { approved: true, alwaysAllow: true });
      expect(first.removed).toBe(true);
      expect(first.hint).toEqual(hint);
      expect(second.removed).toBe(false);
      expect(second.hint).toBeNull();
      expect(events(ws, 'tool_approval_resolved')).toHaveLength(1);
    });

    it('keepsRecentResolutionForRetriedVotes', async () => {
      const { reg } = deps();
      await reg.register(10, 'r1', null, context);
      await reg.unregister(10, 'r1', { approved: false, alwaysAllow: false });
      expect(reg.getRecentResolution(10, 'r1')).toEqual({ approved: false, alwaysAllow: false });
      expect(reg.getRecentResolution(10, 'missing')).toBeNull();
    });

    it('fallsBackToParentOwnerForSubagentSession', async () => {
      const sessionMapper = {
        selectById: vi.fn(async (id: number) => (id === 10
          ? { id: 10, userId: null, sessionType: 'SUBAGENT', parentSessionId: 9 }
          : { id: 9, userId: 7 })),
      } as unknown as SessionMapper;
      const sessionService = { enterWaitingApproval: vi.fn().mockResolvedValue(true) } as unknown as SessionService;
      const ws = { send: vi.fn() } as unknown as StreamingWsRegistry;
      const reg = new ApprovalRegistry(sessionService, sessionMapper, ws);
      await reg.register(10, 'r1', null, context);
      expect(events(ws, 'tool_approval_request')).toHaveLength(1);
    });
  });
});
