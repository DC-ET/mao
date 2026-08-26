import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../../common/business-exception.js';
import { shanghaiYmd } from '../../common/json.js';
import { WEIXIN_PROJECT_KEY } from '../../domain/types.js';
import { AgentExecutionContext } from './agent-execution-context.js';
import { CompactionConfig } from './compaction-config.js';
import { HarnessService } from './harness-service.js';
import type { Tool } from '../tool/tool.js';
import type { AgentLoop } from './agent-loop.js';
import type { ToolRegistry } from '../tool/tool-registry.js';

function fakeTool(name: string, weixin = false): Tool {
  return {
    getName: () => name,
    getDescription: () => name,
    getInputSchema: () => ({}),
    getOutputSchema: () => ({}),
    execute: () => '',
    ...(weixin ? { weixinChannelTool: true } : {}),
  } as Tool;
}

function tools(...names: string[]): Tool[] {
  const list = names.map((n) => fakeTool(n));
  list.push(fakeTool('send_wechat_image', true));
  return list;
}

function names(list: Tool[]): string[] {
  return list.map((t) => t.getName());
}

describe('HarnessService.filterToolsForSession', () => {
  it('weixinChannelRemovesAskUserQuestionsButKeepsWeixinTools', () => {
    const filtered = HarnessService.filterToolsForSession(
      tools('ask_user_questions', 'read_file'),
      WEIXIN_PROJECT_KEY,
    );
    expect(names(filtered)).toEqual(expect.arrayContaining(['read_file', 'send_wechat_image']));
    expect(names(filtered)).not.toContain('ask_user_questions');
  });

  it('feishuChannelRemovesAskUserQuestionsAndWeixinTools', () => {
    const filtered = HarnessService.filterToolsForSession(
      tools('ask_user_questions', 'read_file'),
      'feishu-1-private-2',
    );
    expect(names(filtered)).toEqual(['read_file']);
  });

  it('nonWeixinChannelKeepsAskUserQuestionsButRemovesWeixinTools', () => {
    const filtered = HarnessService.filterToolsForSession(
      tools('ask_user_questions', 'read_file'),
      'some-project',
    );
    expect(names(filtered)).toEqual(expect.arrayContaining(['ask_user_questions', 'read_file']));
    expect(names(filtered)).not.toContain('send_wechat_image');
  });

  it('nullProjectKeyBehavesAsNonWeixinChannel', () => {
    const filtered = HarnessService.filterToolsForSession(tools('ask_user_questions'), null);
    expect(names(filtered)).toContain('ask_user_questions');
    expect(names(filtered)).not.toContain('send_wechat_image');
  });

  it('emptyToolsIsSafe', () => {
    expect(HarnessService.filterToolsForSession([], WEIXIN_PROJECT_KEY)).toEqual([]);
  });
});

describe('HarnessService.mergeLocalUnsyncedSkills', () => {
  it('merges unsynced local skills and skips blank names', () => {
    const context = new AgentExecutionContext();
    const merged: string[] = ['java'];
    HarnessService.mergeLocalUnsyncedSkills(
      merged,
      new Set(['java']),
      [
        { name: 'java', description: 'synced' },
        { name: 'local-only', description: 'mine', folderName: 'local-only' },
        { name: '  ', description: 'blank' },
        { name: '', description: 'empty' },
      ],
      context,
    );
    expect(merged).toEqual(['java', 'local-only']);
    expect(context.localUnsyncedSkills.map((s) => s.name)).toEqual(['local-only']);
  });

  it('noops when local skills missing', () => {
    const context = new AgentExecutionContext();
    const merged = ['a'];
    HarnessService.mergeLocalUnsyncedSkills(merged, new Set(), null, context);
    HarnessService.mergeLocalUnsyncedSkills(merged, new Set(), [], context);
    expect(merged).toEqual(['a']);
    expect(context.localUnsyncedSkills).toEqual([]);
  });
});

function model() {
  return {
    id: 3,
    name: 'gpt',
    provider: 'openai',
    baseUrl: 'http://llm',
    apiKey: 'k',
    modelId: 'gpt-test',
    contextWindowTokens: 128000,
    supportsVision: 1,
  };
}

