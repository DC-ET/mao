import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AskUserQuestionsRegistry } from './ask-user-questions-registry.js';
import { DangerAssessor } from './danger-assessor.js';
import { ToolDispatcher, IllegalArgumentException, type InboxRecorder } from './tool-dispatcher.js';
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
  const scheduledTools = [
    'create_scheduled_task', 'update_scheduled_task', 'list_scheduled_tasks', 'delete_scheduled_task',
  ].map(mockTool);
  const registry = new ToolRegistry([serverTool, cloudTool, mcpTool, ...scheduledTools]);
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
    sessionMapper.selectById.mockResolvedValue(null);
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
    for (const tool of scheduledTools) tool.execute.mockReset();
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

  it('dispatchesScheduledTaskToolsOnServerInLocalMode', async () => {
    for (const tool of scheduledTools) {
      tool.execute.mockResolvedValue('scheduled');
      const result = await dispatcher.dispatch(tool.getName(), '{}', 'LOCAL', 7, 9, 'workspace', 'FULL', null);
      expect(result).toBe('scheduled');
    }
    expect(localToolExecutor.execute).not.toHaveBeenCalled();
  });

  it('askUserQuestionsRejectsEmptyQuestionsWithoutWaiting', async () => {
    localToolSessionRegistry.getUserIdForSession.mockResolvedValue(9);
    streamingWsRegistry.hasConnection.mockReturnValue(true);
    const result = await dispatcher.dispatch('ask_user_questions', '{"questions":[]}', 'CLOUD', 7, 'workspace');
    expect(JSON.parse(result)).toEqual({ error: 'questions 不能为空，请提供至少 1 个问题' });
    expect(askUserQuestionsRegistry.register).not.toHaveBeenCalled();
    expect(askUserQuestionsRegistry.waitForAnswer).not.toHaveBeenCalled();
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

  it('askUserQuestionsFallsBackToSessionLookupAndWaitsOfflineWithoutNotifier', async () => {
    localToolSessionRegistry.getUserIdForSession.mockResolvedValue(null);
    sessionMapper.selectById.mockResolvedValue({ userId: 9, title: '任务A' });
    streamingWsRegistry.hasConnection.mockReturnValue(false);
    askUserQuestionsRegistry.register.mockReturnValue('req-offline');
    askUserQuestionsRegistry.waitForAnswer.mockResolvedValue({ answered: true, cancelled: false, resultJson: '{"answers":[{}]}' });
    const result = await dispatcher.dispatch('ask_user_questions', '{"questions":[{"id":"q1"}]}', 'CLOUD', 7, 'workspace');
    expect(result).toBe('{"answers":[{}]}');
    expect(askUserQuestionsRegistry.register).toHaveBeenCalled();
    // 未注入 notifier 时离线也照常等待（不报错），只是不发 Webhook
    expect(streamingWsRegistry.send).toHaveBeenCalledTimes(1);
  });

  it('askUserQuestionsOfflinePreparesWebhookNotificationAndSuppressesAfterAnswer', async () => {
    const notifier = {
      prepareAskUser: vi.fn().mockResolvedValue({ id: 5 }),
      suppressPending: vi.fn().mockResolvedValue(undefined),
    };
    const offlineDispatcher = new ToolDispatcher(
      registry, localToolExecutor, dangerAssessor, sessionMapper, streamingWsRegistry,
      askUserQuestionsRegistry, localToolSessionRegistry, treeSignalPublisher, null, notifier,
    );
    localToolSessionRegistry.getUserIdForSession.mockResolvedValue(9);
    streamingWsRegistry.hasConnection.mockReturnValue(false);
    askUserQuestionsRegistry.register.mockReturnValue('req-1');
    sessionMapper.selectById.mockResolvedValue({ userId: 9, title: '任务A' });
    askUserQuestionsRegistry.waitForAnswer.mockResolvedValue({ answered: true, cancelled: false, resultJson: '{"answers":[{}]}' });
    const result = await offlineDispatcher.dispatch(
      'ask_user_questions', '{"questions":[{"id":"q1"}]}', 'CLOUD', 7, 'workspace',
    );
    expect(result).toBe('{"answers":[{}]}');
    expect(notifier.prepareAskUser).toHaveBeenCalledWith(7, 9, 'req-1', '任务A');
    expect(notifier.suppressPending).toHaveBeenCalledWith({ id: 5 });
    // 已回答：不广播取消事件
    expect(streamingWsRegistry.send).toHaveBeenCalledTimes(1);
  });

  it('askUserQuestionsOfflineStillSuppressesWhenUnansweredAndNotifiesCancelled', async () => {
    const notifier = {
      prepareAskUser: vi.fn().mockResolvedValue({ id: 6 }),
      suppressPending: vi.fn().mockResolvedValue(undefined),
    };
    const offlineDispatcher = new ToolDispatcher(
      registry, localToolExecutor, dangerAssessor, sessionMapper, streamingWsRegistry,
      askUserQuestionsRegistry, localToolSessionRegistry, treeSignalPublisher, null, notifier,
    );
    localToolSessionRegistry.getUserIdForSession.mockResolvedValue(9);
    streamingWsRegistry.hasConnection.mockReturnValue(false);
    askUserQuestionsRegistry.register.mockReturnValue('req-2');
    sessionMapper.selectById.mockResolvedValue({ userId: 9, title: '任务B' });
    askUserQuestionsRegistry.waitForAnswer.mockResolvedValue({ answered: false, cancelled: false, resultJson: '{"error":"timeout"}' });
    const result = await offlineDispatcher.dispatch('ask_user_questions', '{"questions":[{"id":"q1"}]}', 'CLOUD', 7, 'workspace');
    expect(result).toContain('timeout');
    expect(notifier.prepareAskUser).toHaveBeenCalledWith(7, 9, 'req-2', '任务B');
    expect(notifier.suppressPending).toHaveBeenCalledWith({ id: 6 });
    expect(streamingWsRegistry.send).toHaveBeenCalledTimes(2);
  });

  it('askUserQuestionsOfflineContinuesToWaitWhenWebhookPreparationFails', async () => {
    const notifier = {
      prepareAskUser: vi.fn().mockRejectedValue(new Error('db down')),
      suppressPending: vi.fn().mockResolvedValue(undefined),
    };
    const offlineDispatcher = new ToolDispatcher(
      registry, localToolExecutor, dangerAssessor, sessionMapper, streamingWsRegistry,
      askUserQuestionsRegistry, localToolSessionRegistry, treeSignalPublisher, null, notifier,
    );
    localToolSessionRegistry.getUserIdForSession.mockResolvedValue(9);
    streamingWsRegistry.hasConnection.mockReturnValue(false);
    askUserQuestionsRegistry.register.mockReturnValue('req-3');
    sessionMapper.selectById.mockResolvedValue({ userId: 9, title: '任务C' });
    askUserQuestionsRegistry.waitForAnswer.mockResolvedValue({ answered: true, cancelled: false, resultJson: '{"answers":[{}]}' });
    const result = await offlineDispatcher.dispatch('ask_user_questions', '{"questions":[{"id":"q1"}]}', 'CLOUD', 7, 'workspace');
    expect(result).toBe('{"answers":[{}]}');
    expect(notifier.suppressPending).not.toHaveBeenCalled();
  });

  function feishuAskMount(overrides: Partial<{
    hasRunningProgress: (sessionId: number) => boolean;
    mount: (sessionId: number, requestId: string, questions: Array<Record<string, unknown>>) => Promise<boolean>;
    clearRequest: (sessionId: number, requestId: string) => void;
  }> = {}) {
    return {
      hasRunningProgress: vi.fn(overrides.hasRunningProgress ?? (() => false)),
      mount: vi.fn(overrides.mount ?? (async () => true)),
      clearRequest: vi.fn(overrides.clearRequest ?? (() => undefined)),
    };
  }

  function dispatcherWithFeishu(feishuAsk: ReturnType<typeof feishuAskMount>, notifier?: {
    prepareAskUser: ReturnType<typeof vi.fn>;
    suppressPending: ReturnType<typeof vi.fn>;
  } | null) {
    return new ToolDispatcher(
      registry, localToolExecutor, dangerAssessor, sessionMapper, streamingWsRegistry,
      askUserQuestionsRegistry, localToolSessionRegistry, treeSignalPublisher, null, notifier ?? null, feishuAsk,
    );
  }

  it('feishuSessionRejectsAskUserQuestions', async () => {
    const feishuAsk = feishuAskMount({ hasRunningProgress: () => true, mount: async () => true });
    const feishu = dispatcherWithFeishu(feishuAsk);
    localToolSessionRegistry.getUserIdForSession.mockResolvedValue(9);
    streamingWsRegistry.hasConnection.mockReturnValue(true);
    sessionMapper.selectById.mockResolvedValue({
      userId: 9, title: '飞书任务', projectKey: 'feishu-1-private-9', workspace: '/ws/feishu-1-private-9',
    });
    const result = await feishu.dispatch(
      'ask_user_questions',
      '{"questions":[{"question":"选哪个？","options":[{"label":"甲"}],"multiSelect":false}]}',
      'CLOUD', 7, 'workspace',
    );
    expect(JSON.parse(result)).toEqual({ error: '当前通道不支持向用户提问，请在回复中直接说明' });
    expect(askUserQuestionsRegistry.register).not.toHaveBeenCalled();
    expect(askUserQuestionsRegistry.waitForAnswer).not.toHaveBeenCalled();
    expect(feishuAsk.mount).not.toHaveBeenCalled();
    expect(feishuAsk.clearRequest).not.toHaveBeenCalled();
    expect(streamingWsRegistry.send).not.toHaveBeenCalled();
  });

  it('feishuGroupSessionRejectsAskUserQuestions', async () => {
    const feishuAsk = feishuAskMount({ hasRunningProgress: () => false });
    const feishu = dispatcherWithFeishu(feishuAsk);
    localToolSessionRegistry.getUserIdForSession.mockResolvedValue(9);
    streamingWsRegistry.hasConnection.mockReturnValue(false);
    sessionMapper.selectById.mockResolvedValue({
      userId: 9, projectKey: 'oc_group', workspace: '/data/workspace/feishu-chat/1/oc_group',
    });
    const result = await feishu.dispatch('ask_user_questions', '{"questions":[{"question":"q"}]}', 'CLOUD', 7, 'workspace');
    expect(JSON.parse(result)).toEqual({ error: '当前通道不支持向用户提问，请在回复中直接说明' });
    expect(askUserQuestionsRegistry.register).not.toHaveBeenCalled();
  });

  it('nonFeishuSessionStillPreparesTheOfflineWebhookWhenFeishuMountIsWired', async () => {
    const notifier = {
      prepareAskUser: vi.fn().mockResolvedValue({ id: 8 }),
      suppressPending: vi.fn().mockResolvedValue(undefined),
    };
    const feishuAsk = feishuAskMount();
    const wired = dispatcherWithFeishu(feishuAsk, notifier);
    localToolSessionRegistry.getUserIdForSession.mockResolvedValue(9);
    streamingWsRegistry.hasConnection.mockReturnValue(false);
    sessionMapper.selectById.mockResolvedValue({ userId: 9, title: '桌面任务', projectKey: 'proj', workspace: '/ws' });
    askUserQuestionsRegistry.register.mockReturnValue('req-desktop');
    askUserQuestionsRegistry.waitForAnswer.mockResolvedValue({ answered: true, cancelled: false, resultJson: '{"answers":[]}' });
    await wired.dispatch('ask_user_questions', '{"questions":[{"id":"q1"}]}', 'CLOUD', 7, 'workspace');
    expect(notifier.prepareAskUser).toHaveBeenCalledWith(7, 9, 'req-desktop', '桌面任务');
    expect(feishuAsk.mount).not.toHaveBeenCalled();
    expect(feishuAsk.clearRequest).not.toHaveBeenCalled();
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

  describe('PROXY level', () => {
    const proxyApprover = { decide: vi.fn() };
    const jev = { assessRisk: vi.fn() };
    const resolver = { resolve: vi.fn(async (fallback: unknown) => fallback) };
    const proxyDispatcher = new ToolDispatcher(
      registry, localToolExecutor, dangerAssessor, sessionMapper, streamingWsRegistry,
      askUserQuestionsRegistry, localToolSessionRegistry, treeSignalPublisher,
      null, null, null,
      proxyApprover as never, jev as never, resolver as never,
    );

    beforeEach(() => {
      proxyApprover.decide.mockReset();
      proxyApprover.decide.mockResolvedValue({ ok: true, approved: true, reason: '符合用户指令' });
      jev.assessRisk.mockReset();
      jev.assessRisk.mockResolvedValue({ ok: false, highRisk: false, probability: 0, reason: 'jev not configured' });
      resolver.resolve.mockClear();
    });

    it('autoExecutesReadAndWriteToolsWithoutApprovalOrMark', async () => {
      localToolExecutor.execute.mockResolvedValue('ok');
      const r = await proxyDispatcher.dispatchInvocation({
        callId: 'c1', toolName: 'write_file', argumentsJson: '{}',
        executionMode: 'LOCAL', sessionId: 7, userId: 9, executionUserId: null,
        workspace: 'w', permissionLevel: 'PROXY', modelConfig: { modelId: 'test' }, sessionTools: null,
      });
      expect(localToolExecutor.execute).toHaveBeenCalledWith(7, 'write_file', '{}', 'w', false, null);
      expect(r.approvalMark ?? null).toBeNull();
      expect(proxyApprover.decide).not.toHaveBeenCalled();
      expect(jev.assessRisk).not.toHaveBeenCalled();
    });

    it('llmApproveExecutesWithApprovalMark', async () => {
      localToolExecutor.execute.mockResolvedValue('executed');
      const r = await proxyDispatcher.dispatchInvocation({
        callId: 'c2', toolName: 'shell', argumentsJson: '{"command":"rm -rf ./dist"}',
        executionMode: 'LOCAL', sessionId: 7, userId: 9, executionUserId: null,
        workspace: 'w', permissionLevel: 'PROXY', modelConfig: { modelId: 'test' }, sessionTools: null,
        contextSnapshot: '## 用户指令\n1. 清理构建产物',
      });
      expect(r.status).toBe('success');
      expect(r.approvalMark).toEqual({ mode: 'llm', approved: true, reason: '符合用户指令' });
      expect(localToolExecutor.execute).toHaveBeenCalledWith(7, 'shell', '{"command":"rm -rf ./dist"}', 'w', false, null);
      expect(proxyApprover.decide).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'shell',
          contextSnapshot: '## 用户指令\n1. 清理构建产物',
        }),
        expect.objectContaining({ modelId: 'test' }),
      );
    });

    it('llmDenyShortCircuitsWithoutExecuting', async () => {
      proxyApprover.decide.mockResolvedValue({ ok: true, approved: false, reason: '超出用户指令范围' });
      const r = await proxyDispatcher.dispatchInvocation({
        callId: 'c3', toolName: 'shell', argumentsJson: '{"command":"rm -rf ~"}',
        executionMode: 'LOCAL', sessionId: 7, userId: 9, executionUserId: null,
        workspace: 'w', permissionLevel: 'PROXY', modelConfig: { modelId: 'test' }, sessionTools: null,
      });
      expect(r.status).toBe('error');
      expect(r.content).toContain('工具调用被 AI 审批拒绝：超出用户指令范围');
      expect(r.approvalMark).toEqual({ mode: 'llm', approved: false, reason: '超出用户指令范围' });
      expect(localToolExecutor.execute).not.toHaveBeenCalled();
    });

    it('jevLowRiskSkipsLlmAndMarksViaJev', async () => {
      jev.assessRisk.mockResolvedValue({ ok: true, highRisk: false, probability: 0.03, reason: '' });
      localToolExecutor.execute.mockResolvedValue('executed');
      const r = await proxyDispatcher.dispatchInvocation({
        callId: 'c4', toolName: 'shell', argumentsJson: '{"command":"ls -la"}',
        executionMode: 'LOCAL', sessionId: 7, userId: 9, executionUserId: null,
        workspace: 'w', permissionLevel: 'PROXY', modelConfig: { modelId: 'test' }, sessionTools: null,
      });
      expect(r.status).toBe('success');
      expect(r.approvalMark).toEqual({ mode: 'jev', approved: true, reason: '前置决策判定低风险（P=0.03）' });
      expect(proxyApprover.decide).not.toHaveBeenCalled();
    });

    it('jevHighRiskHandsOffToLlm', async () => {
      jev.assessRisk.mockResolvedValue({ ok: true, highRisk: true, probability: 0.98, reason: '' });
      localToolExecutor.execute.mockResolvedValue('executed');
      await proxyDispatcher.dispatchInvocation({
        callId: 'c5', toolName: 'shell', argumentsJson: '{"command":"rm -rf /"}',
        executionMode: 'LOCAL', sessionId: 7, userId: 9, executionUserId: null,
        workspace: 'w', permissionLevel: 'PROXY', modelConfig: { modelId: 'test' }, sessionTools: null,
      });
      expect(proxyApprover.decide).toHaveBeenCalled();
    });

    it('llmFailureFallsBackToManualApproval', async () => {
      proxyApprover.decide.mockResolvedValue({ ok: false, approved: false, reason: 'rate limited' });
      localToolExecutor.execute.mockResolvedValue('needs-approval');
      const r = await proxyDispatcher.dispatchInvocation({
        callId: 'c6', toolName: 'shell', argumentsJson: '{"command":"rm -rf ./dist"}',
        executionMode: 'LOCAL', sessionId: 7, userId: 9, executionUserId: null,
        workspace: 'w', permissionLevel: 'PROXY', modelConfig: { modelId: 'test' }, sessionTools: null,
      });
      expect(localToolExecutor.execute).toHaveBeenCalledWith(
        7, 'shell', '{"command":"rm -rf ./dist"}', 'w', true, 'AI 审批异常（rate limited），转人工审批',
      );
      expect(r.approvalMark ?? null).toBeNull();
    });

    it('missingModelConfigFallsBackToManualApproval', async () => {
      resolver.resolve.mockResolvedValueOnce(null);
      localToolExecutor.execute.mockResolvedValue('needs-approval');
      await proxyDispatcher.dispatchInvocation({
        callId: 'c7', toolName: 'shell', argumentsJson: '{}',
        executionMode: 'LOCAL', sessionId: 7, userId: 9, executionUserId: null,
        workspace: 'w', permissionLevel: 'PROXY', modelConfig: null, sessionTools: null,
      });
      expect(localToolExecutor.execute).toHaveBeenCalledWith(7, 'shell', '{}', 'w', true, '无法进行 AI 审批，默认需要审批');
      expect(proxyApprover.decide).not.toHaveBeenCalled();
    });

    it('mcpToolGoesThroughLlmApproval', async () => {
      localToolExecutor.execute.mockResolvedValue('executed');
      const r = await proxyDispatcher.dispatchInvocation({
        callId: 'c8', toolName: 'mcp__filesystem__write_file', argumentsJson: '{"path":"a.txt"}',
        executionMode: 'LOCAL', sessionId: 7, userId: 9, executionUserId: null,
        workspace: 'w', permissionLevel: 'PROXY', modelConfig: { modelId: 'test' }, sessionTools: null,
      });
      expect(jev.assessRisk).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'mcp__filesystem__write_file' }));
      expect(proxyApprover.decide).toHaveBeenCalled();
      expect(r.approvalMark).toEqual({ mode: 'llm', approved: true, reason: '符合用户指令' });
    });

    it('usesAdminConfiguredApprovalModelWhenResolverProvidesOne', async () => {
      const adminModel = { modelId: 'admin-approval-model' };
      resolver.resolve.mockResolvedValueOnce(adminModel);
      localToolExecutor.execute.mockResolvedValue('executed');
      await proxyDispatcher.dispatchInvocation({
        callId: 'c9', toolName: 'shell', argumentsJson: '{}',
        executionMode: 'LOCAL', sessionId: 7, userId: 9, executionUserId: null,
        workspace: 'w', permissionLevel: 'PROXY', modelConfig: { modelId: 'session-model' }, sessionTools: null,
      });
      expect(proxyApprover.decide).toHaveBeenCalledWith(expect.anything(), adminModel);
    });
  });

  describe('SMART level with Jev prefilter', () => {
    const proxyApprover = { decide: vi.fn() };
    const jev = { assessRisk: vi.fn() };
    const resolver = { resolve: vi.fn(async (fallback: unknown) => fallback) };
    const smartDispatcher = new ToolDispatcher(
      registry, localToolExecutor, dangerAssessor, sessionMapper, streamingWsRegistry,
      askUserQuestionsRegistry, localToolSessionRegistry, treeSignalPublisher,
      null, null, null,
      proxyApprover as never, jev as never, resolver as never,
    );

    beforeEach(() => {
      jev.assessRisk.mockReset();
      resolver.resolve.mockClear();
    });

    it('jevLowRiskSkipsDangerAssessor', async () => {
      jev.assessRisk.mockResolvedValue({ ok: true, highRisk: false, probability: 0.02, reason: '' });
      localToolExecutor.execute.mockResolvedValue('executed');
      await smartDispatcher.dispatch('shell', '{"command":"ls"}', 'LOCAL', 7, 'workspace', 'SMART', { modelId: 'test' });
      expect(assessSpy).not.toHaveBeenCalled();
      expect(localToolExecutor.execute).toHaveBeenCalledWith(7, 'shell', '{"command":"ls"}', 'workspace', false, null);
    });

    it('jevHighRiskFallsThroughToDangerAssessor', async () => {
      jev.assessRisk.mockResolvedValue({ ok: true, highRisk: true, probability: 0.9, reason: '' });
      assessSpy.mockResolvedValue({ dangerous: true, reason: '危险' });
      localToolExecutor.execute.mockResolvedValue('needs-approval');
      await smartDispatcher.dispatch('shell', '{"command":"rm -rf /"}', 'LOCAL', 7, 'workspace', 'SMART', { modelId: 'test' });
      expect(assessSpy).toHaveBeenCalled();
      expect(localToolExecutor.execute).toHaveBeenCalledWith(7, 'shell', '{"command":"rm -rf /"}', 'workspace', true, '危险');
    });

    it('jevUnavailableDegradesToDangerAssessor', async () => {
      jev.assessRisk.mockResolvedValue({ ok: false, highRisk: false, probability: 0, reason: 'jev not configured' });
      assessSpy.mockResolvedValue({ dangerous: false, reason: null });
      localToolExecutor.execute.mockResolvedValue('executed');
      await smartDispatcher.dispatch('shell', '{"command":"ls"}', 'LOCAL', 7, 'workspace', 'SMART', { modelId: 'test' });
      expect(assessSpy).toHaveBeenCalled();
    });

    it('smartModeUsesAdminConfiguredApprovalModel', async () => {
      jev.assessRisk.mockResolvedValue({ ok: false, highRisk: false, probability: 0, reason: 'jev not configured' });
      const adminModel = { modelId: 'admin-approval-model' };
      resolver.resolve.mockResolvedValueOnce(adminModel);
      assessSpy.mockResolvedValue({ dangerous: false, reason: null });
      localToolExecutor.execute.mockResolvedValue('executed');
      await smartDispatcher.dispatch('shell', '{"command":"ls"}', 'LOCAL', 7, 'workspace', 'SMART', { modelId: 'session-model' });
      expect(assessSpy).toHaveBeenCalledWith('{"command":"ls"}', adminModel);
    });

    it('smartMcpStillRequiresManualApprovalWithoutPrefilter', async () => {
      localToolExecutor.execute.mockResolvedValue('executed');
      await smartDispatcher.dispatch(
        'mcp__filesystem__write_file', '{}', 'LOCAL', 7, 'workspace', 'SMART', { modelId: 'test' },
      );
      expect(jev.assessRisk).not.toHaveBeenCalled();
      expect(localToolExecutor.execute).toHaveBeenCalledWith(
        7, 'mcp__filesystem__write_file', '{}', 'workspace', true, 'MCP 工具调用需要用户确认',
      );
    });
  });

  describe('收件箱写入（QUESTION_PENDING / 联动置已读）', () => {
  function inboxRecorderSpy(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      recordQuestionPending: vi.fn(async () => undefined),
      resolvePending: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  function buildDispatcher(recorder: ReturnType<typeof inboxRecorderSpy>) {
    return new ToolDispatcher(
      registry, localToolExecutor, dangerAssessor, sessionMapper, streamingWsRegistry,
      askUserQuestionsRegistry, localToolSessionRegistry, treeSignalPublisher,
      null, null, null, null, null, null, recorder as never,
    );
  }

  const ARGS = '{"questions":[{"id":"q1"}]}';

  function resetMocks() {
    sessionMapper.selectById.mockReset();
    sessionMapper.selectById.mockResolvedValue(null);
    streamingWsRegistry.hasConnection.mockReset();
    streamingWsRegistry.hasConnection.mockReturnValue(true);
    streamingWsRegistry.send.mockReset();
    askUserQuestionsRegistry.register.mockReset();
    askUserQuestionsRegistry.register.mockReturnValue('req-inbox');
    askUserQuestionsRegistry.waitForAnswer.mockReset();
    localToolSessionRegistry.getUserIdForSession.mockReset();
    localToolSessionRegistry.getUserIdForSession.mockResolvedValue(9);
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('提问注册后写入 QUESTION_PENDING（不区分用户在线与否）', async () => {
    resetMocks();
    const recorder = inboxRecorderSpy();
    askUserQuestionsRegistry.waitForAnswer.mockResolvedValue({ answered: true, cancelled: false, resultJson: '{"answers":[]}' });
    await buildDispatcher(recorder).dispatch('ask_user_questions', ARGS, 'CLOUD', 7, 'workspace');
    await settle();
    expect(recorder.recordQuestionPending).toHaveBeenCalledWith({ userId: 9, sessionId: 7, requestId: 'req-inbox' });
  });

  it('已回答时联动置已读（三态之一）', async () => {
    resetMocks();
    const recorder = inboxRecorderSpy();
    askUserQuestionsRegistry.waitForAnswer.mockResolvedValue({ answered: true, cancelled: false, resultJson: '{"answers":[]}' });
    await buildDispatcher(recorder).dispatch('ask_user_questions', ARGS, 'CLOUD', 7, 'workspace');
    await settle();
    // 判定只读结构化标记 result.answered / result.cancelled，不解析 resultJson 文本
    expect(recorder.resolvePending).toHaveBeenCalledWith(9, 'QUESTION_PENDING', 7, 'req-inbox');
  });

  it('随会话取消（cancelled:true）时同样置已读（三态之二）', async () => {
    resetMocks();
    const recorder = inboxRecorderSpy();
    askUserQuestionsRegistry.waitForAnswer.mockResolvedValue({ answered: true, cancelled: true, resultJson: '{"cancelled":true}' });
    await buildDispatcher(recorder).dispatch('ask_user_questions', ARGS, 'CLOUD', 7, 'workspace');
    await settle();
    expect(recorder.resolvePending).toHaveBeenCalledWith(9, 'QUESTION_PENDING', 7, 'req-inbox');
  });

  it('900s 超时（answered:false）时置已读（三态之三）', async () => {
    resetMocks();
    const recorder = inboxRecorderSpy();
    askUserQuestionsRegistry.waitForAnswer.mockResolvedValue({ answered: false, cancelled: false, resultJson: '{"error":"timeout"}' });
    await buildDispatcher(recorder).dispatch('ask_user_questions', ARGS, 'CLOUD', 7, 'workspace');
    await settle();
    expect(recorder.resolvePending).toHaveBeenCalledWith(9, 'QUESTION_PENDING', 7, 'req-inbox');
  });

  it('置已读键与写入键一致（同 requestId 尾段，防两侧漂移）', async () => {
    resetMocks();
    const recorder = inboxRecorderSpy();
    askUserQuestionsRegistry.waitForAnswer.mockResolvedValue({ answered: true, cancelled: false, resultJson: '{"answers":[]}' });
    await buildDispatcher(recorder).dispatch('ask_user_questions', ARGS, 'CLOUD', 7, 'workspace');
    await settle();
    expect(recorder.resolvePending.mock.calls[0][3]).toBe(recorder.recordQuestionPending.mock.calls[0][0].requestId);
  });

  it('飞书会话被拒：既不写提问也不置已读', async () => {
    resetMocks();
    const recorder = inboxRecorderSpy();
    const feishuAsk = { hasRunningProgress: () => true, mount: vi.fn(), clearRequest: vi.fn() };
    const feishu = new ToolDispatcher(
      registry, localToolExecutor, dangerAssessor, sessionMapper, streamingWsRegistry,
      askUserQuestionsRegistry, localToolSessionRegistry, treeSignalPublisher,
      null, null, feishuAsk, null, null, null, recorder as never,
    );
    sessionMapper.selectById.mockResolvedValue({
      userId: 9, projectKey: 'feishu-1-private-9', workspace: '/ws/feishu-1-private-9',
    });
    await feishu.dispatch('ask_user_questions', ARGS, 'CLOUD', 7, 'workspace');
    await settle();
    expect(recorder.recordQuestionPending).not.toHaveBeenCalled();
    expect(recorder.resolvePending).not.toHaveBeenCalled();
  });

  it('收件箱写入失败不打断提问链路（异常全吞）', async () => {
    resetMocks();
    const recorder = inboxRecorderSpy({
      recordQuestionPending: vi.fn(async () => { throw new Error('db down'); }),
      resolvePending: vi.fn(async () => { throw new Error('db down'); }),
    });
    askUserQuestionsRegistry.waitForAnswer.mockResolvedValue({ answered: true, cancelled: false, resultJson: '{"answers":[]}' });
    await expect(buildDispatcher(recorder).dispatch('ask_user_questions', ARGS, 'CLOUD', 7, 'workspace'))
      .resolves.toBe('{"answers":[]}');
  });

  it('未注入 inboxRecorder 时行为与改造前一致（零影响）', async () => {
    resetMocks();
    const notWired = new ToolDispatcher(
      registry, localToolExecutor, dangerAssessor, sessionMapper, streamingWsRegistry,
      askUserQuestionsRegistry, localToolSessionRegistry, treeSignalPublisher,
    );
    askUserQuestionsRegistry.waitForAnswer.mockResolvedValue({ answered: true, cancelled: false, resultJson: '{"answers":[]}' });
    await expect(notWired.dispatch('ask_user_questions', ARGS, 'CLOUD', 7, 'workspace'))
      .resolves.toBe('{"answers":[]}');
    });
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

describe('ToolDispatcher 审批规则短路（V135）', () => {
  const shellTool = mockTool('shell');
  const mcpTool = mockTool('mcp__fs__read');
  const writeTool = mockTool('write_file');
  const rulesRegistry = new ToolRegistry([shellTool, mcpTool, writeTool]);
  const rulesExecutor = { execute: vi.fn().mockResolvedValue('local-ok') } as unknown as LocalToolExecutor & { execute: ReturnType<typeof vi.fn> };
  const rulesDangerAssessor = new DangerAssessor({ chat: vi.fn(), stream: vi.fn() } as unknown as LlmAdapter);
  const rulesAssessSpy = vi.spyOn(rulesDangerAssessor, 'assess');
  const rulesSessionMapper = { selectById: vi.fn() } as unknown as SessionMapper & { selectById: ReturnType<typeof vi.fn> };
  const rulesWsRegistry = { hasConnection: vi.fn(), send: vi.fn() } as unknown as StreamingWsRegistry;
  const rulesAskRegistry = { register: vi.fn(), waitForAnswer: vi.fn() } as unknown as AskUserQuestionsRegistry;
  const rulesSessions = { getUserIdForSession: vi.fn(), isConnected: vi.fn().mockResolvedValue(false) } as unknown as LocalToolSessionRegistry;
  const rulesTreePublisher = { publishForSession: vi.fn() } as unknown as SessionTreeSignalPublisher;

  const match = vi.fn();
  const buildHint = vi.fn();
  const recordHit = vi.fn();
  const ruleFacade = { match, buildHint, recordHit };

  function rulesDispatcher(): ToolDispatcher {
    return new ToolDispatcher(
      rulesRegistry, rulesExecutor, rulesDangerAssessor, rulesSessionMapper, rulesWsRegistry,
      rulesAskRegistry, rulesSessions, rulesTreePublisher,
      null, null, null, null, null, null, null, ruleFacade,
    );
  }

  beforeEach(() => {
    match.mockReset().mockResolvedValue(null);
    buildHint.mockReset().mockResolvedValue(null);
    recordHit.mockReset();
    rulesAssessSpy.mockClear();
    rulesExecutor.execute.mockClear();
    rulesSessionMapper.selectById.mockReset().mockResolvedValue({ permissionLevel: 'SMART' });
  });

  it('ruleHitShortCircuitsApprovalAndMarksToolResult', async () => {
    match.mockResolvedValue({ ruleId: 12, ruleValue: 'npm run' });
    const result = await rulesDispatcher().dispatchInvocation({
      callId: 'c1', toolName: 'shell', argumentsJson: '{"command":"npm run test"}',
      executionMode: 'LOCAL', sessionId: 7, userId: 9, workspace: 'ws',
      permissionLevel: 'SMART', modelConfig: null, sessionTools: null,
    } as never);
    // 静默放行：直接执行且无需审批
    expect(rulesExecutor.execute).toHaveBeenCalledWith(7, 'shell', '{"command":"npm run test"}', 'ws', false, null);
    expect(recordHit).toHaveBeenCalledWith(12);
    // 短路收益：Jev 前置与 DangerAssessor 不再运行（无 danger_assess 的 llm_call）
    expect(rulesAssessSpy).not.toHaveBeenCalled();
    // rule 徽标直通（不经 llmVerdict 推导）
    expect(result.approvalMark).toEqual({ mode: 'rule', approved: true, reason: '规则放行：npm run', ruleId: 12 });
  });

  it('ruleMatchingSkippedForReadOnlyAndFullLevels', async () => {
    for (const level of ['READ_ONLY', 'FULL']) {
      rulesSessionMapper.selectById.mockResolvedValue({ permissionLevel: level });
      await rulesDispatcher().dispatch('shell', '{"command":"npm run test"}', 'LOCAL', 7, 9, 'workspace', level, null);
      expect(match).not.toHaveBeenCalled();
      expect(rulesExecutor.execute).toHaveBeenCalled();
      rulesExecutor.execute.mockClear();
    }
  });

  it('ruleMatchingSkipsWhenTriggerUserUnknown', async () => {
    await rulesDispatcher().dispatch('shell', '{"command":"npm run test"}', 'LOCAL', 7, 'workspace', 'SMART', null);
    expect(match).not.toHaveBeenCalled();
    expect(rulesExecutor.execute).toHaveBeenCalled();
  });

  it('ruleMatchingSkipsNonRuleableTools', async () => {
    // READ_WRITE/SMART/PROXY 下 write_file 本来就不审批：不查规则、不计数、无徽标
    await rulesDispatcher().dispatch('write_file', '{"path":"x"}', 'LOCAL', 7, 9, 'workspace', 'READ_WRITE', null);
    expect(match).not.toHaveBeenCalled();
    expect(rulesExecutor.execute).toHaveBeenCalledWith(7, 'write_file', '{"path":"x"}', 'workspace', false, null);
  });

  it('ruleMissFallsBackToNormalChainWithApprovalHint', async () => {
    buildHint.mockResolvedValue({ ruleType: 'SHELL_PREFIX', ruleValue: 'npm run', label: '本会话总是允许以 npm run 开头的命令' });
    await rulesDispatcher().dispatch('shell', '{"command":"npm run build"}', 'LOCAL', 7, 9, 'workspace', 'SMART', null);
    expect(match).toHaveBeenCalledTimes(1);
    expect(buildHint).toHaveBeenCalledWith('shell', '{"command":"npm run build"}');
    expect(rulesExecutor.execute).toHaveBeenCalledWith(
      7, 'shell', '{"command":"npm run build"}', 'workspace', true, '无法进行安全评估，默认需要审批',
      { ruleType: 'SHELL_PREFIX', ruleValue: 'npm run', label: '本会话总是允许以 npm run 开头的命令' },
    );
  });

  it('noHintForReadOnlyEvenWhenApprovalNeeded', async () => {
    // READ_ONLY 下 shell 规则免疫：弹卡但不给 hint（第三按钮在该档无意义）
    rulesSessionMapper.selectById.mockResolvedValue({ permissionLevel: 'READ_ONLY' });
    await rulesDispatcher().dispatch('shell', '{"command":"npm run build"}', 'LOCAL', 7, 9, 'workspace', 'READ_ONLY', null);
    expect(match).not.toHaveBeenCalled();
    expect(buildHint).not.toHaveBeenCalled();
    expect(rulesExecutor.execute).toHaveBeenCalledWith(
      7, 'shell', '{"command":"npm run build"}', 'workspace', true, null,
    );
  });

  it('ruleHitSkipsApprovalOnShellAsyncPath', async () => {
    match.mockResolvedValue({ ruleId: 3, ruleValue: 'npm run' });
    const bgDispatcher = new ToolDispatcher(
      rulesRegistry, rulesExecutor, rulesDangerAssessor, rulesSessionMapper, rulesWsRegistry,
      rulesAskRegistry, rulesSessions, rulesTreePublisher,
      new BackgroundTaskManager(), null, null, null, null, null, null, ruleFacade,
    );
    const result = await bgDispatcher.dispatch(
      'shell', '{"command":"npm run test","async":true,"action":"exec"}', 'LOCAL', 7, 9, 'workspace', 'SMART', null,
    );
    expect(match).toHaveBeenCalledTimes(1);
    expect(recordHit).toHaveBeenCalledWith(3);
    // isConnected=false → async 路径立即返回连接错误 JSON（规则命中即放行、不弹审批）
    expect(JSON.parse(result)).toHaveProperty('error');
  });
});

