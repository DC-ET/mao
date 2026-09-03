import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AskUserQuestionsRegistry } from './ask-user-questions-registry.js';
import { DangerAssessor } from './danger-assessor.js';
import { ToolDispatcher, IllegalArgumentException } from './tool-dispatcher.js';
import { ToolRegistry } from './tool-registry.js';
import type { Tool } from './tool.js';
import type { LocalToolExecutor } from '../local/local-tool-executor.js';
import type { LocalToolSessionRegistry } from '../local/local-tool-session-registry.js';
import type { SessionMapper, StreamingWsRegistry } from '../deps.js';
import type { SessionTreeSignalPublisher } from '../approval/session-tree-signal-publisher.js';
import type { LlmAdapter } from '../llm/chat-request.js';
import { BackgroundTaskManager } from '../core/background-task-manager.js';

function mockTool(name: string): Tool & { execute: ReturnType<typeof vi.fn> } {
  return {
    getName: () => name,
    getDescription: () => name,
    getInputSchema: () => ({}),
    getOutputSchema: () => ({}),
    execute: vi.fn(),
  };
}

describe('ToolDispatcher', () => {
  const serverTool = mockTool('task_create');
  const cloudTool = mockTool('read_file');
  const mcpTool = mockTool('mcp__filesystem__write_file');
  const registry = new ToolRegistry([serverTool, cloudTool, mcpTool]);
  const localToolExecutor = { execute: vi.fn() } as unknown as LocalToolExecutor & { execute: ReturnType<typeof vi.fn> };
  const dangerAssessor = new DangerAssessor({ chat: vi.fn(), stream: vi.fn() } as unknown as LlmAdapter);
  const assessSpy = vi.spyOn(dangerAssessor, 'assess');
  const sessionMapper = { selectById: vi.fn() } as unknown as SessionMapper & { selectById: ReturnType<typeof vi.fn> };
  const streamingWsRegistry = {
    hasConnection: vi.fn(),
    send: vi.fn(),
  } as unknown as StreamingWsRegistry & { hasConnection: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
  const askUserQuestionsRegistry = {
    register: vi.fn(),
    waitForAnswer: vi.fn(),
  } as unknown as AskUserQuestionsRegistry & { register: ReturnType<typeof vi.fn>; waitForAnswer: ReturnType<typeof vi.fn> };
  const localToolSessionRegistry = {
    getUserIdForSession: vi.fn(),
    isConnected: vi.fn(),
  } as unknown as LocalToolSessionRegistry & {
    getUserIdForSession: ReturnType<typeof vi.fn>;
    isConnected: ReturnType<typeof vi.fn>;
  };
  const treeSignalPublisher = { publishForSession: vi.fn() } as unknown as SessionTreeSignalPublisher;
  const dispatcher = new ToolDispatcher(
    registry, localToolExecutor, dangerAssessor, sessionMapper, streamingWsRegistry,
    askUserQuestionsRegistry, localToolSessionRegistry, treeSignalPublisher,
  );

  beforeEach(() => {
    localToolExecutor.execute.mockReset();
    sessionMapper.selectById.mockReset();
    streamingWsRegistry.hasConnection.mockReset();
    streamingWsRegistry.send.mockReset();
    askUserQuestionsRegistry.register.mockReset();
    askUserQuestionsRegistry.waitForAnswer.mockReset();
    localToolSessionRegistry.getUserIdForSession.mockReset();
    localToolSessionRegistry.isConnected.mockReset();
    localToolSessionRegistry.isConnected.mockResolvedValue(true);
    cloudTool.execute.mockReset();
    serverTool.execute.mockReset();
    mcpTool.execute.mockReset();
    assessSpy.mockClear();
  });

  it('dispatchesCloudModeToBuiltInToolWithWorkspace', async () => {
    cloudTool.execute.mockResolvedValue('cloud-result');
    expect(await dispatcher.dispatch('read_file', '{}', 'workspace')).toBe('cloud-result');
  });

  it('dispatchesServerOnlyToolsOnServerEvenInLocalMode', async () => {
    serverTool.execute.mockResolvedValue('server-result');
    const result = await dispatcher.dispatch('task_create', '{}', 'LOCAL', 7, 9, 'workspace', 'FULL', null);
    expect(result).toBe('server-result');
    expect(localToolExecutor.execute).not.toHaveBeenCalled();
  });

  it('localReadOnlyRequiresApprovalForWriteAndShellTools', async () => {
    localToolExecutor.execute.mockResolvedValueOnce('read').mockResolvedValueOnce('write');
    expect(await dispatcher.dispatch('read_file', '{}', 'LOCAL', 7, 'workspace', 'READ_ONLY', null)).toBe('read');
    expect(await dispatcher.dispatch('write_file', '{}', 'LOCAL', 7, 'workspace', 'READ_ONLY', null)).toBe('write');
  });

  it('localModeUsesLatestPermissionLevelFromSession', async () => {
    sessionMapper.selectById.mockResolvedValue({ permissionLevel: 'FULL' });
    localToolExecutor.execute.mockResolvedValue('ok');
    const result = await dispatcher.dispatch('shell', '{}', 'LOCAL', 7, 'workspace', 'READ_ONLY', null);
    expect(result).toBe('ok');
  });

  it('smartModeUsesDangerAssessorForShellCommands', async () => {
    assessSpy.mockResolvedValue({ dangerous: true, reason: '危险' });
    localToolExecutor.execute.mockResolvedValue('needs-approval');
    const result = await dispatcher.dispatch('shell', '{}', 'LOCAL', 7, 'workspace', 'SMART', { modelId: 'test' });
    expect(result).toBe('needs-approval');
    expect(localToolExecutor.execute).toHaveBeenLastCalledWith(7, 'shell', '{}', 'workspace', true, '危险');
  });

  it('smartModeRequiresApprovalWhenModelConfigMissing', async () => {
    localToolExecutor.execute.mockResolvedValue('needs-approval');
    const result = await dispatcher.dispatch('shell', '{}', 'LOCAL', 7, 'workspace', 'SMART', null);
    expect(result).toBe('needs-approval');
  });

  it('askUserQuestionsRoutesThroughConnectedClientAndCancelsOnError', async () => {
    localToolSessionRegistry.getUserIdForSession.mockResolvedValue(9);
    streamingWsRegistry.hasConnection.mockReturnValue(true);
    askUserQuestionsRegistry.register.mockReturnValue('req-1');
    askUserQuestionsRegistry.waitForAnswer.mockResolvedValue({ answered: false, resultJson: '{"error":"timeout"}' });
    const result = await dispatcher.dispatch(
      'ask_user_questions',
      '{"questions":[{"id":"q1"}],"metadata":{"source":"test"}}',
      'CLOUD', 7, 'workspace',
    );
    expect(result).toContain('timeout');
    expect(streamingWsRegistry.send).toHaveBeenCalledTimes(2);
    expect(askUserQuestionsRegistry.waitForAnswer).toHaveBeenCalledWith(7, 'req-1');
    expect(askUserQuestionsRegistry.register).toHaveBeenCalledWith(
      7,
      expect.arrayContaining([expect.objectContaining({ id: 'q1' })]),
      expect.objectContaining({ source: 'test' }),
    );
  });

  it('askUserQuestionsFallsBackToSessionLookupAndReportsMissingClient', async () => {
    localToolSessionRegistry.getUserIdForSession.mockResolvedValue(null);
    sessionMapper.selectById.mockResolvedValue({ userId: 9 });
    streamingWsRegistry.hasConnection.mockReturnValue(false);
    const result = await dispatcher.dispatch('ask_user_questions', '{}', 'CLOUD', 7, 'workspace');
    expect(result).toContain('No connected client');
  });

  it('unknownToolThrowsException', async () => {
    await expect(dispatcher.dispatch('missing', '{}')).rejects.toBeInstanceOf(IllegalArgumentException);
    await expect(dispatcher.dispatch('missing', '{}')).rejects.toThrow(/Unknown tool/);
  });

  it('localMcpToolRequiresApprovalForReadOnlyLevel', async () => {
    localToolExecutor.execute.mockResolvedValue('executed');
    const result = await dispatcher.dispatch('mcp__filesystem__write_file', '{}', 'LOCAL', 7, 'workspace', 'READ_ONLY', null);
    expect(result).toBe('executed');
    expect(localToolExecutor.execute).toHaveBeenCalledWith(7, 'mcp__filesystem__write_file', '{}', 'workspace', true, null);
  });

  it('localMcpToolRequiresApprovalForReadWriteLevel', async () => {
    localToolExecutor.execute.mockResolvedValue('executed');
    const result = await dispatcher.dispatch('mcp__filesystem__write_file', '{}', 'LOCAL', 7, 'workspace', 'READ_WRITE', null);
    expect(result).toBe('executed');
  });

  it('localMcpToolRequiresApprovalForSmartLevelWithoutDangerAssessor', async () => {
    localToolExecutor.execute.mockResolvedValue('executed');
    const result = await dispatcher.dispatch(
      'mcp__filesystem__write_file', '{}', 'LOCAL', 7, 'workspace', 'SMART', { modelId: 'test' },
    );
    expect(result).toBe('executed');
    expect(assessSpy).not.toHaveBeenCalled();
  });

  it('localMcpToolSkipsApprovalForFullLevel', async () => {
    localToolExecutor.execute.mockResolvedValue('executed');
    const result = await dispatcher.dispatch('mcp__filesystem__write_file', '{}', 'LOCAL', 7, 'workspace', 'FULL', null);
    expect(result).toBe('executed');
    expect(localToolExecutor.execute).toHaveBeenCalledWith(7, 'mcp__filesystem__write_file', '{}', 'workspace', false, null);
  });

  it('localShellAsyncStartsOnDesktopThenWaitsInBackground', async () => {
    const backgroundTasks = new BackgroundTaskManager();
    const asyncDispatcher = new ToolDispatcher(
      registry, localToolExecutor, dangerAssessor, sessionMapper, streamingWsRegistry,
      askUserQuestionsRegistry, localToolSessionRegistry, treeSignalPublisher, backgroundTasks,
    );
    localToolExecutor.execute
      .mockResolvedValueOnce(JSON.stringify({
        async: true,
        session_id: 'sh-started',
        output_file: '~/.mao/runtime/7/shellOutput/sh-started.out',
        message: '命令已提交到后台执行。',
      }))
      .mockResolvedValueOnce('{"exit_code":0,"output":"done","completed":true}');
    const raw = await asyncDispatcher.dispatch(
      'shell', '{"command":"sleep 1","async":true}', 'LOCAL', 7, 'workspace', 'FULL', null,
    );
    const result = JSON.parse(raw) as {
      async: boolean; task_id: string; session_id: string; output_file: string; message: string;
    };
    expect(result.async).toBe(true);
    expect(result.task_id).toMatch(/^bg-/);
    expect(result.session_id).toBe('sh-started');
    expect(result.output_file).toBe('~/.mao/runtime/7/shellOutput/sh-started.out');
    expect(result.message).toContain('后台执行');
    expect(localToolExecutor.execute).toHaveBeenNthCalledWith(
      1, 7, 'shell', '{"command":"sleep 1","async":true}', 'workspace', false, null,
    );
    await vi.waitFor(() => expect(localToolExecutor.execute).toHaveBeenCalledTimes(2));
    expect(localToolExecutor.execute).toHaveBeenNthCalledWith(
      2, 7, 'shell', JSON.stringify({ action: 'await_async', session_id: 'sh-started' }), 'workspace', false, null,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const consumed = await backgroundTasks.consumeCompletedResults(7);
    expect(JSON.parse(consumed[result.task_id])).toEqual({
      exit_code: 0,
      completed: true,
      output: 'done',
    });
  });

  it('localShellAsyncReturnsSyncErrorWhenDesktopIsDisconnected', async () => {
    const backgroundTasks = new BackgroundTaskManager();
    const asyncDispatcher = new ToolDispatcher(
      registry, localToolExecutor, dangerAssessor, sessionMapper, streamingWsRegistry,
      askUserQuestionsRegistry, localToolSessionRegistry, treeSignalPublisher, backgroundTasks,
    );
    localToolSessionRegistry.isConnected.mockResolvedValue(false);
    const raw = await asyncDispatcher.dispatch(
      'shell', '{"command":"sleep 1","async":true}', 'LOCAL', 7, 'workspace', 'FULL', null,
    );
    expect(JSON.parse(raw).error).toContain('Local client is not connected');
    expect(JSON.parse(raw).async).toBeUndefined();
    expect(localToolExecutor.execute).not.toHaveBeenCalled();
    expect(await backgroundTasks.consumeCompletedResults(7)).toEqual({});
  });

  it('localShellAsyncFallsBackToSyncResultWhenDesktopIgnoresAsync', async () => {
    const backgroundTasks = new BackgroundTaskManager();
    const asyncDispatcher = new ToolDispatcher(
      registry, localToolExecutor, dangerAssessor, sessionMapper, streamingWsRegistry,
      askUserQuestionsRegistry, localToolSessionRegistry, treeSignalPublisher, backgroundTasks,
    );
    localToolExecutor.execute.mockResolvedValue('{"exit_code":0,"output":"done"}');
    const raw = await asyncDispatcher.dispatch(
      'shell', '{"command":"echo hi","async":true}', 'LOCAL', 7, 'workspace', 'FULL', null,
    );
    expect(raw).toBe('{"exit_code":0,"output":"done"}');
    expect(localToolExecutor.execute).toHaveBeenCalledTimes(1);
    expect(await backgroundTasks.consumeCompletedResults(7)).toEqual({});
  });

  it('localShellAsyncKeepsProvidedSessionIdAndIgnoresNonExecActions', async () => {
    const backgroundTasks = new BackgroundTaskManager();
    const asyncDispatcher = new ToolDispatcher(
      registry, localToolExecutor, dangerAssessor, sessionMapper, streamingWsRegistry,
      askUserQuestionsRegistry, localToolSessionRegistry, treeSignalPublisher, backgroundTasks,
    );
    localToolExecutor.execute
      .mockResolvedValueOnce(JSON.stringify({
        async: true, session_id: 'sh-keep', output_file: 'out.out', message: '命令已提交到后台执行。',
      }))
      .mockResolvedValueOnce('{"exit_code":0}');
    const execRaw = await asyncDispatcher.dispatch(
      'shell', '{"command":"ls","async":true,"session_id":"sh-keep"}', 'LOCAL', 7, 'workspace', 'FULL', null,
    );
    expect(JSON.parse(execRaw).session_id).toBe('sh-keep');
    expect(localToolExecutor.execute.mock.calls[0][2]).toContain('"session_id":"sh-keep"');

    localToolExecutor.execute.mockClear();
    localToolExecutor.execute.mockResolvedValue('{"sessions":[]}');
    const listRaw = await asyncDispatcher.dispatch(
      'shell', '{"action":"list","async":true}', 'LOCAL', 7, 'workspace', 'FULL', null,
    );
    expect(JSON.parse(listRaw).async).toBeUndefined();
    expect(localToolExecutor.execute).toHaveBeenCalledWith(7, 'shell', '{"action":"list","async":true}', 'workspace', false, null);
  });

  it('localShellAsyncForwardsWaitSemanticsToTheDesktopAwait', async () => {
    const backgroundTasks = new BackgroundTaskManager();
    const asyncDispatcher = new ToolDispatcher(
      registry, localToolExecutor, dangerAssessor, sessionMapper, streamingWsRegistry,
      askUserQuestionsRegistry, localToolSessionRegistry, treeSignalPublisher, backgroundTasks,
    );
    localToolExecutor.execute
      .mockResolvedValueOnce(JSON.stringify({ async: true, session_id: 'sh-dev', output_file: 'out.out' }))
      .mockResolvedValueOnce('{"exit_code":-1,"completed":false,"output":"Listening on 3000"}');
    await asyncDispatcher.dispatch(
      'shell',
      '{"command":"npm run dev","async":true,"yield_time_ms":1500,"wait_for":"Listening on"}',
      'LOCAL', 7, 'workspace', 'FULL', null,
    );
    await vi.waitFor(() => expect(localToolExecutor.execute).toHaveBeenCalledTimes(2));
    // 不透传的话桌面端会用它自己的 await 默认值，wait_for 也会丢
    expect(localToolExecutor.execute).toHaveBeenNthCalledWith(
      2, 7, 'shell',
      JSON.stringify({ action: 'await_async', session_id: 'sh-dev', yield_time_ms: 1500, wait_for: 'Listening on' }),
      'workspace', false, null,
    );
  });

  it('cloudModeMcpToolExecutesViaSessionToolsWhenNotInGlobalRegistry', async () => {
    mcpTool.execute.mockResolvedValue('cloud-mcp-result');
    const result = await dispatcher.dispatch(
      'mcp__filesystem__write_file', '{}', 'CLOUD', 7, 9, 'workspace', 'READ_ONLY', null, [mcpTool],
    );
    expect(result).toBe('cloud-mcp-result');
    expect(localToolExecutor.execute).not.toHaveBeenCalled();
  });

  it('cloudModeUnknownToolStillThrowsWhenNotInSessionTools', async () => {
    await expect(dispatcher.dispatch(
      'mcp__unregistered__tool', '{}', 'CLOUD', 7, 9, 'workspace', 'READ_ONLY', null, [serverTool],
    )).rejects.toThrow(/Unknown tool/);
  });

  it('dispatchInvocationReturnsToolResultForCloudTool', async () => {
    cloudTool.execute.mockResolvedValue('cloud-result');
    const r = await dispatcher.dispatchInvocation({
      callId: 'call-1', toolName: 'read_file', argumentsJson: '{}',
      executionMode: 'CLOUD', sessionId: 7, userId: 9, executionUserId: null,
      workspace: 'ws', permissionLevel: 'FULL', modelConfig: null, sessionTools: null,
    });
    expect(r.callId).toBe('call-1');
    expect(r.status).toBe('success');
    expect(r.content).toBe('cloud-result');
    expect(r.durationMs).toBeTypeOf('number');
  });

  it('dispatchInvocationNormalizesErrorJsonResult', async () => {
    cloudTool.execute.mockResolvedValue('{"error":"boom"}');
    const r = await dispatcher.dispatchInvocation({
      callId: 'c', toolName: 'read_file', argumentsJson: '{}',
      executionMode: 'CLOUD', sessionId: 7, userId: 9, executionUserId: null,
      workspace: 'w', permissionLevel: 'FULL', modelConfig: null, sessionTools: null,
    });
    expect(r.status).toBe('error');
    expect(r.errorMessage).toBe('boom');
  });

  it('dispatchInvocationCatchesUnknownToolInsteadOfThrowing', async () => {
    const r = await dispatcher.dispatchInvocation({
      callId: 'c', toolName: 'missing', argumentsJson: '{}',
      executionMode: 'CLOUD', sessionId: null, userId: null, executionUserId: null,
      workspace: null, permissionLevel: null, modelConfig: null, sessionTools: null,
    });
    expect(r.status).toBe('error');
    expect(r.content).toBe('Tool execution failed: Unknown tool: missing');
  });

  it('dispatchInvocationUsesDescriptorSourceMcpForApprovalEvenWithoutNamePrefix', async () => {
    const descTool: Tool = {
      ...mockTool('namespace_write'),
      getDescriptor: () => ({
        name: 'namespace_write', source: 'mcp', executor: 'desktop', serverId: 1, originalName: 'write',
      }),
    };
    localToolExecutor.execute.mockResolvedValue('executed');
    const r = await dispatcher.dispatchInvocation({
      callId: 'c', toolName: 'namespace_write', argumentsJson: '{}',
      executionMode: 'LOCAL', sessionId: 7, userId: 9, executionUserId: null,
      workspace: 'w', permissionLevel: 'READ_ONLY', modelConfig: null, sessionTools: [descTool],
    });
    expect(r.status).toBe('success');
    expect(localToolExecutor.execute).toHaveBeenCalledWith(7, 'namespace_write', '{}', 'w', true, null);
  });
});

describe('ToolRegistry', () => {
  it('registersAndLooksUpToolsByName', () => {
    const first = mockTool('first');
    const second = mockTool('second');
    const registry = new ToolRegistry([first]);
    registry.register(second);
    expect(registry.getTool('first')).toBe(first);
    expect(registry.getAllTools()).toEqual(expect.arrayContaining([first, second]));
    expect(registry.getToolsByNames(['missing', 'second', 'first'])).toEqual([second, first]);
  });
});
