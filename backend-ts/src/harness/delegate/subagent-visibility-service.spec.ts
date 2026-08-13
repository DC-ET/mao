import { describe, expect, it, vi } from 'vitest';
import { SubAgentVisibilityService, type SubAgentVisibilityDeps } from './subagent-visibility-service.js';
import { AgentExecutionContext } from '../core/agent-execution-context.js';
import { AtomicBoolean } from '../atomic-boolean.js';

function deps(overrides: Partial<SubAgentVisibilityDeps> = {}): SubAgentVisibilityDeps {
  return {
    registry: { subscribe: vi.fn(), send: vi.fn() } as never,
    activityService: { record: vi.fn() } as never,
    activityHeartbeat: { touch: vi.fn() },
    sessionTodoMapper: { selectBySessionId: vi.fn() },
    sessionService: { updatePhase: vi.fn(), updateContextTokens: vi.fn() } as never,
    taskTerminalService: { finishExecution: vi.fn() },
    llmModelLookup: { findById: vi.fn().mockResolvedValue(null) },
    harnessService: { executePrepared: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

describe('SubAgentVisibilityService', () => {
  it('notifies frontend with subagent_session_created and auto-subscribes', () => {
    const d = deps();
    const service = new SubAgentVisibilityService(d);
    service.notifySubagentCreated(
      { id: 10, userId: 7 },
      { id: 42, title: '子代理(coder): hello' },
      'coder',
      'create world.txt',
      'tc-9',
    );
    expect(d.registry.subscribe).toHaveBeenCalledWith(7, 42);
    expect(d.registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'subagent_session_created',
      sessionId: 10,
      data: expect.objectContaining({
        childSessionId: 42,
        title: '子代理(coder): hello',
        agentType: 'coder',
        task: 'create world.txt',
        toolCallId: 'tc-9',
      }),
    }));
  });

  it('streams child execution through a composite WS listener', async () => {
    const d = deps();
    const service = new SubAgentVisibilityService(d);
    await service.executeVisibleWithTimeout(
      { id: 42, userId: 7, modelId: 3 },
      new AgentExecutionContext(),
      false,
      new AtomicBoolean(),
      5,
      1,
    );
    expect(d.sessionService.updatePhase).toHaveBeenCalledWith(42, 'RUNNING');
    expect(d.registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'session_status',
      sessionId: 42,
    }));
    expect(d.harnessService.executePrepared).toHaveBeenCalled();
    const listener = vi.mocked(d.harnessService.executePrepared).mock.calls[0][1];
    expect(typeof listener.onContentDelta).toBe('function');
  });

  it('sets cancel flag on timeout then waits for grace before failing', async () => {
    const cancel = new AtomicBoolean();
    let cancelledDuringRun = false;
    const d = deps({
      harnessService: {
        executePrepared: vi.fn(async () => {
          await new Promise((r) => setTimeout(r, 30));
          cancelledDuringRun = cancel.get();
          await new Promise((r) => setTimeout(r, 200));
        }),
      },
    });
    const service = new SubAgentVisibilityService(d);
    await expect(
      service.executeVisibleWithTimeout(
        { id: 9, userId: 1 },
        new AgentExecutionContext(),
        false,
        cancel,
        0.02,
        0.02,
      ),
    ).rejects.toThrow(/已请求取消但未在宽限期/);
    expect(cancel.get()).toBe(true);
    expect(cancelledDuringRun).toBe(true);
  });

  it('returns if the child finishes during the cancel grace period', async () => {
    const cancel = new AtomicBoolean();
    const d = deps({
      harnessService: {
        executePrepared: vi.fn(async () => {
          await new Promise((r) => setTimeout(r, 40));
        }),
      },
    });
    const service = new SubAgentVisibilityService(d);
    const result = await service.executeVisibleWithTimeout(
      { id: 9, userId: 1 },
      new AgentExecutionContext(),
      false,
      cancel,
      0.02,
      0.2,
    );
    expect(cancel.get()).toBe(true);
    expect(result.collector.error).toBeUndefined();
  });
});
