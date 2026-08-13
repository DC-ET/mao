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
  } as unknown as LocalToolSessionRegistry & { getUserIdForSession: ReturnType<typeof vi.fn> };
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
    askUserQuestionsRegistry.waitForAnswer.mockResolvedValue('{"error":"timeout"}');
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
