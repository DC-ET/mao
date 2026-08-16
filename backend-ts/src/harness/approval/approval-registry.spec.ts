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
});