function makeHarness(overrides: Record<string, unknown> = {}) {
  const agentLoop = {
    execute: vi.fn(async () => undefined),
    removeCancelFlag: vi.fn(),
  };
  const toolRegistry = {
    getAllTools: vi.fn(() => [fakeTool('read_file'), fakeTool('ask_user_questions'), fakeTool('send_wechat_image', true)]),
  };
  const skillLoader = {
    hasSkill: vi.fn((n: string) => n === 'java'),
    getAllNames: vi.fn(() => ['java', 'python']),
    getAllDocuments: vi.fn(() => [{ name: 'java', description: 'Java skill' }]),
  };
  const skillSync = {
    syncToSession: vi.fn(async () => undefined),
    getUserSkillNames: vi.fn(() => ['mine']),
    getUserSkillDocuments: vi.fn(() => [{ name: 'mine', description: 'user skill' }]),
    loadAgentServers: vi.fn(async () => []),
    getLocalSessionTools: vi.fn(() => []),
    connectForCloud: vi.fn(async () => ({ tools: [], warnings: [] })),
  };
  const localSkills = { get: vi.fn(() => []) };
  const localAgentsMd = { get: vi.fn(() => null) };
  const sessionMapper = {
    selectById: vi.fn(async () => ({
      id: 10,
      userId: 7,
      agentId: 2,
      executionMode: 'CLOUD',
      projectKey: 'proj',
      workspace: '/ws',
      permissionLevel: 'READ_WRITE',
      modelId: 3,
    })),
  };
  const agentMapper = {
    selectById: vi.fn(async () => ({
      id: 2,
      name: 'Coder',
      systemPrompt: 'You are a coder',
      skillNames: '["java"]',
      configJson: JSON.stringify({ compaction: { enabled: true, maxSummaryTokens: 8000 } }),
    })),
  };
  const experienceService = { listEnabledContents: vi.fn(async () => ['prefer tests']) };
  const llmModelMapper = {
    selectById: vi.fn(async () => model()),
    selectDefault: vi.fn(async () => model()),
  };
  const fileChangeMapper = { insert: vi.fn(async () => 1) };
  const sessionService = {
    cleanupIncompleteTailAfterId: vi.fn(async () => 0),
    loadContextAnchor: vi.fn(async () => ({ lastPromptTokens: 11, contextAnchorMsgId: 4 })),
    saveMessage: vi.fn(async () => ({ id: 99 })),
    getMessages: vi.fn(async () => [
      { role: 'USER', content: 'hello' },
      { role: 'ASSISTANT', content: 'world'.repeat(80) },
    ]),
  };
  const sessionCompactionService = {
    loadValidated: vi.fn(async () => null),
    boundaryOf: vi.fn(() => 0),
  };
  const sessionHistoryLoader = {
    loadHistoryAfterBoundary: vi.fn(async () => ({
      snapshotMessageIds: [],
      normalizedEntities: [],
      persistedMessages: [],
    })),
    applyHistory: vi.fn(),
  };
  const orchestrator = { compact: vi.fn(async () => undefined) };
  const promptEngine = {
    buildRequest: vi.fn(async () => ({ messages: [{ role: 'system', content: 'sys' }], stream: true })),
  };
  const activeContext = {};
  const envInfo = {
    fromSessionOrDetect: vi.fn(async () => ({
      isGit: true, platform: 'darwin', shell: 'bash', osVersion: 'Darwin 24',
    })),
  };
  const compactionConfig = new CompactionConfig();
  compactionConfig.enabled = false;

  const deps = {
    agentLoop, toolRegistry, skillLoader, skillSync, localSkills, localAgentsMd,
    sessionMapper, agentMapper, experienceService, llmModelMapper, fileChangeMapper,
    sessionService, sessionCompactionService, sessionHistoryLoader, orchestrator,
    promptEngine, activeContext, compactionConfig, envInfo,
    ...overrides,
  };

  const service = new HarnessService(
    deps.agentLoop as unknown as AgentLoop,
    deps.toolRegistry as unknown as ToolRegistry,
    deps.skillLoader as never,
    deps.skillSync as never,
    deps.localSkills as never,
    deps.localAgentsMd as never,
    deps.sessionMapper as never,
    deps.agentMapper as never,
    deps.experienceService as never,
    deps.llmModelMapper as never,
    deps.fileChangeMapper as never,
    deps.sessionService as never,
    deps.sessionCompactionService as never,
    deps.sessionHistoryLoader as never,
    deps.orchestrator as never,
    deps.promptEngine as never,
    deps.activeContext as never,
    deps.compactionConfig,
    deps.envInfo as never,
    null,
    deps.skillSync as never,
  );
  return { service, ...deps };
}

