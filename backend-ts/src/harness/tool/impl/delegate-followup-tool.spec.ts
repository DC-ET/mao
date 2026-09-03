import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DelegateFollowupTool, DelegateTool } from './delegate-tool.js';
import { AgentExecutionContext } from '../../core/agent-execution-context.js';
import { AgentDefinitionRegistry } from '../../delegate/agent-definition-registry.js';
import type { HarnessService } from '../../core/harness-service.js';
import type { AgentLoop } from '../../core/agent-loop.js';
import type { MessageMapper, SessionCompactionService, SessionMapper, SessionService } from '../../deps.js';
import type { SubagentExecutionMapper } from '../../delegate/subagent-execution.mapper.js';
import type { LocalToolSessionRegistry } from '../../local/local-tool-session-registry.js';
import type { SubAgentVisibilityService } from '../../delegate/subagent-visibility-service.js';
import { SubAgentResultCollector } from '../../delegate/subagent-result-collector.js';
import { AtomicBoolean } from '../../atomic-boolean.js';
import type { Tool } from '../tool.js';
import { lazyRef } from '../../../common/lazy-ref.js';

describe('DelegateFollowupTool', () => {
  const definitionRegistry = { getDefinition: vi.fn() } as unknown as AgentDefinitionRegistry & { getDefinition: ReturnType<typeof vi.fn> };
  const harnessService = { buildContext: vi.fn(), executePrepared: vi.fn() } as unknown as HarnessService;
  const agentLoop = {
    getCancelFlag: vi.fn(),
    registerCancelFlag: vi.fn(),
    removeCancelFlag: vi.fn(),
  } as unknown as AgentLoop & Record<string, ReturnType<typeof vi.fn>>;
  const sessionService = {
    saveMessage: vi.fn(),
    getMessagesAfterId: vi.fn(),
    cleanupIncompleteTailAfterId: vi.fn(),
  } as unknown as SessionService & Record<string, ReturnType<typeof vi.fn>>;
  const sessionMapper = {
    selectById: vi.fn(),
    claimRunningIfIdle: vi.fn(),
    updatePhase: vi.fn(),
  } as unknown as SessionMapper & Record<string, ReturnType<typeof vi.fn>>;
  const messageMapper = {
    selectLast: vi.fn(),
    deleteById: vi.fn(),
    deleteFromId: vi.fn(),
  } as unknown as MessageMapper & Record<string, ReturnType<typeof vi.fn>>;
  const sessionCompactionService = {
    loadValidated: vi.fn(),
    boundaryOf: vi.fn().mockReturnValue(0),
  } as unknown as SessionCompactionService & Record<string, ReturnType<typeof vi.fn>>;
  const subagentExecutionMapper = {
    findByChildSessionId: vi.fn(),
    insert: vi.fn(),
    updateById: vi.fn(),
    countByChildSessionId: vi.fn(),
    countCompletedByChildSessionId: vi.fn(),
  } as unknown as SubagentExecutionMapper & Record<string, ReturnType<typeof vi.fn>>;
  const localToolSessionRegistry = {
    setUserForSession: vi.fn(),
    removeSession: vi.fn(),
  } as unknown as LocalToolSessionRegistry;
  const visibilityService = {
    ensureSubscribed: vi.fn(),
    executeVisible: vi.fn(),
    finishSubagent: vi.fn(),
  } as unknown as SubAgentVisibilityService & Record<string, ReturnType<typeof vi.fn>>;
  const delegateTool = { buildSubContext: vi.fn() } as unknown as DelegateTool & { buildSubContext: ReturnType<typeof vi.fn> };

  const tool = new DelegateFollowupTool(
    definitionRegistry, harnessService, agentLoop, sessionService, sessionMapper,
    messageMapper, sessionCompactionService, subagentExecutionMapper, localToolSessionRegistry,
    visibilityService, delegateTool,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    sessionCompactionService.boundaryOf.mockReturnValue(0);
  });

  function parentSession(id: number) {
    return { id, userId: 7, agentId: 3, executionMode: 'CLOUD' };
  }
  function childSession(id: number, parentId: number, sessionType: string, phase: string | null) {
    return { id, userId: 7, agentId: 3, parentSessionId: parentId, sessionType, phase };
  }

  it('missingParamsReturnsError', async () => {
    expect(JSON.parse(await tool.execute('{"task":"x"}', 1, null)).error).toContain('缺少必填参数');
    expect(JSON.parse(await tool.execute('{"child_session_id":100}', 1, null)).error).toContain('缺少必填参数');
  });

  it('nonIntegerChildSessionIdRejected', async () => {
    expect(JSON.parse(await tool.execute('{"child_session_id":"abc","task":"跟进审查"}', 1, null)).error).toContain('必须是整数');
    expect(JSON.parse(await tool.execute('{"child_session_id":100.5,"task":"跟进审查"}', 1, null)).error).toContain('必须是整数');
  });

  it('parentSessionMissingReturnsError', async () => {
    sessionMapper.selectById.mockResolvedValue(null);
    expect(JSON.parse(await tool.execute('{"child_session_id":100,"task":"跟进审查"}', 1, null)).error).toContain('父会话不存在');
  });

  it('childSessionNotFoundRejected', async () => {
    sessionMapper.selectById.mockImplementation(async (id: number) => id === 1 ? parentSession(1) : null);
    const result = JSON.parse(await tool.execute('{"child_session_id":100,"task":"跟进审查"}', 1, null));
    expect(result.error).toContain('子代理会话不存在');
    expect(subagentExecutionMapper.insert).not.toHaveBeenCalled();
  });

  it('nonSubagentSessionRejected', async () => {
    sessionMapper.selectById.mockImplementation(async (id: number) =>
      id === 1 ? parentSession(1) : childSession(100, 1, 'NORMAL', 'COMPLETED'));
    const result = JSON.parse(await tool.execute('{"child_session_id":100,"task":"跟进审查"}', 1, null));
    expect(result.error).toContain('不是子代理会话');
  });

  it('childOfOtherParentRejected', async () => {
    sessionMapper.selectById.mockImplementation(async (id: number) =>
      id === 1 ? parentSession(1) : childSession(100, 999, 'SUBAGENT', 'COMPLETED'));
    const result = JSON.parse(await tool.execute('{"child_session_id":100,"task":"跟进审查"}', 1, null));
    expect(result.error).toContain('不属于当前会话');
  });

  it('runningSessionRejected', async () => {
    sessionMapper.selectById.mockImplementation(async (id: number) =>
      id === 1 ? parentSession(1) : childSession(100, 1, 'SUBAGENT', 'RUNNING'));
    const result = JSON.parse(await tool.execute('{"child_session_id":100,"task":"跟进审查"}', 1, null));
    expect(result.error).toContain('正在执行中');
  });

  it('concurrentClaimLostRejected', async () => {
    sessionMapper.selectById.mockImplementation(async (id: number) =>
      id === 1 ? parentSession(1) : childSession(100, 1, 'SUBAGENT', 'COMPLETED'));
    subagentExecutionMapper.findByChildSessionId.mockResolvedValue({ agentType: 'reviewer' });
    definitionRegistry.getDefinition.mockReturnValue({ name: 'reviewer' });
    sessionMapper.claimRunningIfIdle.mockResolvedValue(0);
    const result = JSON.parse(await tool.execute('{"child_session_id":100,"task":"跟进审查"}', 1, null));
    expect(result.error).toContain('正在执行中');
    expect(sessionService.saveMessage).not.toHaveBeenCalled();
    expect(subagentExecutionMapper.insert).not.toHaveBeenCalled();
  });

  it('noExecutionRecordRejected', async () => {
    sessionMapper.selectById.mockImplementation(async (id: number) =>
      id === 1 ? parentSession(1) : childSession(100, 1, 'SUBAGENT', 'COMPLETED'));
    subagentExecutionMapper.findByChildSessionId.mockResolvedValue(null);
    const result = JSON.parse(await tool.execute('{"child_session_id":100,"task":"跟进审查"}', 1, null));
    expect(result.error).toContain('无执行记录');
  });

  it('unknownAgentTypeRejected', async () => {
    sessionMapper.selectById.mockImplementation(async (id: number) =>
      id === 1 ? parentSession(1) : childSession(100, 1, 'SUBAGENT', 'COMPLETED'));
    subagentExecutionMapper.findByChildSessionId.mockResolvedValue({ agentType: 'ghost' });
    definitionRegistry.getDefinition.mockReturnValue(undefined);
    const result = JSON.parse(await tool.execute('{"child_session_id":100,"task":"跟进审查"}', 1, null));
    expect(result.error).toContain('未知的子代理类型');
  });

  it('followupSuccessReusesSubagentSession', async () => {
    sessionMapper.selectById.mockImplementation(async (id: number) =>
      id === 1 ? parentSession(1) : childSession(100, 1, 'SUBAGENT', 'COMPLETED'));
    subagentExecutionMapper.findByChildSessionId.mockResolvedValue({ agentType: 'reviewer' });
    definitionRegistry.getDefinition.mockReturnValue({ name: 'reviewer', description: 'code review' });
    sessionMapper.claimRunningIfIdle.mockResolvedValue(1);
    sessionCompactionService.loadValidated.mockResolvedValue(null);
    agentLoop.getCancelFlag.mockReturnValue(null);
    agentLoop.registerCancelFlag.mockReturnValue(new AtomicBoolean(false));
    const subCtx = new AgentExecutionContext();
    subCtx.currentRound = 2;
    delegateTool.buildSubContext.mockResolvedValue(subCtx);
    const collector = new SubAgentResultCollector();
    collector.onThinkingStart();
    collector.onContentDelta('第二轮审查结论：修复到位，无新问题');
    collector.onMessageEnd({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
    visibilityService.executeVisible.mockResolvedValue({ collector, executionId: 'exec-1' });
    subagentExecutionMapper.countByChildSessionId.mockResolvedValue(2);
    subagentExecutionMapper.countCompletedByChildSessionId.mockResolvedValue(1);
    sessionService.saveMessage.mockResolvedValue({ id: 9 });
    sessionService.getMessagesAfterId.mockResolvedValue([
      { id: 10, role: 'ASSISTANT', content: '第二轮审查结论：修复到位，无新问题', toolCalls: null },
    ]);
    messageMapper.selectLast.mockResolvedValue(null);

    const result = JSON.parse(await tool.execute(
      '{"child_session_id":100,"task":"已修复上一轮问题，请核查并继续审查"}', 1, null,
    ));
    expect(result.success).toBe(true);
    expect(result.follow_up).toBe(true);
    expect(result.child_session_id).toBe(100);
    expect(result.round).toBe(2);
    expect(result.completed_rounds).toBe(1);
    expect(result.agent_type).toBe('reviewer');
    expect(result.result).toContain('修复到位');
    expect(sessionService.saveMessage).toHaveBeenCalledWith(100, 'USER', '已修复上一轮问题，请核查并继续审查', null, null, null, 0, null);
    expect(sessionService.cleanupIncompleteTailAfterId).toHaveBeenCalledWith(100, 0);
    expect(subagentExecutionMapper.insert).toHaveBeenCalled();
    expect(visibilityService.finishSubagent).toHaveBeenCalledWith(100, 7, 'COMPLETED', 'exec-1');
    expect(visibilityService.ensureSubscribed).toHaveBeenCalledWith(7, 100);
  });

  it('buildSubContextPreservesWriteFileAndExcludesEditFileForReviewer', async () => {
    const fakeDelegate = { getName: () => 'delegate' } as Tool;
    const fakeFollowup = { getName: () => 'delegate_followup' } as Tool;
    const fakeRead = { getName: () => 'read_file' } as Tool;
    const fakeWrite = { getName: () => 'write_file' } as Tool;
    const fakeEdit = { getName: () => 'edit_file' } as Tool;
    const ctx = new AgentExecutionContext();
    ctx.tools = [fakeDelegate, fakeFollowup, fakeRead, fakeWrite, fakeEdit];
    const hs = { buildContext: vi.fn().mockResolvedValue(ctx) } as unknown as HarnessService;
    const realDelegate = new DelegateTool(
      {} as AgentDefinitionRegistry, hs, {} as AgentLoop, {} as SessionService,
      {} as SessionMapper, {} as SubagentExecutionMapper, {} as LocalToolSessionRegistry,
      {} as SubAgentVisibilityService,
    );
    const definition = new AgentDefinitionRegistry().getDefinition('reviewer')!;
    const subCtx = await realDelegate.buildSubContext({ id: 100 }, definition);
    const names = subCtx.tools.map((t) => t.getName());
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('delegate');
    expect(names).not.toContain('delegate_followup');
  });

  it('researcherAllowsWriteFileAndExcludesEditFile', () => {
    const definition = new AgentDefinitionRegistry().getDefinition('researcher')!;
    expect(definition.excludedToolNames).not.toContain('write_file');
    expect(definition.excludedToolNames).toContain('edit_file');
  });
});

describe('DelegateTool', () => {
  it('creates child session and returns result', async () => {
    const definitionRegistry = {
      getAllDefinitions: () => [{ name: 'reviewer', description: 'review' }],
      getDefinition: vi.fn((name: string) => name === 'reviewer' ? { name: 'reviewer', description: 'review' } : undefined),
    };
    const subCtx = new AgentExecutionContext();
    subCtx.tools = [];
    subCtx.availableSkillDocs = new Map();
    const harnessService = { executePrepared: vi.fn(), buildContext: vi.fn(async () => subCtx) };
    const agentLoop = {
      getCancelFlag: vi.fn(() => null),
      registerCancelFlag: vi.fn(() => new AtomicBoolean(false)),
      removeCancelFlag: vi.fn(),
    };
    const sessionService = {
      createSession: vi.fn(async () => ({ id: 200, userId: 7 })),
      saveMessage: vi.fn(async () => ({ id: 300 })),
    };
    const sessionMapper = {
      selectById: vi.fn(async () => ({ id: 1, userId: 7, agentId: 3, executionMode: 'CLOUD', workspace: '/w' })),
      updateById: vi.fn(),
    };
    const subagentExecutionMapper = { insert: vi.fn(async (e: { id?: number }) => { e.id = 8; }), updateById: vi.fn() };
    const localToolSessionRegistry = { setUserForSession: vi.fn(), removeSession: vi.fn() };
    const collector = new SubAgentResultCollector();
    collector.onContentDelta('done');
    collector.onMessageEnd({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    const visibilityService = {
      notifySubagentCreated: vi.fn(),
      executeVisible: vi.fn(async () => ({ collector, executionId: 'e1' })),
      finishSubagent: vi.fn(),
    };
    const tool = new DelegateTool(
      definitionRegistry as never, harnessService as never, agentLoop as never, sessionService as never,
      sessionMapper as never, subagentExecutionMapper as never, localToolSessionRegistry as never,
      visibilityService as never,
    );
    expect(tool.getName()).toBe('delegate');
    expect(tool.getInputSchema().required).toContain('agent_type');
    expect(JSON.parse(await tool.execute('{}', 1, null)).error).toContain('缺少');
    expect(JSON.parse(await tool.execute(JSON.stringify({ agent_type: 'ghost', task: 'x' }), 1, null)).error).toContain('未知');
    sessionMapper.selectById.mockResolvedValueOnce(null);
    definitionRegistry.getDefinition.mockReturnValueOnce({ name: 'reviewer' });
    expect(JSON.parse(await tool.execute(JSON.stringify({ agent_type: 'reviewer', task: 'review this' }), 1, null)).error).toContain('父会话');
    sessionMapper.selectById.mockResolvedValue({ id: 1, userId: 7, agentId: 3, executionMode: 'CLOUD', workspace: '/w' });
    const result = JSON.parse(await tool.execute(JSON.stringify({ agent_type: 'reviewer', task: 'review this file carefully' }), 1, null));
    expect(result.success).toBe(true);
    expect(result.child_session_id).toBe(200);
    expect(visibilityService.finishSubagent).toHaveBeenCalled();
  });

  it('buildSubContextResolvesHarnessServiceAfterLateInit', async () => {
    const holder: { harness?: { buildContext: ReturnType<typeof vi.fn> } } = {};
    const ctx = new AgentExecutionContext();
    ctx.tools = [];
    ctx.availableSkillDocs = new Map();
    const tool = new DelegateTool(
      {} as AgentDefinitionRegistry,
      lazyRef(() => holder.harness as never),
      {} as AgentLoop,
      {} as SessionService,
      {} as SessionMapper,
      {} as SubagentExecutionMapper,
      {} as LocalToolSessionRegistry,
      {} as SubAgentVisibilityService,
    );
    holder.harness = { buildContext: vi.fn().mockResolvedValue(ctx) };
    const subCtx = await tool.buildSubContext({ id: 42 }, { name: 'coder' });
    expect(holder.harness.buildContext).toHaveBeenCalledWith(42);
    expect(subCtx.agentName).toBe('coder-agent');
  });
});

