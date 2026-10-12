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

  /** CLOUD 会话快照（测试与排查用）：最近一次成功连接登记的工具集。 */
  getCloudSnapshot(sessionId: number): McpToolRef[] {
    return this.toolsRegistry.getCloudSnapshot(sessionId);
  }

  /**
   * CLOUD 工具集会话快照（技术方案 2026-10-12 §4.5，与 LOCAL 的 McpToolsRegistry 语义对齐）：
   * - 连接成功 → 按 (serverName, toolName) 排序后更新快照，保证跨轮字节一致；
   * - 某 server 连接失败 → 沿用上次成功快照中该 server 的工具（快照只增不减），
   *   同时经 warnings 通道由 harness-service 转成尾部 <system-notice>；
   * - 无快照（会话首轮）且连接失败 → 维持现状（该 server 的工具本轮不出现）。
   *
   * 取舍：可能断言了实际连不上的工具。缓解是 notice 明确告知 + 工具调用返回自身错误，
   * 验收口径是「宁可工具调用报错，不可让整轮缓存失效」——tools 位于缓存层级最前，
   * 抖动代价是该轮 + 恢复轮双 miss。
   */
  async connectForCloud(
    sessionId: number, servers: McpServer[], clientManager: McpClientManager,
    cancelFlag?: { get(): boolean } | null,
  ): Promise<CloudConnectResult> {
    const tools: McpToolRef[] = [];
    const warnings: string[] = [];
    // 成功集合按 server 主键记录：mcp_server.name 无唯一约束（后台允许重名），
    // 按名字匹配会把「同名但挂了的那一个」误判为成功，导致它的工具本轮直接消失、
    // 也没有不可用 notice——tools 抖动正是本方案要消除的东西。
    const succeeded = new Set<number>();
    const succeededByName = new Set<string>();
    for (const server of servers) {
      // 取消（用户点停止）必须打断连接：buildContext 阶段没有任何别的取消出口，
      // 否则执行体到不了 finally，WS handler 的执行簿记永久残留。
      if (cancelFlag?.get()) {
        warnings.push(`${server.name}: 会话已取消`);
        break;
      }
      try {
        const env = this.mcpServerService.decryptEnv(server);
        const listed = await clientManager.connectAndListTools(sessionId, server, env, cancelFlag);
        tools.push(...listed);
        if (server.id != null) succeeded.add(server.id);
        if (server.name != null) succeededByName.add(server.name);
      } catch (e) {
        warnings.push(`${server.name}: ${(e as Error).message}`);
        harnessLog('warn', `MCP connect failed for ${server.name}: ${(e as Error).message}`);
      }
    }
    // 本轮成功的 server 重新排序入库；失败的 server 沿用上次快照中的工具，使 tools 数组稳定。
    // 快照只保留本轮 servers 列表里的 server：配置中已移除的 server 不再被带回。
    // 合并后必须整体排序：只把「本轮成功」与「快照补回」各自排序再拼接，会在有 server
    // 失败时产出与全成功轮不同的字节序列——那正是本轮方案要消除的 miss。
    const previous = this.toolsRegistry.getCloudSnapshot(sessionId);
    const configured = new Set(servers.filter((s) => s.id != null).map((s) => s.id!));
    // 旧快照的 ref.serverId 与本轮 server.id 对应；serverId 缺失（0）时退化为按名字比较，
    // 保证只有单 server 的老数据不会整块被当成 stale 丢掉。
    const staleRefs = previous.filter((ref) => {
      if (succeeded.has(ref.serverId)) return false;
      if (ref.serverId === 0) return !succeededByName.has(ref.serverName);
      return configured.has(ref.serverId);
    });
    const snapshot = sortMcpToolRefs([...tools, ...staleRefs]);
    this.toolsRegistry.reportCloudSnapshot(sessionId, snapshot);
    const staleServers = [...new Set(staleRefs.map((ref) => ref.serverName))];
    for (const serverName of staleServers) {
      warnings.push(`${serverName} 当前不可用，相关工具调用可能失败`);
    }
    return { tools: snapshot, warnings };
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
    this.toolsRegistry.report(sessionId, tools.map((tool) => normalizeMcpToolRef(tool)));
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

/** 桌面上报与云端连接共用的工具引用归一化：补 serverId / inputSchema / fullToolName 缺省。 */
function normalizeMcpToolRef(tool: McpToolRef): McpToolRef {
  return {
    ...tool,
    serverId: tool.serverId ?? 0,
    inputSchema: normalizeMcpInputSchema(
      tool.inputSchema ?? (tool as { schema?: unknown }).schema,
    ),
    fullToolName: tool.fullToolName ?? fullToolName(tool.serverName, tool.toolName),
  };
}

/** 按 (serverName, toolName) 排序：连接顺序 / 上游返回顺序不影响 tools 数组的字节形态。 */
function sortMcpToolRefs(tools: McpToolRef[]): McpToolRef[] {
  return [...tools].sort((a, b) => {
    if (a.serverName !== b.serverName) return a.serverName < b.serverName ? -1 : 1;
    if (a.toolName !== b.toolName) return a.toolName < b.toolName ? -1 : 1;
    return 0;
  });
}
