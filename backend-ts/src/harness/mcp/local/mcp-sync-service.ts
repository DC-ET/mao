import { harnessLog } from '../../log.js';
import type { Agent } from '../../deps.js';
import { STATUS_ENABLED, TYPE_STDIO, fullToolName, normalizeMcpInputSchema, type McpServer, type McpToolRef } from '../entity/mcp-server.js';
import type { McpServerMapper } from '../mapper/mcp-server.mapper.js';
import type { McpServerService } from '../service/mcp-server.service.js';
import type { UserMcpPreferenceService } from '../preference/service/user-mcp-preference.service.js';
import type { McpClientManager } from '../mcp-client-manager.js';
import { McpToolsRegistry } from './mcp-tools-registry.js';

export interface CloudConnectResult {
  tools: McpToolRef[];
  warnings: string[];
}

export class McpSyncService {
  private readonly nameToId = new Map<string, number>();

  constructor(
    private readonly mcpServerMapper: McpServerMapper,
    private readonly mcpServerService: McpServerService,
    private readonly toolsRegistry: McpToolsRegistry,
    private readonly userMcpPreferenceService: UserMcpPreferenceService,
  ) {}

  parseAgentServerIds(agent: Agent | null): number[] {
    if (!agent?.mcpServerIds || agent.mcpServerIds.trim() === '') return [];
    try {
      const ids = JSON.parse(agent.mcpServerIds) as number[];
      return Array.isArray(ids) ? ids : [];
    } catch (e) {
      harnessLog('warn', `Failed to parse mcpServerIds for agent ${agent.id}: ${(e as Error).message}`);
      return [];
    }
  }

  async loadAgentServers(agent: Agent, userId?: number | null): Promise<McpServer[]> {
    const ids = this.parseAgentServerIds(agent);
    const disabledByUser = userId != null ? await this.userMcpPreferenceService.getDisabledServerIds(userId) : [];
    const disabled = new Set(disabledByUser);
    const result: McpServer[] = [];
    const seen = new Set<number>();
    for (const id of ids) {
      const server = await this.mcpServerMapper.selectById(id);
      if (!server || server.status !== STATUS_ENABLED) continue;
      if (disabled.has(id)) continue;
      result.push(server);
      seen.add(id);
      if (server.id != null && server.name) this.nameToId.set(server.name, server.id);
    }
    if (userId != null) {
      const mine = await this.mcpServerMapper.listMine(userId);
      for (const server of mine) {
        if (server.status !== STATUS_ENABLED || seen.has(server.id!) || disabled.has(server.id!)) continue;
        result.push(server);
        if (server.id != null && server.name) this.nameToId.set(server.name, server.id);
      }
    }
    return result;
  }

  getLocalSessionTools(sessionId: number): McpToolRef[] {
    return this.toolsRegistry.getSessionTools(sessionId);
  }

  async connectForCloud(
    sessionId: number, servers: McpServer[], clientManager: McpClientManager,
  ): Promise<CloudConnectResult> {
    const tools: McpToolRef[] = [];
    const warnings: string[] = [];
    for (const server of servers) {
      try {
        const env = this.mcpServerService.decryptEnv(server);
        const listed = await clientManager.connectAndListTools(sessionId, server, env);
        tools.push(...listed);
      } catch (e) {
        warnings.push(`${server.name}: ${(e as Error).message}`);
        harnessLog('warn', `MCP connect failed for ${server.name}: ${(e as Error).message}`);
      }
    }
    return { tools, warnings };
  }

  buildSyncPayload(servers: McpServer[]): Record<string, unknown> {
    const payloadServers: Array<Record<string, unknown>> = [];
    for (const server of servers) {
      const item: Record<string, unknown> = {
        name: server.name,
        type: server.serverType,
      };
      if (server.serverType === TYPE_STDIO) {
        item.command = server.command;
        item.args = this.parseArgs(server.argsJson);
      } else {
        item.url = server.url;
      }
      item.env = this.mcpServerService.decryptEnv(server);
      payloadServers.push(item);
    }
    return { servers: payloadServers };
  }

  recordReport(sessionId: number, tools: McpToolRef[]): void {
    this.toolsRegistry.report(sessionId, tools.map((tool) => ({
      ...tool,
      serverId: tool.serverId ?? 0,
      inputSchema: normalizeMcpInputSchema(
        tool.inputSchema ?? (tool as { schema?: unknown }).schema,
      ),
      fullToolName: tool.fullToolName ?? fullToolName(tool.serverName, tool.toolName),
    })));
  }

  resolveServerIdByName(name: string): number | null {
    if (!name || name.trim() === '') return null;
    return this.nameToId.get(name) ?? null;
  }

  clearSession(sessionId: number): void {
    this.toolsRegistry.clear(sessionId);
  }

  private parseArgs(argsJson: string | null | undefined): string[] {
    if (!argsJson || argsJson.trim() === '') return [];
    try {
      const args = JSON.parse(argsJson) as unknown;
      return Array.isArray(args) ? args.map((a) => String(a)) : [];
    } catch (e) {
      harnessLog('warn', `Failed to parse MCP server args: ${(e as Error).message}`);
      return [];
    }
  }
}
