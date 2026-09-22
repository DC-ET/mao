import { describe, expect, it, vi } from 'vitest';
import { SubagentRecoveryCoordinator } from './subagent-recovery-coordinator.js';

describe('SubagentRecoveryCoordinator', () => {
  it('delivers delegate results before filling missing tool placeholders', async () => {
    const order: string[] = [];
    const coordinator = new SubagentRecoveryCoordinator(
      {} as never,
      { recover: vi.fn() } as never,
      { deliver: vi.fn(async () => { order.push('deliver'); }), suppressForParent: vi.fn() } as never,
      { selectById: vi.fn(async () => ({ id: 1, phase: 'RUNNING' })) } as never,
      { cleanupIncompleteTailAfterId: vi.fn(async () => { order.push('cleanup'); }), updatePhase: vi.fn() } as never,
      { loadValidated: vi.fn(async () => null), boundaryOf: vi.fn(() => 0) } as never,
      { submit: (fn) => { void fn(); } },
    );
    await (coordinator as unknown as {
      recoverGroup: (parentId: number, executions: unknown[], recoverParent: () => Promise<void>) => Promise<void>;
    }).recoverGroup(1, [{ id: 9, parentSessionId: 1, childSessionId: 2, status: 'COMPLETED' }], async () => undefined);
    expect(order).toEqual(['deliver', 'cleanup']);
  });

  it('cancels still-running child sessions when the parent is already terminal', async () => {
    const updatePhase = vi.fn(async () => undefined);
    const suppressForParent = vi.fn(async () => undefined);
    const recover = vi.fn();
    const coordinator = new SubagentRecoveryCoordinator(
      {} as never,
      { recover } as never,
      { deliver: vi.fn(), suppressForParent } as never,
      {
        selectById: vi.fn(async (id: number) => ({
          id, phase: id === 1 ? 'CANCELLED' : 'RUNNING',
        })),
      } as never,
      { updatePhase, cleanupIncompleteTailAfterId: vi.fn() } as never,
      { loadValidated: vi.fn(), boundaryOf: vi.fn(() => 0) } as never,
      { submit: (fn) => { void fn(); } },
    );
    await (coordinator as unknown as {
      recoverGroup: (parentId: number, executions: unknown[], recoverParent: () => Promise<void>) => Promise<void>;
    }).recoverGroup(1, [{ id: 9, parentSessionId: 1, childSessionId: 2, status: 'RUNNING' }], async () => undefined);
    expect(recover).not.toHaveBeenCalled();
    expect(suppressForParent).toHaveBeenCalledWith(1);
    expect(updatePhase).toHaveBeenCalledWith(2, 'CANCELLED');
  });
});
