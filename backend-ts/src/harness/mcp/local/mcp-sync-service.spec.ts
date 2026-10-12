import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpSyncService } from './mcp-sync-service.js';
import type { McpServerMapper } from '../mapper/mcp-server.mapper.js';
import type { McpServerService } from '../service/mcp-server.service.js';
import { McpToolsRegistry } from './mcp-tools-registry.js';
import type { UserMcpPreferenceService } from '../preference/service/user-mcp-preference.service.js';
import { STATUS_DISABLED, STATUS_ENABLED, TYPE_HTTP, TYPE_STDIO } from '../entity/mcp-server.js';

describe('McpSyncService', () => {
  const mapper = {
    selectById: vi.fn(),
    listMine: vi.fn().mockResolvedValue([]),
  } as unknown as McpServerMapper & Record<string, ReturnType<typeof vi.fn>>;
  const mcpServerService = {} as McpServerService;
  const toolsRegistry = new McpToolsRegistry();
  const preferenceService = {
    getDisabledServerIds: vi.fn().mockResolvedValue([]),
  } as unknown as UserMcpPreferenceService & { getDisabledServerIds: ReturnType<typeof vi.fn> };
  const service = new McpSyncService(mapper, mcpServerService, toolsRegistry, preferenceService);

  beforeEach(() => {
    vi.clearAllMocks();
    mapper.listMine.mockResolvedValue([]);
    preferenceService.getDisabledServerIds.mockResolvedValue([]);
  });

  const stdioServer = {
    id: 1, name: 'filesystem', serverType: TYPE_STDIO, command: 'npx',
    argsJson: '["-y","@modelcontextprotocol/server-filesystem","/tmp"]', status: STATUS_ENABLED,
  };
  const httpServer = {
    id: 2, name: 'github', serverType: TYPE_HTTP, url: 'https://mcp.example.com/github', status: STATUS_ENABLED,
  };

  it('parsesAgentServerIdsJsonArray', () => {
    expect(service.parseAgentServerIds({ mcpServerIds: '[1,2,3]' })).toEqual([1, 2, 3]);
  });

  it('parsesBlankOrInvalidServerIdsAsEmpty', () => {
    expect(service.parseAgentServerIds({})).toEqual([]);
    expect(service.parseAgentServerIds({ mcpServerIds: 'not-json' })).toEqual([]);
  });

  it('loadAgentServersKeepsConfiguredOrderAndSkipsMissingOrDisabled', async () => {
    mapper.selectById.mockImplementation(async (id: number) => {
      if (id === 1) return stdioServer;
      if (id === 2) return null;
      if (id === 3) return { id: 3, name: 'disabled-srv', status: STATUS_DISABLED };
      return null;
    });
    const servers = await service.loadAgentServers({ mcpServerIds: '[1,2,3]' });
    expect(servers).toHaveLength(1);
    expect(servers[0].id).toBe(1);
  });

  it('loadAgentServersReturnsEmptyWhenNoIds', async () => {
    expect(await service.loadAgentServers({})).toEqual([]);
    expect(mapper.selectById).not.toHaveBeenCalled();
  });

  it('loadAgentServersFiltersUserDisabledServers', async () => {
    mapper.selectById.mockImplementation(async (id: number) => (id === 1 ? stdioServer : httpServer));
    preferenceService.getDisabledServerIds.mockResolvedValue([2]);
    const servers = await service.loadAgentServers({ mcpServerIds: '[1,2]' }, 9);
    expect(servers).toHaveLength(1);
    expect(servers[0].id).toBe(1);
  });

  it('loadAgentServersWithoutUserIdSkipsUserFiltering', async () => {
    mapper.selectById.mockResolvedValue(stdioServer);
    preferenceService.getDisabledServerIds.mockClear();
    expect(await service.loadAgentServers({ mcpServerIds: '[1]' })).toHaveLength(1);
    expect(preferenceService.getDisabledServerIds).not.toHaveBeenCalled();
  });

  it('loadAgentServersAppendsUserOwnServersAfterGlobalOnes', async () => {
    mapper.selectById.mockResolvedValue(stdioServer);
    preferenceService.getDisabledServerIds.mockResolvedValue([]);
    mapper.listMine.mockResolvedValue([{
      id: 100, userId: 9, name: 'my-storage', serverType: TYPE_HTTP,
      url: 'https://my-mcp.example.com', status: STATUS_ENABLED,
    }]);
    const servers = await service.loadAgentServers({ mcpServerIds: '[1]' }, 9);
    expect(servers).toHaveLength(2);
    expect(servers[0].id).toBe(1);
    expect(servers[1].id).toBe(100);
  });

  it('recordReportMapsDesktopSchemaAndCoercesNullType', () => {
    service.recordReport(11, [{
      serverId: 1,
      serverName: 'baidu_map',
      toolName: 'map_geocode',
      description: 'geocode',
      schema: { type: null, properties: { address: { type: 'string' } } },
    } as never]);
    const tools = service.getLocalSessionTools(11);
    expect(tools).toHaveLength(1);
    expect(tools[0].inputSchema.type).toBe('object');
    expect(tools[0].fullToolName).toBe('mcp__baidu_map__map_geocode');
  });

  describe('connectForCloud', () => {
    const connectAndListTools = vi.fn(async () => [{
      serverId: 2, serverName: 'github', toolName: 'read', description: '', inputSchema: {}, fullToolName: 'mcp__github__read',
    }]);
    const clientManager = { connectAndListTools } as unknown as McpClientManager;
    const decryptEnv = vi.fn(() => ({ TOKEN: 'x' }));

    beforeEach(() => {
      connectAndListTools.mockClear();
      decryptEnv.mockClear();
      decryptEnv.mockReturnValue({ TOKEN: 'x' });
      (service as unknown as { mcpServerService: unknown }).mcpServerService = { decryptEnv };
    });

    it('passes the cancel flag through so a stop during connect can interrupt it', async () => {
      // buildContext 阶段点「停止」的唯一出口就在这里：不传标志会让连接挂起整次执行，
      // 执行体到不了 finally，WS handler 的 claim/future 永久残留。
      const cancelled = { get: () => false };
      await service.connectForCloud(21, [httpServer as never], clientManager, cancelled);
      expect(connectAndListTools).toHaveBeenCalledTimes(1);
      expect(connectAndListTools.mock.calls[0][3]).toBe(cancelled);
    });

    it('skips remaining servers once the session is cancelled', async () => {
      const result = await service.connectForCloud(22, [httpServer as never, stdioServer as never], clientManager, { get: () => true });
      expect(connectAndListTools).not.toHaveBeenCalled();
      expect(result.tools).toEqual([]);
      expect(result.warnings).toEqual(['github: 会话已取消']);
    });

    it('collects warnings without aborting the whole batch', async () => {
      connectAndListTools.mockRejectedValueOnce(new Error('connect refused'));
      const result = await service.connectForCloud(23, [httpServer as never], clientManager, null);
      expect(result.tools).toEqual([]);
      expect(result.warnings).toEqual(['github: connect refused']);
    });
  });

  describe('connectForCloud session snapshot (prefix cache stability)', () => {
    const githubTools = [
      { serverId: 2, serverName: 'github', toolName: 'read', description: '', inputSchema: {}, fullToolName: 'mcp__github__read' },
      { serverId: 2, serverName: 'github', toolName: 'write', description: '', inputSchema: {}, fullToolName: 'mcp__github__write' },
    ];
    const baiduTools = [
      { serverId: 3, serverName: 'baidu_map', toolName: 'geocode', description: '', inputSchema: {}, fullToolName: 'mcp__baidu_map__geocode' },
    ];
    let connectAndListTools: ReturnType<typeof vi.fn>;
    let clientManager: McpClientManager;
    const decryptEnv = vi.fn(() => ({ TOKEN: 'x' }));

    beforeEach(() => {
      connectAndListTools = vi.fn();
      clientManager = { connectAndListTools } as unknown as McpClientManager;
      decryptEnv.mockClear();
      decryptEnv.mockReturnValue({ TOKEN: 'x' });
      (service as unknown as { mcpServerService: unknown }).mcpServerService = { decryptEnv };
    });

    it('secondRoundKeepsStaleServerToolsByteIdenticalAndWarns', async () => {
      // 首轮全部成功 → 快照登记；第二轮 github 连接失败 → 沿用快照中 github 的工具，
      // tools 数组逐字节不变，且出现「当前不可用」notice（模型可见）。
      const github = { id: 2, name: 'github', serverType: TYPE_HTTP, url: 'https://mcp.example.com/github', status: STATUS_ENABLED };
      const baidu = { id: 3, name: 'baidu_map', serverType: TYPE_HTTP, url: 'https://mcp.example.com/baidu', status: STATUS_ENABLED };
      connectAndListTools.mockImplementation(async (_sid: number, server: { name?: string }) => (
        server.name === 'github' ? githubTools : baiduTools
      ));
      const first = await service.connectForCloud(31, [github as never, baidu as never], clientManager, null);
      expect(first.warnings).toEqual([]);

      connectAndListTools.mockImplementation(async (_sid: number, server: { name?: string }) => {
        if (server.name === 'github') throw new Error('connect refused');
        return baiduTools;
      });
      const second = await service.connectForCloud(31, [github as never, baidu as never], clientManager, null);
      expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
      expect(second.warnings).toEqual(['github: connect refused', 'github 当前不可用，相关工具调用可能失败']);
    });

    it('firstRoundFailureKeepsCurrentBehaviorWithoutStaleTools', async () => {
      // 无快照（会话首轮）且连接失败 → 该 server 的工具本轮不出现（维持现状）
      const github = { id: 2, name: 'github', serverType: TYPE_HTTP, url: 'https://mcp.example.com/github', status: STATUS_ENABLED };
      connectAndListTools.mockRejectedValue(new Error('connect refused'));
      const result = await service.connectForCloud(32, [github as never], clientManager, null);
      expect(result.tools).toEqual([]);
      expect(result.warnings).toEqual(['github: connect refused']);
    });

    it('snapshotSortsByServerAndToolNameSoArrivalOrderDoesNotMatter', async () => {
      const github = { id: 2, name: 'github', serverType: TYPE_HTTP, url: 'https://mcp.example.com/github', status: STATUS_ENABLED };
      const baidu = { id: 3, name: 'baidu_map', serverType: TYPE_HTTP, url: 'https://mcp.example.com/baidu', status: STATUS_ENABLED };
      connectAndListTools.mockImplementation(async (_sid: number, server: { name?: string }) => (
        server.name === 'github' ? githubTools : baiduTools
      ));
      const forward = await service.connectForCloud(33, [github as never, baidu as never], clientManager, null);
      const backward = await service.connectForCloud(34, [baidu as never, github as never], clientManager, null);
      expect(JSON.stringify(forward.tools)).toBe(JSON.stringify(backward.tools));
    });

    it('clearSessionDropsCloudSnapshotSoNextSessionReconnects', async () => {
      const github = { id: 2, name: 'github', serverType: TYPE_HTTP, url: 'https://mcp.example.com/github', status: STATUS_ENABLED };
      connectAndListTools.mockResolvedValue(githubTools);
      await service.connectForCloud(35, [github as never], clientManager, null);
      expect(service.getCloudSnapshot(35)).toHaveLength(2);
      service.clearSession(35);
      expect(service.getCloudSnapshot(35)).toEqual([]);
      // 清理后连接失败：不再沿用旧快照
      connectAndListTools.mockRejectedValue(new Error('connect refused'));
      const result = await service.connectForCloud(35, [github as never], clientManager, null);
      expect(result.tools).toEqual([]);
    });

    it('clearLocalSessionKeepsCloudSnapshotForCrossExecutionReuse', async () => {
      // 会话级存活期：执行结束只回收桌面上报的 LOCAL 工具，CLOUD 快照必须留下，
      // 否则下一轮 connectForCloud 取不到快照，「失败沿用上次成功工具集」落空。
      const github = { id: 2, name: 'github', serverType: TYPE_HTTP, url: 'https://mcp.example.com/github', status: STATUS_ENABLED };
      connectAndListTools.mockResolvedValue(githubTools);
      await service.connectForCloud(41, [github as never], clientManager, null);
      service.recordReport(41, githubTools as never);
      service.clearLocalSession(41);
      expect(service.getCloudSnapshot(41)).toHaveLength(2);
      expect(service.getLocalSessionTools(41)).toEqual([]);
    });

    it('clearCloudSnapshotDropsSnapshotButKeepsLocalSessionTools', async () => {
      // 会话删除路径两个维度一起清；单独的 clearCloudSnapshot 只清 CLOUD 快照。
      const github = { id: 2, name: 'github', serverType: TYPE_HTTP, url: 'https://mcp.example.com/github', status: STATUS_ENABLED };
      connectAndListTools.mockResolvedValue(githubTools);
      await service.connectForCloud(42, [github as never], clientManager, null);
      service.recordReport(42, githubTools as never);
      service.clearCloudSnapshot(42);
      expect(service.getCloudSnapshot(42)).toEqual([]);
      expect(service.getLocalSessionTools(42)).toHaveLength(2);
    });

    it('failedRoundAfterSuccessfulRoundReusesSnapshotAcrossExecutions', async () => {
      // B-1 回归：同一 sessionId 的两次「执行」（每次执行结束都不清快照），
      // 第二轮某 server 失败时 tools 必须与第一轮逐字节一致，并出不可用 notice。
      const github = { id: 2, name: 'github', serverType: TYPE_HTTP, url: 'https://mcp.example.com/github', status: STATUS_ENABLED };
      const baidu = { id: 3, name: 'baidu_map', serverType: TYPE_HTTP, url: 'https://mcp.example.com/baidu', status: STATUS_ENABLED };
      connectAndListTools.mockImplementation(async (_sid: number, server: { name?: string }) => (
        server.name === 'github' ? githubTools : baiduTools
      ));
      const first = await service.connectForCloud(43, [github as never, baidu as never], clientManager, null);
      // 模拟执行结束：只回收 LOCAL 工具，快照按方案 §4.5 保留
      service.clearLocalSession(43);

      connectAndListTools.mockImplementation(async (_sid: number, server: { name?: string }) => {
        if (server.name === 'github') throw new Error('connect refused');
        return baiduTools;
      });
      const second = await service.connectForCloud(43, [github as never, baidu as never], clientManager, null);
      expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
      expect(second.warnings).toContain('github 当前不可用，相关工具调用可能失败');
    });

    it('removedServerToolsDisappearOnceItStopsSucceeding', async () => {
      // 快照只增不减的边界：某 server 从配置里移除后，它不再出现在 servers 列表，
      // 也不该继续被快照带回来——快照以本轮 servers 的成功集合为准。
      const github = { id: 2, name: 'github', serverType: TYPE_HTTP, url: 'https://mcp.example.com/github', status: STATUS_ENABLED };
      const baidu = { id: 3, name: 'baidu_map', serverType: TYPE_HTTP, url: 'https://mcp.example.com/baidu', status: STATUS_ENABLED };
      connectAndListTools.mockImplementation(async (_sid: number, server: { name?: string }) => (
        server.name === 'github' ? githubTools : baiduTools
      ));
      await service.connectForCloud(36, [github as never, baidu as never], clientManager, null);
      const onlyGithub = await service.connectForCloud(36, [github as never], clientManager, null);
      expect(onlyGithub.tools.map((t) => t.serverName)).toEqual(['github', 'github']);
    });

    it('sameNameServersAreMatchedByIdSoOneFailureStillWarnsAndRestores', async () => {
      // mcp_server.name 无唯一约束：同名两个 server（一个可用一个挂了）时，
      // 按名字判成功会把挂掉的那个误判为可用——它的工具直接消失且无 notice。
      // 按主键判成功后，失败者的工具从快照补回，并出现「当前不可用」notice。
      const githubOk = { id: 2, name: 'github', serverType: TYPE_HTTP, url: 'https://mcp.example.com/github-ok', status: STATUS_ENABLED };
      const githubDown = { id: 4, name: 'github', serverType: TYPE_HTTP, url: 'https://mcp.example.com/github-down', status: STATUS_ENABLED };
      connectAndListTools.mockImplementation(async (_sid: number, server: { id?: number }) => {
        if (server.id === 2) return githubTools;
        throw new Error('connect refused');
      });
      const result = await service.connectForCloud(37, [githubOk as never, githubDown as never], clientManager, null);
      // 成功者的工具原样出现，失败者的工具由快照补回（本会话尚无快照，故本轮只出现成功者）
      expect(result.tools.map((t) => t.fullToolName)).toEqual(['mcp__github__read', 'mcp__github__write']);
      expect(result.warnings).toEqual(['github: connect refused']);

      // 下一轮失败者恢复成功：它的工具重新来自连接结果，notice 消失
      connectAndListTools.mockImplementation(async (_sid: number, server: { id?: number }) => (
        server.id === 4 ? githubTools : githubTools
      ));
      const recovered = await service.connectForCloud(37, [githubOk as never, githubDown as never], clientManager, null);
      expect(recovered.warnings).toEqual([]);
    });

    it('sameNameServerFailureFallsBackToSnapshotByServerId', async () => {
      // 同名 server 场景的快照回归：失败者（id=4）必须从快照按 serverId 补回自己的工具，
      // 而不是被「同名已成功」直接吞掉。
      const githubOk = { id: 2, name: 'github', serverType: TYPE_HTTP, url: 'https://mcp.example.com/github-ok', status: STATUS_ENABLED };
      const githubDown = { id: 4, name: 'github', serverType: TYPE_HTTP, url: 'https://mcp.example.com/github-down', status: STATUS_ENABLED };
      const okTools = [{ serverId: 2, serverName: 'github', toolName: 'read', description: '', inputSchema: {}, fullToolName: 'mcp__github__read' }];
      const downTools = [{ serverId: 4, serverName: 'github', toolName: 'deploy', description: '', inputSchema: {}, fullToolName: 'mcp__github__deploy' }];
      connectAndListTools.mockImplementation(async (_sid: number, server: { id?: number }) => (
        server.id === 2 ? okTools : downTools
      ));
      await service.connectForCloud(38, [githubOk as never, githubDown as never], clientManager, null);

      connectAndListTools.mockImplementation(async (_sid: number, server: { id?: number }) => {
        if (server.id === 2) return okTools;
        throw new Error('connect refused');
      });
      const result = await service.connectForCloud(38, [githubOk as never, githubDown as never], clientManager, null);
      expect(result.tools.map((t) => t.fullToolName)).toEqual(['mcp__github__deploy', 'mcp__github__read']);
      expect(result.warnings).toContain('github 当前不可用，相关工具调用可能失败');
    });

    it('partialFailureRoundStaysByteIdenticalToFullSuccessRound', async () => {
      // 快照拼接必须整体排序（成功集 + 补回集一起排）。若两段各自排序后拼接，
      // 有 server 失败的轮次会产出与全成功轮不同的字节序列——抖动依旧造成 miss。
      const github = { id: 2, name: 'github', serverType: TYPE_HTTP, url: 'https://mcp.example.com/github', status: STATUS_ENABLED };
      const baidu = { id: 3, name: 'baidu_map', serverType: TYPE_HTTP, url: 'https://mcp.example.com/baidu', status: STATUS_ENABLED };
      connectAndListTools.mockImplementation(async (_sid: number, server: { name?: string }) => (
        server.name === 'github' ? githubTools : baiduTools
      ));
      const full = await service.connectForCloud(39, [github as never, baidu as never], clientManager, null);

      // 第二轮 github 失败：工具集必须与全成功轮逐字节一致（baidu 在前、github 两个在后）
      connectAndListTools.mockImplementation(async (_sid: number, server: { name?: string }) => {
        if (server.name === 'github') throw new Error('connect refused');
        return baiduTools;
      });
      const degraded = await service.connectForCloud(39, [github as never, baidu as never], clientManager, null);
      expect(JSON.stringify(degraded.tools)).toBe(JSON.stringify(full.tools));
    });
  });
});
