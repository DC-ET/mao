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

  it('buildContextLoadsCloudSessionAndFiltersWeixinTools', async () => {    const { service, skillSync, promptEngine, toolRegistry } = makeHarness();
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
