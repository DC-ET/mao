import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../../common/business-exception.js';
import { ErrorCode } from '../../common/error-code.js';
import { shanghaiYmd } from '../../common/json.js';
import { WEIXIN_PROJECT_KEY } from '../../domain/types.js';
import { AgentExecutionContext } from './agent-execution-context.js';
import { CompactionConfig } from './compaction-config.js';
import { HarnessService } from './harness-service.js';
import { AtomicBoolean } from '../atomic-boolean.js';
import type { Tool } from '../tool/tool.js';
import type { AgentLoop } from './agent-loop.js';
import type { ToolRegistry } from '../tool/tool-registry.js';

function fakeTool(name: string, weixin = false, feishu = false, dingtalk = false): Tool {
  return {
    getName: () => name,
    getDescription: () => name,
    getInputSchema: () => ({}),
    getOutputSchema: () => ({}),
    execute: () => '',
    ...(weixin ? { weixinChannelTool: true } : {}),
    ...(feishu ? { feishuChannelTool: true } : {}),
    ...(dingtalk ? { dingtalkChannelTool: true } : {}),
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

  it('feishuPrivateAndGroupDropAskUserQuestionsAndWeixinTools', () => {
    const withFeishu = [...tools('ask_user_questions', 'read_file'), fakeTool('feishu_send_file', false, true)];
    const privateFiltered = HarnessService.filterToolsForSession(withFeishu, 'feishu-1-private-2');
    expect(names(privateFiltered)).toEqual(expect.arrayContaining(['read_file', 'feishu_send_file']));
    expect(names(privateFiltered)).not.toContain('ask_user_questions');
    expect(names(privateFiltered)).not.toContain('send_wechat_image');

    const groupFiltered = HarnessService.filterToolsForSession(
      tools('ask_user_questions', 'read_file'),
      'oc_group',
      '/opt/mao-data/workspace/feishu-chat/3/oc_group',
    );
    expect(names(groupFiltered)).toEqual(expect.arrayContaining(['read_file']));
    expect(names(groupFiltered)).not.toContain('ask_user_questions');
    expect(names(groupFiltered)).not.toContain('send_wechat_image');
  });

  it('nonWeixinChannelKeepsAskUserQuestionsButRemovesWeixinTools', () => {
    const filtered = HarnessService.filterToolsForSession(
      [...tools('ask_user_questions', 'read_file'), fakeTool('feishu_send_file', false, true)],
      'some-project',
    );
    expect(names(filtered)).toEqual(expect.arrayContaining(['ask_user_questions', 'read_file']));
    expect(names(filtered)).not.toContain('send_wechat_image');
    expect(names(filtered)).not.toContain('feishu_send_file');
  });

  it('dingtalkSessionDropsAskUserQuestionsAndFeishuTools', () => {
    const list = [
      ...tools('ask_user_questions', 'read_file'),
      fakeTool('feishu_send_file', false, true),
      fakeTool('dingtalk_send_image', false, false, true),
    ];
    const filtered = HarnessService.filterToolsForSession(list, 'dingtalk-2-private-9', '/opt/mao-data/workspace/dingtalk-chat/2/p2p-9');
    expect(names(filtered)).toContain('dingtalk_send_image');
    expect(names(filtered)).toContain('read_file');
    expect(names(filtered)).not.toContain('ask_user_questions');
    expect(names(filtered)).not.toContain('feishu_send_file');
    expect(names(filtered)).not.toContain('send_wechat_image');
    const feishu = HarnessService.filterToolsForSession(list, 'feishu-2-private-9');
    expect(names(feishu)).toContain('feishu_send_file');
    expect(names(feishu)).not.toContain('ask_user_questions');
    expect(names(feishu)).not.toContain('dingtalk_send_image');
  });

  it('nullProjectKeyBehavesAsNonWeixinChannel', () => {
    const filtered = HarnessService.filterToolsForSession(tools('ask_user_questions'), null);
    expect(names(filtered)).toContain('ask_user_questions');
    expect(names(filtered)).not.toContain('send_wechat_image');
  });

  it('exposes page tools only for embed sessions', () => {
    const list = [fakeTool('read_file'), fakeTool('page_inspect'), fakeTool('page_click')];
    expect(names(HarnessService.filterPageTools(list, true))).toEqual(['read_file', 'page_inspect', 'page_click']);
    expect(names(HarnessService.filterPageTools(list, false))).toEqual(['read_file']);
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
  const builtinTools = [fakeTool('read_file'), fakeTool('ask_user_questions'), fakeTool('send_wechat_image', true)];
  const toolRegistry = {
    getAllTools: vi.fn(() => builtinTools),
    getTool: vi.fn((name: string) => builtinTools.find((tool) => tool.getName() === name)),
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
    clearSession: vi.fn(),
    clearLocalSession: vi.fn(),
    clearCloudSnapshot: vi.fn(),
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
    getFirstUserStamp: vi.fn(async () => null),
    getPreviousUserStamp: vi.fn(async () => null),
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
  const mcpClientManager = { closeSession: vi.fn(async () => undefined) };
  const db = null;

  const deps = {
    agentLoop, toolRegistry, skillLoader, skillSync, localSkills, localAgentsMd,
    sessionMapper, agentMapper, experienceService, llmModelMapper, fileChangeMapper,
    sessionService, sessionCompactionService, sessionHistoryLoader, orchestrator,
    promptEngine, activeContext, compactionConfig, envInfo, mcpClientManager, db,
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
    deps.db as never,
    deps.mcpClientManager as never,
    deps.skillSync as never,
    deps.embedSessionLookup ?? null,
    deps.memoryInjection ?? null,
    deps.mcpLoadModeResolver ?? null,
    deps.httpToolService ?? null,
    deps.experienceMount ?? null,
  );
  return { service, ...deps };
}

/** forkParentMessages 用的假事务：按 SQL 关键字返回行，并记录全部 insert。 */
function fakeTx(rows: {
  messages?: Array<Record<string, unknown>>;
  fileChanges?: unknown[];
  compaction?: unknown;
  events?: unknown[];
}) {
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  let nextId = 500;
  const tx = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('session_compaction_event')) return rows.events ?? [];
      if (sql.includes('message_file_change')) return rows.fileChanges ?? [];
      if (sql.includes('FROM `message`')) {
        const cut = params.length > 1 ? Number(params[1]) : null;
        return cut == null ? rows.messages ?? [] : (rows.messages ?? []).filter((m) => Number(m.id) <= cut);
      }
      return [];
    }),
    queryOne: vi.fn(async (sql: string) => {
      if (sql.includes('FROM session_compaction')) return rows.compaction ?? null;
      return null;
    }),
    insert: vi.fn(async (table: string, values: Record<string, unknown>) => {
      inserts.push({ table, values });
      return nextId++;
    }),
  };
  return { tx, inserts };
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

  it('experienceLibraryMountBackstopRunsPerBuildContextAndGatesOnModeAndSwitch', async () => {
    // buildContext 每轮幂等补挂（存量会话兜底）：CLOUD + 开关启用 → 注入路标并补挂
    const syncForSession = vi.fn();
    const { service } = makeHarness({ experienceMount: { syncForSession } });
    const ctx = await service.buildContext(10);
    expect(ctx.experienceLibrary).toEqual({ agentId: 2 });
    expect(syncForSession).toHaveBeenCalledWith('/ws', 2, true);

    // LOCAL 会话：不注入路标、不补挂（本地文件工具够不到服务器共享目录）
    syncForSession.mockClear();
    (service['sessionMapper'].selectById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 10, userId: 7, agentId: 2, executionMode: 'LOCAL',
      projectKey: 'proj', workspace: '/ws', permissionLevel: 'READ_WRITE', modelId: 3,
    });
    const localCtx = await service.buildContext(10);
    expect(localCtx.experienceLibrary).toBeNull();
    expect(syncForSession).not.toHaveBeenCalled();

    // Agent 关闭开关：即使 CLOUD 也不注入、不补挂
    (service['sessionMapper'].selectById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 10, userId: 7, agentId: 2, executionMode: 'CLOUD',
      projectKey: 'proj', workspace: '/ws', permissionLevel: 'READ_WRITE', modelId: 3,
    });
    (service['agentMapper'].selectById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 2, name: 'Coder', systemPrompt: 'You are a coder', experienceLibraryEnabled: 0,
    });
    const disabledCtx = await service.buildContext(10);
    expect(disabledCtx.experienceLibrary).toBeNull();
    expect(syncForSession).not.toHaveBeenCalled();

    // 补挂抛错不阻断上下文构建（降级记日志）
    (service['agentMapper'].selectById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 2, name: 'Coder', systemPrompt: 'You are a coder',
    });
    syncForSession.mockImplementation(() => { throw new Error('mount boom'); });
    await expect(service.buildContext(10)).resolves.toBeTruthy();
  });

  it('modelResolutionPrefersAgentDefaultForSessionsWithoutExplicitModel', async () => {
    // 会话未显式选模型：Agent 默认模型存在时优先于全局默认
    const { service } = makeHarness();
    service['llmModelMapper'].selectById.mockImplementation(async (id: number) =>
      id === 9 ? { ...model(), id: 9, name: 'agent-model' } : null,
    );
    (service['agentMapper'].selectById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 2, name: 'Coder', systemPrompt: 'You are a coder', defaultModelId: 9,
    });
    const session: Record<string, unknown> = {
      id: 10, userId: 7, agentId: 2, executionMode: 'CLOUD',
      projectKey: 'proj', workspace: '/ws', permissionLevel: 'READ_WRITE', modelId: null,
    };
    (service['sessionMapper'].selectById as ReturnType<typeof vi.fn>).mockResolvedValue(session);
    const ctx = await service.buildContext(10);
    expect(ctx.modelConfig?.id).toBe(9);

    // Agent 默认模型不可解析：回退全局默认
    service['llmModelMapper'].selectById.mockResolvedValue(null);
    const ctxFallback = await service.buildContext(10);
    expect(ctxFallback.modelConfig?.id).toBe(3);

    // 会话显式指定模型但不可解析：保持报错，不静默回退
    (session as { modelId: number | null }).modelId = 77;
    await expect(service.buildContext(10)).rejects.toMatchObject({
      code: ErrorCode.MODEL_NOT_FOUND.code,
    });
  });

  it('buildContextLoadsCloudSessionAndFiltersWeixinTools', async () => {
    const { service, skillSync, promptEngine, toolRegistry, sessionService } = makeHarness();
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
    expect(ctx.sessionBaseYmd).toBe(shanghaiYmd());
    expect(sessionService.getFirstUserStamp).toHaveBeenCalledWith(10);
  });

  it('buildContext 保留开启页面能力的 embed 会话的 page_* 工具', async () => {
    const pageTools = [fakeTool('read_file'), fakeTool('page_inspect'), fakeTool('page_click')];
    const toolRegistry = {
      getAllTools: vi.fn(() => pageTools),
      getTool: vi.fn((name: string) => pageTools.find((tool) => tool.getName() === name)),
    };
    const { service } = makeHarness({
      toolRegistry,
      embedSessionLookup: { isEmbedSession: () => true, isEmbedPageSession: () => true },
    });
    const ctx = await service.buildContext(10);
    expect(names(ctx.tools)).toEqual(['read_file', 'page_inspect', 'page_click']);
  });

  it('buildContext 过滤关闭页面能力的 embed 会话的 page_* 工具', async () => {
    const pageTools = [fakeTool('read_file'), fakeTool('page_inspect'), fakeTool('page_click')];
    const toolRegistry = {
      getAllTools: vi.fn(() => pageTools),
      getTool: vi.fn((name: string) => pageTools.find((tool) => tool.getName() === name)),
    };
    const { service } = makeHarness({
      toolRegistry,
      embedSessionLookup: { isEmbedSession: () => true, isEmbedPageSession: () => false },
    });
    const ctx = await service.buildContext(10);
    expect(names(ctx.tools)).toEqual(['read_file']);
  });

  it('buildContext 对仅提供 isEmbedSession 的存量注入按关闭收敛（fail-closed）', async () => {
    const pageTools = [fakeTool('read_file'), fakeTool('page_inspect')];
    const toolRegistry = {
      getAllTools: vi.fn(() => pageTools),
      getTool: vi.fn((name: string) => pageTools.find((tool) => tool.getName() === name)),
    };
    const { service } = makeHarness({
      toolRegistry,
      embedSessionLookup: { isEmbedSession: () => true },
    });
    const ctx = await service.buildContext(10);
    expect(names(ctx.tools)).toEqual(['read_file']);
  });

  it('buildContextInjectsWorkingSetToolsAndSectionOnlyInWorkingSetMode', async () => {
    const mcpCall = fakeTool('mcp_call');
    const mcpDescribe = fakeTool('mcp_describe');
    const builtin = [fakeTool('read_file'), mcpCall, mcpDescribe];
    const toolRegistry = {
      getAllTools: vi.fn(() => builtin),
      getTool: vi.fn((name: string) => builtin.find((tool) => tool.getName() === name)),
    };
    const refs = [{
      serverId: 5, serverName: 'fs', toolName: 'read_file', description: 'read',
      inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true },
    }];
    const mcpSync = {
      syncToSession: vi.fn(async () => undefined),
      getUserSkillNames: vi.fn(() => []),
      getUserSkillDocuments: vi.fn(() => []),
      loadAgentServers: vi.fn(async () => [{ id: 5, name: 'fs', description: '文件系统' }]),
      getLocalSessionTools: vi.fn(() => []),
      getLocalConnectionErrors: vi.fn(() => []),
      connectForCloud: vi.fn(async () => ({ tools: refs, warnings: [], failedServers: [] })),
      clearSession: vi.fn(), clearLocalSession: vi.fn(), clearCloudSnapshot: vi.fn(),
    };
    const workingSetResolver = { resolve: vi.fn(async () => 'working_set') };
    const workingSetHarness = makeHarness({
      toolRegistry, skillSync: mcpSync, mcpLoadModeResolver: workingSetResolver,
    });
    const ctx = await workingSetHarness.service.buildContext(10);
    expect(ctx.mcpWorkingSet?.servers[0].name).toBe('fs');
    expect(ctx.mcpWorkingSet?.servers[0].tools[0]).toEqual({ name: 'read_file', readOnly: true });
    expect(ctx.tools.map((tool) => tool.getName())).toEqual(expect.arrayContaining(['mcp_call', 'mcp_describe']));
    // 工作集模式不注入逐工具 adapter
    expect(ctx.tools.map((tool) => tool.getName())).not.toContain('mcp__fs__read_file');

    // 全量模式：恢复逐工具注入，两个工作集入口不出现
    const fullResolver = { resolve: vi.fn(async () => 'full') };
    const fullHarness = makeHarness({
      toolRegistry, skillSync: mcpSync, mcpLoadModeResolver: fullResolver,
    });
    const fullCtx = await fullHarness.service.buildContext(10);
    expect(fullCtx.mcpWorkingSet).toBeNull();
    expect(fullCtx.tools.map((tool) => tool.getName())).toContain('mcp__fs__read_file');
    expect(fullCtx.tools.map((tool) => tool.getName())).not.toContain('mcp_call');
  });

  it('buildContextSkipsLoadModeResolutionWhenNoMcpServerIsConfigured', async () => {
    const mcpCall = fakeTool('mcp_call');
    const builtin = [fakeTool('read_file'), mcpCall];
    const toolRegistry = {
      getAllTools: vi.fn(() => builtin),
      getTool: vi.fn((name: string) => builtin.find((tool) => tool.getName() === name)),
    };
    const mcpSync = {
      syncToSession: vi.fn(async () => undefined),
      getUserSkillNames: vi.fn(() => []),
      getUserSkillDocuments: vi.fn(() => []),
      loadAgentServers: vi.fn(async () => []),
      getLocalSessionTools: vi.fn(() => []),
      getLocalConnectionErrors: vi.fn(() => []),
      connectForCloud: vi.fn(async () => ({ tools: [], warnings: [], failedServers: [] })),
      clearSession: vi.fn(), clearLocalSession: vi.fn(), clearCloudSnapshot: vi.fn(),
    };
    const resolver = { resolve: vi.fn(async () => 'working_set') };
    const { service } = makeHarness({ toolRegistry, skillSync: mcpSync, mcpLoadModeResolver: resolver });
    const ctx = await service.buildContext(10);
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(ctx.mcpWorkingSet).toBeNull();
    expect(ctx.tools.map((tool) => tool.getName())).not.toContain('mcp_call');
  });

  it('buildContextPushesLocalMcpConnectionErrorsIntoSystemNotice', async () => {
    const mcpCall = fakeTool('mcp_call');
    const mcpDescribe = fakeTool('mcp_describe');
    const builtin = [fakeTool('read_file'), mcpCall, mcpDescribe];
    const toolRegistry = {
      getAllTools: vi.fn(() => builtin),
      getTool: vi.fn((name: string) => builtin.find((tool) => tool.getName() === name)),
    };
    const mcpSync = {
      syncToSession: vi.fn(async () => undefined),
      getUserSkillNames: vi.fn(() => []),
      getUserSkillDocuments: vi.fn(() => []),
      loadAgentServers: vi.fn(async () => [{ id: 5, name: 'fs', description: '' }]),
      getLocalSessionTools: vi.fn(() => []),
      getLocalConnectionErrors: vi.fn(() => [{ serverId: 5, serverName: 'fs', reason: '连接超时' }]),
      connectForCloud: vi.fn(async () => ({ tools: [], warnings: [], failedServers: [] })),
      clearSession: vi.fn(), clearLocalSession: vi.fn(), clearCloudSnapshot: vi.fn(),
    };
    const { service, sessionMapper } = makeHarness({
      toolRegistry, skillSync: mcpSync,
      mcpLoadModeResolver: { resolve: vi.fn(async () => 'working_set') },
    });
    sessionMapper.selectById.mockResolvedValue({
      id: 10, userId: 7, agentId: 2, executionMode: 'LOCAL',
      projectKey: 'proj', workspace: '/ws', permissionLevel: 'READ_WRITE', modelId: 3,
    });
    const ctx = await service.buildContext(10);
    expect(ctx.mcpWorkingSet?.servers[0].unavailableReason).toBe('连接超时');
    // 与 CLOUD 同口径：失败原因同时进尾部 system-notice，不只藏在工作集标题
    const noticed = ctx.messages.some((message) => typeof message.content === 'string'
      && message.content.includes('system-notice')
      && message.content.includes('连接超时'));
    expect(noticed).toBe(true);
  });

  it('buildContextAnchorsBaseDateOnFirstUserMessage', async () => {
    const { service, sessionService } = makeHarness();
    // 首条用户消息在一个过去的日期：系统提示锚点取它的日期，与服务器当天无关
    sessionService.getFirstUserStamp.mockResolvedValue({ id: 3, createdAt: '2026-08-01 09:00:00' });
    const ctx = await service.buildContext(10);
    expect(ctx.sessionBaseYmd).toBe('2026-08-01');
    expect(ctx.sessionBaseYmd).not.toBe(shanghaiYmd());
  });

  it('buildContextFallsBackToTodayWhenNoUserMessageOrQueryFails', async () => {
    const { service, sessionService } = makeHarness();
    // 无用户消息（信号 / 空会话首轮）
    sessionService.getFirstUserStamp.mockResolvedValue(null);
    expect((await service.buildContext(10)).sessionBaseYmd).toBe(shanghaiYmd());

    // 首条消息缺 created_at：长度不足 10，回落当天
    sessionService.getFirstUserStamp.mockResolvedValue({ id: 3, createdAt: '' });
    expect((await service.buildContext(10)).sessionBaseYmd).toBe(shanghaiYmd());

    // 查询抛错：不阻断会话启动，回落当天
    sessionService.getFirstUserStamp.mockRejectedValue(new Error('db down'));
    expect((await service.buildContext(10)).sessionBaseYmd).toBe(shanghaiYmd());
  });

  it('buildContextToleratesMissingFirstUserStampDependency', async () => {
    const { service, sessionService } = makeHarness();
    // 精简装配：deps 未挂 getFirstUserStamp，只锚定当天、不报错
    delete (sessionService as Record<string, unknown>).getFirstUserStamp;
    expect((await service.buildContext(10)).sessionBaseYmd).toBe(shanghaiYmd());
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

  it('buildContextMarksPayloadCompactionDoneWhenPreCompactionRequestWasOverThreshold', async () => {
    const cfg = new CompactionConfig();
    cfg.enabled = true;
    cfg.triggerPayloadBytes = 1000;
    // 真实 orchestrator 压缩成功会重建请求并覆盖 context.lastRequestBytes，
    // 测试必须模拟这一点，否则「读压缩前值」被改回旧实现也会全绿。
    const orchestrator = {
      compact: vi.fn(async (_id: number, c: AgentExecutionContext) => {
        c.lastRequestBytes = 100;
        return true;
      }),
    };
    const activeContext = { activeFromMessageSuffix: vi.fn(() => 100) };
    const sessionHistoryLoader = {
      loadHistoryAfterBoundary: vi.fn(async () => ({
        snapshotMessageIds: [],
        normalizedEntities: [],
        persistedMessages: [{ role: 'user', content: 'x' }],
      })),
      applyHistory: vi.fn(),
    };
    const promptEngine = {
      buildRequest: vi.fn(async (c: AgentExecutionContext) => {
        c.lastRequestBytes = 2000;
        return { messages: [{ role: 'system', content: 'sys' }], stream: true };
      }),
    };
    const { service } = makeHarness({
      compactionConfig: cfg, orchestrator, activeContext, sessionHistoryLoader, promptEngine,
    });

    const ctx = await service.buildContext(10);

    expect(orchestrator.compact).toHaveBeenCalledTimes(1);
    // 压缩前 2000 ≥ 阈值 1000 → 本次执行不再重复做体积压缩
    expect(ctx.payloadCompactionDone).toBe(true);
  });

  it('buildContextDoesNotMarkPayloadCompactionWhenBelowThreshold', async () => {
    const cfg = new CompactionConfig();
    cfg.enabled = true;
    cfg.triggerPayloadBytes = 3000;
    const orchestrator = {
      compact: vi.fn(async (_id: number, c: AgentExecutionContext) => {
        c.lastRequestBytes = 100;
        return true;
      }),
    };
    const activeContext = { activeFromMessageSuffix: vi.fn(() => 100) };
    const sessionHistoryLoader = {
      loadHistoryAfterBoundary: vi.fn(async () => ({
        snapshotMessageIds: [],
        normalizedEntities: [],
        persistedMessages: [{ role: 'user', content: 'x' }],
      })),
      applyHistory: vi.fn(),
    };
    const promptEngine = {
      buildRequest: vi.fn(async (c: AgentExecutionContext) => {
        c.lastRequestBytes = 500;
        return { messages: [{ role: 'system', content: 'sys' }], stream: true };
      }),
    };
    const { service } = makeHarness({
      compactionConfig: cfg, orchestrator, activeContext, sessionHistoryLoader, promptEngine,
    });

    const ctx = await service.buildContext(10);

    // token 触发（activeContext=100 / 窗口默认 256000×0.8 不会命中）→ 这里 compact 仍会被调用；
    // 但压缩前体积 500 < 3000，不能占用「体积压缩」名额。
    expect(ctx.payloadCompactionDone).toBe(false);
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

  it('buildContextForwardsCancelFlagToCloudMcpConnect', async () => {
    // buildContext 在 LLM 首轮之前连接 MCP，用户此时点「停止」的唯一出口就在这里。
    // 不传标志会让挂起的连接拖住整次执行，执行体到不了 finally，WS handler 的
    // claim/future 永久残留（线上 session 2026 即此态）。
    const { service, skillSync, agentMapper } = makeHarness();
    agentMapper.selectById.mockResolvedValue({
      id: 2, name: 'Coder', systemPrompt: 'p', skillNames: null, mcpServerIds: '[5]',
    });
    skillSync.loadAgentServers.mockResolvedValue([
      { id: 5, name: 'baidu_map', serverType: 'HTTP', url: 'https://mcp.example.com' },
    ]);
    const cancelled = new AtomicBoolean(false);
    await service.buildContext(10, null, cancelled);
    expect(skillSync.connectForCloud).toHaveBeenCalledTimes(1);
    expect(skillSync.connectForCloud.mock.calls[0][3]).toBe(cancelled);
  });

  it('buildContextSkipsMemoryInjectionWhenSessionDisabled', async () => {
    // 技术方案 5.1：memory_injection_disabled=1 时短路，memories=null，且不查询记忆库。
    const listForInjection = vi.fn(async () => [{ content: 'should not appear' }]);
    const { service } = makeHarness({
      memoryInjection: { listForInjection },
      sessionMapper: {
        selectById: vi.fn(async () => ({
          id: 10, userId: 7, agentId: 2, executionMode: 'CLOUD',
          projectKey: 'proj', workspace: '/ws', permissionLevel: 'READ_WRITE',
          modelId: 3, memoryInjectionDisabled: 1,
        })),
      },
    });
    const ctx = await service.buildContext(10);
    expect(ctx.memories).toBeNull();
    expect(listForInjection).not.toHaveBeenCalled();
  });

  it('buildContextLoadsMemoryInjectionWhenEnabled', async () => {
    const memories = [{ content: '长期记忆' }];
    const listForInjection = vi.fn(async () => memories);
    const { service } = makeHarness({ memoryInjection: { listForInjection } });
    const ctx = await service.buildContext(10);
    expect(ctx.memories).toBe(memories);
    expect(listForInjection).toHaveBeenCalledWith(7, 'proj', '/ws');
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
    await service.executeSideFirstMessage(1, 10, 'summary', { onContentDelta: vi.fn() } as never);
    expect(sessionService.getMessages).toHaveBeenCalledWith(1);
    const ctx = agentLoop.execute.mock.calls[0][0] as AgentExecutionContext;
    expect(ctx.systemPrompt).toContain('主任务背景摘要');
  });

  it('executeSideFirstMessageNoneDoesNotInject', async () => {
    const { service, sessionService, agentLoop } = makeHarness();
    await service.executeSideFirstMessage(1, 10, 'none', { onContentDelta: vi.fn() } as never);
    expect(sessionService.getMessages).not.toHaveBeenCalled();
    const ctx = agentLoop.execute.mock.calls[0][0] as AgentExecutionContext;
    expect(ctx.systemPrompt).not.toContain('主任务背景摘要');
  });

  it('resolveModelFallsBackToDefault', async () => {
    const { service, llmModelMapper } = makeHarness();
    expect(await service.resolveModel(3)).toEqual(model());
    expect(await service.resolveModel(null)).toEqual(model());
    expect(llmModelMapper.selectDefault).toHaveBeenCalled();
  });
});

describe('HarnessService CLOUD MCP 快照存活期', () => {
  // CLOUD 快照的存活期是「会话级」而非「执行级」（技术方案 §4.5 第 3 点）：
  // connectForCloud 每次执行只在 buildContext 调用一次，「某 server 连接失败时
  // 沿用上次成功的工具集」必须跨执行才成立。若在每次执行结束清快照，下一轮
  // getCloudSnapshot 恒为空，沿用语义在主路径上落空、tools 数组仍随连接抖动变化。
  // 因此三个执行出口都不得清理快照；清理只在会话删除路径（SessionService.onSessionDeleted）发生。
  it('executeKeepsCloudMcpSnapshotSoNextRoundCanReuseIt', async () => {
    const { service, skillSync } = makeHarness();
    await service.execute(10, 'hi', { onContentDelta: vi.fn() } as never);
    expect(skillSync.clearSession).not.toHaveBeenCalled();
    expect(skillSync.clearCloudSnapshot).not.toHaveBeenCalled();
  });

  it('executeKeepsCloudMcpSnapshotEvenWhenLoopThrows', async () => {
    const agentLoop = {
      execute: vi.fn(async () => { throw new Error('loop boom'); }),
      removeCancelFlag: vi.fn(),
    };
    const { service, skillSync } = makeHarness({ agentLoop });
    await expect(service.execute(10, 'hi', { onContentDelta: vi.fn() } as never)).rejects.toThrow('loop boom');
    expect(skillSync.clearSession).not.toHaveBeenCalled();
  });

  it('executePreparedKeepsCloudMcpSnapshot', async () => {
    const { service, skillSync } = makeHarness();
    const context = new AgentExecutionContext();
    context.sessionId = 42;
    await service.executePrepared(context, { onContentDelta: vi.fn() } as never);
    expect(skillSync.clearSession).not.toHaveBeenCalled();
    expect(skillSync.clearCloudSnapshot).not.toHaveBeenCalled();
  });

  it('executeSideFirstMessageKeepsCloudMcpSnapshot', async () => {
    const { service, skillSync } = makeHarness();
    await service.executeSideFirstMessage(1, 10, 'none', { onContentDelta: vi.fn() } as never);
    expect(skillSync.clearSession).not.toHaveBeenCalled();
    expect(skillSync.clearCloudSnapshot).not.toHaveBeenCalled();
  });
});

describe('HarnessService.requestCompaction', () => {
  it('空闲手动压缩：跳过自动压缩、force 越过阈值与 enabled 门、triggerMode=manual、收尾回收云 MCP', async () => {
    const orchestrator = { compact: vi.fn(async () => true) };
    const activeContext = { activeFromMessageSuffix: vi.fn(() => 5000) };
    const mcpClientManager = { closeSession: vi.fn(async () => undefined) };
    const { service } = makeHarness({ orchestrator, activeContext, mcpClientManager });

    const result = await service.requestCompaction(10, null);

    // 仅一次压缩：buildContext 的自动块被 skipAutoCompact 跳过，只有手动这一次。
    expect(orchestrator.compact).toHaveBeenCalledTimes(1);
    const args = orchestrator.compact.mock.calls[0] as unknown as unknown[];
    expect(args[0]).toBe(10);                 // sessionId
    expect(args[5]).toBe(false);              // compactCurrentTurn=false（空闲路径）
    expect(args[8]).toBe('manual');           // triggerMode
    expect(args[9]).toBe(true);               // force
    // activeTokensHint 取 lastPromptTokens(11) 与估算(5000) 的较大值
    expect(args[7]).toBe(5000);
    expect(result).toBe(true);
    // 成功路径同样回收云 MCP，避免连接泄漏
    expect(mcpClientManager.closeSession).toHaveBeenCalledWith(10);
  });

  it('requestCompaction 失败时也回收云 MCP 并向上传播异常', async () => {
    const orchestrator = { compact: vi.fn(async () => { throw new Error('LLM compaction failed'); }) };
    const activeContext = { activeFromMessageSuffix: vi.fn(() => 100) };
    const mcpClientManager = { closeSession: vi.fn(async () => undefined) };
    const { service } = makeHarness({ orchestrator, activeContext, mcpClientManager });

    await expect(service.requestCompaction(10, null)).rejects.toThrow('LLM compaction failed');
    expect(mcpClientManager.closeSession).toHaveBeenCalledWith(10);
  });
});

describe('HarnessService.forkParentMessages', () => {
  function messagesWith(ids: number[]) {
    return ids.map((id) => ({ id, sessionId: 1, role: id % 2 === 0 ? 'ASSISTANT' : 'USER', content: `m${id}` }));
  }

  it('copiesEverythingWhenNoCutPoint', async () => {
    const { tx, inserts } = fakeTx({
      messages: messagesWith([1, 2, 3, 4]),
      fileChanges: [{ id: 1, messageId: 2, sessionId: 1, path: 'a.ts', type: 'CREATED' }],
      compaction: { id: 1, sessionId: 1, summaryText: 'sum', lastCompactedMsgId: 2, compactCount: 1 },
      events: [
        { id: 1, sessionId: 1, prevBoundaryMsgId: 0, boundaryMsgId: 2, compactedMessageCount: 2 },
      ],
    });
    const { service } = makeHarness({ db: { transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) } });
    await service.forkParentMessages(1, 10, null);

    expect(tx.query.mock.calls[0][0]).not.toContain('id <= ?');
    expect(inserts.filter((i) => i.table === 'message')).toHaveLength(4);
    expect(inserts.filter((i) => i.table === 'message').every((i) => i.values.sourceSessionId === 1)).toBe(true);
    expect(inserts.filter((i) => i.table === 'message_file_change')).toHaveLength(1);
    // file_change 的 messageId 被重映射到新 ID
    expect(inserts.find((i) => i.table === 'message_file_change')!.values.messageId).not.toBe(2);
    const compaction = inserts.find((i) => i.table === 'session_compaction')!;
    expect(compaction.values.sessionId).toBe(10);
    expect(compaction.values.lastCompactedMsgId).not.toBe(2);
    const event = inserts.find((i) => i.table === 'session_compaction_event')!;
    expect(event.values.sessionId).toBe(10);
    expect(event.values.boundaryMsgId).not.toBe(2);
    expect(event.values.prevBoundaryMsgId).toBe(0);
  });

  it('truncatesAndRemapsCompactionWhenCutPastBoundary', async () => {
    const { tx, inserts } = fakeTx({
      messages: messagesWith([1, 2, 3, 4, 5]),
      compaction: { id: 1, sessionId: 1, summaryText: 'sum', lastCompactedMsgId: 2, compactCount: 3 },
      events: [
        { id: 1, sessionId: 1, prevBoundaryMsgId: 0, boundaryMsgId: 2, compactedMessageCount: 2 },
        { id: 2, sessionId: 1, prevBoundaryMsgId: 2, boundaryMsgId: 4, compactedMessageCount: 2 },
        { id: 3, sessionId: 1, prevBoundaryMsgId: 4, boundaryMsgId: 5, compactedMessageCount: 1 },
      ],
    });
    const { service } = makeHarness({ db: { transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) } });
    await service.forkParentMessages(1, 10, 4);

    expect(tx.query.mock.calls[0][0]).toContain('id <= ?');
    expect(tx.query.mock.calls[0][1]).toEqual([1, 4]);
    expect(inserts.filter((i) => i.table === 'message')).toHaveLength(4);
    expect(inserts.filter((i) => i.table === 'message').map((i) => i.values.content)).toEqual(['m1', 'm2', 'm3', 'm4']);
    // 压缩记录仍在（边界 2 被复制过来了）；事件只保留 boundary <= 切点 的行，5 被跳过
    expect(inserts.filter((i) => i.table === 'session_compaction')).toHaveLength(1);
    const events = inserts.filter((i) => i.table === 'session_compaction_event');
    expect(events).toHaveLength(2);
    expect(events[0].values.boundaryMsgId).not.toBe(2);
    expect(events[1].values.prevBoundaryMsgId).toBe(events[0].values.boundaryMsgId);
  });

  it('skipsCompactionWhenCutBeforeBoundary', async () => {
    const { tx, inserts } = fakeTx({
      messages: messagesWith([1, 2, 3, 4, 5]),
      compaction: { id: 1, sessionId: 1, summaryText: 'sum', lastCompactedMsgId: 3, compactCount: 2 },
      events: [
        { id: 1, sessionId: 1, prevBoundaryMsgId: 0, boundaryMsgId: 3, compactedMessageCount: 3 },
      ],
    });
    const { service } = makeHarness({ db: { transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) } });
    await service.forkParentMessages(1, 10, 2);

    expect(inserts.filter((i) => i.table === 'message')).toHaveLength(2);
    expect(inserts.filter((i) => i.table === 'session_compaction')).toHaveLength(0);
    expect(inserts.filter((i) => i.table === 'session_compaction_event')).toHaveLength(0);
  });

  it('keepsRawHistoryWhenNoCompactionRecord', async () => {
    const { tx, inserts } = fakeTx({ messages: messagesWith([1, 2]) });
    const { service } = makeHarness({ db: { transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) } });
    await service.forkParentMessages(1, 10, null);
    expect(inserts.filter((i) => i.table === 'message')).toHaveLength(2);
    expect(inserts.filter((i) => i.table === 'session_compaction')).toHaveLength(0);
  });
});

