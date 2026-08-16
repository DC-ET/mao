import { describe, expect, it, vi } from 'vitest';
import { SubAgentVisibilityService, type SubAgentVisibilityDeps } from './subagent-visibility-service.js';
import { AgentExecutionContext } from '../core/agent-execution-context.js';

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
    await service.executeVisible(
      { id: 42, userId: 7, modelId: 3 },
      new AgentExecutionContext(),
      false,
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

  it('waits for a long-running child without cancelling it', async () => {
    const d = deps({
      harnessService: {
        executePrepared: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
        }),
      },
    });
    const service = new SubAgentVisibilityService(d);
    const result = await service.executeVisible(
      { id: 9, userId: 1 },
      new AgentExecutionContext(),
      false,
    );
    expect(result.collector.error).toBeUndefined();
    expect(d.harnessService.executePrepared).toHaveBeenCalledOnce();
  });
});
