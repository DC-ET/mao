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
});