describe('HarnessService.buildContext and execute', () => {
  it('throws when session agent or model missing', async () => {
    const missingSession = makeHarness();
    missingSession.sessionMapper.selectById.mockResolvedValue(null);
    await expect(missingSession.service.buildContext(10)).rejects.toBeInstanceOf(BusinessException);

    const missingAgent = makeHarness();
    missingAgent.agentMapper.selectById.mockResolvedValue(null);
    await expect(missingAgent.service.buildContext(10)).rejects.toBeInstanceOf(BusinessException);

    const missingModel = makeHarness();
    missingModel.llmModelMapper.selectById.mockResolvedValue(null);
    missingModel.sessionMapper.selectById.mockResolvedValue({
      id: 10, userId: 7, agentId: 2, executionMode: 'CLOUD', modelId: null,
    });
    missingModel.llmModelMapper.selectDefault.mockResolvedValue(null);
    await expect(missingModel.service.buildContext(10)).rejects.toBeInstanceOf(BusinessException);
  });

  it('buildContextLoadsCloudSessionAndFiltersWeixinTools', async () => {
    const { service, skillSync, promptEngine, toolRegistry } = makeHarness();
    const ctx = await service.buildContext(10);
    expect(ctx.sessionId).toBe(10);
    expect(ctx.agentName).toBe('Coder');
    expect(ctx.availableSkillNames).toEqual(expect.arrayContaining(['java', 'mine']));
    expect(ctx.tools.map((t) => t.getName())).not.toContain('send_wechat_image');
    expect(ctx.preparedRequest).toEqual({ messages: [{ role: 'system', content: 'sys' }], stream: true });
    expect(skillSync.syncToSession).toHaveBeenCalled();
    expect(promptEngine.buildRequest).toHaveBeenCalled();
    expect(toolRegistry.getAllTools).toHaveBeenCalled();
    expect(ctx.lastPromptTokens).toBe(11);
    expect(ctx.compactionConfig?.maxSummaryTokens).toBe(8000);
    expect(ctx.currentTimestamp).toBe(shanghaiYmd());
  });

  it('buildContextDoesNotLoadSystemSkillsWhenAgentSkillNamesNull', async () => {
    const { service, agentMapper, localSkills, localAgentsMd, sessionMapper } = makeHarness();
    agentMapper.selectById.mockResolvedValue({
      id: 2, name: 'Coder', systemPrompt: 'p', skillNames: null,
    });
    sessionMapper.selectById.mockResolvedValue({
      id: 10, userId: 7, agentId: 2, executionMode: 'LOCAL', projectKey: WEIXIN_PROJECT_KEY, modelId: 3,
    });
    localSkills.get.mockReturnValue([{ name: 'desktop-only', folderName: 'desktop-only', description: 'd' }]);
    localAgentsMd.get.mockReturnValue('# local agents');
    const ctx = await service.buildContext(10);
    expect(ctx.executionMode).toBe('LOCAL');
    expect(ctx.agentsMdContent).toBe('# local agents');
    // skillNames is null — no system skills loaded; only user skills and local unsynced skills
    expect(ctx.availableSkillNames).toEqual(expect.arrayContaining(['mine', 'desktop-only']));
    expect(ctx.availableSkillNames).not.toContain('java');
    expect(ctx.availableSkillNames).not.toContain('python');
    expect(ctx.tools.map((t) => t.getName())).not.toContain('ask_user_questions');
    expect(ctx.tools.map((t) => t.getName())).toContain('send_wechat_image');
  });

  it('buildContextToleratesInvalidSkillJsonAndCompactionJson', async () => {
    const { service, agentMapper } = makeHarness();
    agentMapper.selectById.mockResolvedValue({
      id: 2, name: 'Coder', systemPrompt: 'p', skillNames: '{not-json', configJson: '{bad',
    });
    const ctx = await service.buildContext(10);
    expect(ctx.availableSkillNames).toEqual(expect.arrayContaining(['mine']));
    expect(ctx.compactionConfig?.enabled).toBe(false);
  });

  it('executeFromEventRunsLoopAndPersistsAssistantAndToolMessages', async () => {
    const { service, agentLoop, sessionService, fileChangeMapper } = makeHarness();
    const listener = { onContentDelta: vi.fn() };
    await service.executeFromEvent(10, 'evt', listener as never);
    expect(agentLoop.execute).toHaveBeenCalled();
    const persistence = agentLoop.execute.mock.calls[0][2];
    persistence.onSaveToolMessage('call-1', 'tool-out', '{"k":1}');
    expect(sessionService.saveMessage).toHaveBeenCalledWith(
      10, 'TOOL', 'tool-out', null, 'call-1', null, 0, null, '{"k":1}',
    );
    await persistence.onSaveAssistantMessage('hi', 'think', [
      { id: 'c1', function: { name: 'write_file', arguments: '{}' } },
    ], {
      c1: JSON.stringify({
        success: true,
        file_change: { path: 'a.ts', type: 'CREATED', lines_added: 2, lines_deleted: 0 },
        file_change_diff: { diff_mode: 'SNAPSHOT', after_content: 'x' },
      }),
    }, { promptTokens: 1, completionTokens: 2, totalTokens: 3 });
    await vi.waitFor(() => expect(fileChangeMapper.insert).toHaveBeenCalled());
  });

  it('executeSideFirstMessageAppendsParentSummary', async () => {
    const { service, sessionService, agentLoop } = makeHarness();
    await service.executeSideFirstMessage(1, 10, true, { onContentDelta: vi.fn() } as never);
    expect(sessionService.getMessages).toHaveBeenCalledWith(1);
    const ctx = agentLoop.execute.mock.calls[0][0] as AgentExecutionContext;
    expect(ctx.systemPrompt).toContain('主任务背景摘要');
  });

  it('resolveModelFallsBackToDefault', async () => {
    const { service, llmModelMapper } = makeHarness();
    expect(await service.resolveModel(3)).toEqual(model());
    expect(await service.resolveModel(null)).toEqual(model());
    expect(llmModelMapper.selectDefault).toHaveBeenCalled();
  });
});
