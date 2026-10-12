import { describe, expect, it, vi } from 'vitest';
import { HarnessService } from '../../core/harness-service.js';
import { McpSyncService } from './mcp-sync-service.js';
import { McpToolsRegistry } from './mcp-tools-registry.js';
import { AgentExecutionContext } from '../../core/agent-execution-context.js';
import { AtomicBoolean } from '../../atomic-boolean.js';
import { CompactionConfig } from '../../core/compaction-config.js';

// B-1 修复验证：CLOUD MCP 快照必须跨执行存活。
// 同一 sessionId 连续两次执行，第二次 github 连接失败时 tools 应与第一次逐字节一致。
describe('B-1 CLOUD MCP snapshot survives across executions', () => {
  const githubTools = [
    { serverId: 2, serverName: 'github', toolName: 'read', description: '', inputSchema: {}, fullToolName: 'mcp__github__read' },
    { serverId: 2, serverName: 'github', toolName: 'write', description: '', inputSchema: {}, fullToolName: 'mcp__github__write' },
  ];
  const baiduTools = [
    { serverId: 3, serverName: 'baidu_map', toolName: 'geocode', description: '', inputSchema: {}, fullToolName: 'mcp__baidu_map__geocode' },
  ];

  function makeHarness(connectImpl: (sid: number, server: { name?: string }) => Promise<never[]>) {
    const registry = new McpToolsRegistry();
    const mapper = { selectById: vi.fn(), listMine: vi.fn(async () => []) } as never;
    const mcpServerService = { decryptEnv: vi.fn(() => ({})) } as never;
    const mcpSync = new McpSyncService(mapper, mcpServerService, registry, {
      getDisabledServerIds: vi.fn(async () => []),
    } as never);
    const connectAndListTools = vi.fn(async (sid: number, server: never, _env: unknown, _flag: unknown) =>
      connectImpl(sid, server as { name?: string }),
    );
    const clientManager = { connectAndListTools } as never;
    const sessionMapper = {
      selectById: vi.fn(async () => ({
        id: 10, userId: 7, agentId: 2, executionMode: 'CLOUD', projectKey: 'proj', workspace: '/ws', modelId: 3,
      })),
    } as never;
    const agentMapper = {
      selectById: vi.fn(async () => ({ id: 2, name: 'Coder', systemPrompt: 'sys', skillNames: '[]' })),
    } as never;
    const toolRegistry = { getAllTools: vi.fn(() => []) } as never;
    const service = new HarnessService(
      { execute: vi.fn(async () => undefined), removeCancelFlag: vi.fn() } as never,
      toolRegistry,
      { hasSkill: vi.fn(() => false), getAllNames: vi.fn(() => []), getAllDocuments: vi.fn(() => []) } as never,
      { syncToSession: vi.fn(async () => undefined), getUserSkillNames: vi.fn(() => []), getUserSkillDocuments: vi.fn(() => []) } as never,
      { get: vi.fn(() => []) } as never,
      { get: vi.fn(() => null) } as never,
      sessionMapper,
      agentMapper,
      { listEnabledContents: vi.fn(async () => []) } as never,
      {
        selectById: vi.fn(async () => ({ id: 3, name: 'gpt', apiProtocol: 'openai' })),
        selectDefault: vi.fn(async () => ({ id: 3, name: 'gpt', apiProtocol: 'openai' })),
      } as never,
      { insert: vi.fn() } as never,
      {
        cleanupIncompleteTailAfterId: vi.fn(async () => 0),
        loadContextAnchor: vi.fn(async () => ({ lastPromptTokens: 0, contextAnchorMsgId: 0 })),
        saveMessage: vi.fn(async () => ({ id: 1 })),
        getMessages: vi.fn(async () => []),
      } as never,
      { loadValidated: vi.fn(async () => null), boundaryOf: vi.fn(() => 0) } as never,
      { loadHistoryAfterBoundary: vi.fn(async () => ({ persistedMessages: [] })), applyHistory: vi.fn() } as never,
      { compact: vi.fn(async () => undefined) } as never,
      { buildRequest: vi.fn(async () => ({ messages: [], stream: true })) } as never,
      {} as never,
      Object.assign(new CompactionConfig(), { enabled: false }),
      { fromSessionOrDetect: vi.fn(async () => ({ isGit: false, platform: 'linux', shell: 'bash', osVersion: 'x' })) } as never,
      null,
      clientManager,
      mcpSync,
      null,
      null,
    );
    return { service, mcpSync, connectAndListTools };
  }

  const github = { id: 2, name: 'github', serverType: 'http', url: 'https://x/github', status: 1 };
  const baidu = { id: 3, name: 'baidu_map', serverType: 'http', url: 'https://x/baidu', status: 1 };

  it('second execution reuses snapshot tools when a server fails to connect', async () => {
    let failGithub = false;
    const { service, connectAndListTools } = makeHarness(async (_sid, server) => {
      if (server.name === 'github' && failGithub) throw new Error('connect refused');
      return (server.name === 'github' ? githubTools : baiduTools) as never;
    });
    const servers = [github, baidu] as never[];
    vi.spyOn(
      (service as unknown as { mcpSyncService: McpSyncService }).mcpSyncService,
      'loadAgentServers',
    ).mockResolvedValue(servers);

    const first = await service.buildContext(10, null, new AtomicBoolean(false));
    const firstNames = (first.tools ?? []).map((t) => t.getName());
    expect(firstNames).toEqual([
      'mcp__baidu_map__geocode', 'mcp__github__read', 'mcp__github__write',
    ]);

    // 第一次执行完整结束（含 WS 侧资源回收语义：只清 LOCAL，不清 CLOUD 快照）
    await service.execute(10, 'hi', { onContentDelta: vi.fn() } as never);
    failGithub = true;

    const second = await service.buildContext(10, null, new AtomicBoolean(false));
    const secondNames = (second.tools ?? []).map((t) => t.getName());
    expect(secondNames).toEqual(firstNames);
    // 模型应看到「该 server 当前不可用」的提示（通过 system notice 注入）
    expect(JSON.stringify(second.messages)).toContain('当前不可用');
    // buildContext(第1次) 2 个 + execute 内 buildContext 2 个 + buildContext(第2次) 2 个
    expect(connectAndListTools).toHaveBeenCalledTimes(6);
  });

  it('snapshot survives a thrown execution', async () => {
    let failGithub = false;
    const harness = makeHarness(async (_sid, server) => {
      if (server.name === 'github' && failGithub) throw new Error('connect refused');
      return (server.name === 'github' ? githubTools : baiduTools) as never;
    });
    vi.spyOn(
      (harness.service as unknown as { mcpSyncService: McpSyncService }).mcpSyncService,
      'loadAgentServers',
    ).mockResolvedValue([github, baidu] as never[]);
    const first = await harness.service.buildContext(10, null, new AtomicBoolean(false));
    const firstNames = (first.tools ?? []).map((t) => t.getName());

    // 执行体抛错：快照同样不得被清掉
    const agentLoop = {
      execute: vi.fn(async () => { throw new Error('loop boom'); }),
      removeCancelFlag: vi.fn(),
    };
    (harness.service as unknown as { agentLoop: unknown }).agentLoop = agentLoop;
    await expect(
      harness.service.execute(10, 'hi', { onContentDelta: vi.fn() } as never),
    ).rejects.toThrow('loop boom');

    failGithub = true;
    const second = await harness.service.buildContext(10, null, new AtomicBoolean(false));
    expect((second.tools ?? []).map((t) => t.getName())).toEqual(firstNames);
  });
});