describe('HarnessService 自定义 HTTP 工具装配（技术方案 2026-10-19 §5.4）', () => {
  /** 带两个入口工具的 registry（默认工具集含入口，装配层负责剔除/推入）。 */
  function httpRegistry() {
    const builtin = [fakeTool('read_file'), fakeTool('http_describe'), fakeTool('http_call')];
    return {
      getAllTools: vi.fn(() => builtin),
      getTool: vi.fn((name: string) => builtin.find((tool) => tool.getName() === name)),
    };
  }

  function httpTool(overrides: Record<string, unknown> = {}) {
    return {
      id: 1, name: 'weather', displayName: '天气查询', description: '查询城市天气',
      method: 'GET', url: 'https://api.example.com/v1/weather', headersJson: null, bodyTemplate: null,
      readOnly: 1, timeoutMs: 15000, enabled: 1, ...overrides,
    };
  }

  it('默认工具集中剔除两个入口工具（无启用工具时任何会话都看不到）', async () => {
    const { service } = makeHarness({
      toolRegistry: httpRegistry(),
      httpToolService: { listEnabledForAgent: vi.fn(async () => []) },
    });
    const ctx = await service.buildContext(10);
    expect(ctx.tools.map((tool) => tool.getName())).not.toContain('http_describe');
    expect(ctx.tools.map((tool) => tool.getName())).not.toContain('http_call');
    expect(ctx.customHttpTools).toBeNull();
  });

  it('agent 无关联时零查库、零注入', async () => {
    // 真实 HttpToolService.listEnabledForAgent 对 httpToolIds 为空直接返回 []（零查库），这里同口径打桩
    const listEnabledForAgent = vi.fn(async (agent: { httpToolIds?: string | null }) => (agent?.httpToolIds ? [httpTool()] : []));
    const { service } = makeHarness({
      toolRegistry: httpRegistry(),
      httpToolService: { listEnabledForAgent },
    });
    const ctx = await service.buildContext(10);
    expect(listEnabledForAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
    expect(ctx.tools.map((tool) => tool.getName())).not.toContain('http_call');
    expect(ctx.customHttpTools).toBeNull();
  });

  it('agent 关联工具时推入两个入口并生成目录分节数据', async () => {
    const { service } = makeHarness({
      toolRegistry: httpRegistry(),
      httpToolService: { listEnabledForAgent: vi.fn(async () => [httpTool()]) },
    });
    const ctx = await service.buildContext(10);
    expect(ctx.tools.map((tool) => tool.getName())).toEqual(expect.arrayContaining(['http_describe', 'http_call']));
    expect(ctx.customHttpTools?.tools).toHaveLength(1);
    expect(ctx.customHttpTools?.tools[0]).toEqual({
      name: 'weather', displayName: '天气查询', method: 'GET', readOnly: true, description: '查询城市天气',
    });
  });

  it('按 agent.httpToolIds 关联装配（无上限截断）', async () => {
    const tools = [
      httpTool({ id: 1, name: 'alerts' }),
      httpTool({ id: 2, name: 'weather' }),
      httpTool({ id: 3, name: 'orders' }),
    ];
    const listEnabledForAgent = vi.fn(async () => tools);
    const { service } = makeHarness({
      toolRegistry: httpRegistry(),
      httpToolService: { listEnabledForAgent },
    });
    (service['agentMapper'].selectById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 2, name: 'Coder', systemPrompt: 'You are a coder', skillNames: '["java"]',
      httpToolIds: JSON.stringify([1, 2, 3]),
      configJson: JSON.stringify({ compaction: { enabled: true, maxSummaryTokens: 8000 } }),
    });
    const ctx = await service.buildContext(10);
    expect(listEnabledForAgent).toHaveBeenCalledWith(expect.objectContaining({ httpToolIds: JSON.stringify([1, 2, 3]) }));
    expect(ctx.customHttpTools?.tools.map((tool) => tool.name)).toEqual(['alerts', 'orders', 'weather']);
  });

  it('未注入 httpToolService 时（精简装配）维持改造前行为', async () => {
    const { service } = makeHarness({ toolRegistry: httpRegistry() });
    const ctx = await service.buildContext(10);
    expect(ctx.tools.map((tool) => tool.getName())).not.toContain('http_call');
    expect(ctx.customHttpTools).toBeNull();
  });

  it('装配失败不阻断会话启动（本轮不注入自定义工具）', async () => {
    const { service } = makeHarness({
      toolRegistry: httpRegistry(),
      httpToolService: {
        listEnabledForAgent: vi.fn(async () => { throw new Error('db down'); }),
      },
    });
    const ctx = await service.buildContext(10);
    expect(ctx.tools.map((tool) => tool.getName())).not.toContain('http_call');
    expect(ctx.customHttpTools).toBeNull();
  });

  it('入口工具未注册时跳过装配（精简 registry）', async () => {
    const { service } = makeHarness({
      httpToolService: { listEnabledForAgent: vi.fn(async () => [httpTool()]) },
    });
    const ctx = await service.buildContext(10);
    expect(ctx.customHttpTools).toBeNull();
  });
});
