import { harnessLog } from '../log.js';
import type { McpClientManager } from '../mcp/mcp-client-manager.js';
import type { McpServer, McpToolRef } from '../mcp/entity/mcp-server.js';
import type { DockerToolRouter, McpToolRefLike } from './docker-tool-router.js';
import type { SessionMapper } from '../deps.js';

export interface RuntimeModeProbe {
  /** 该会话的执行用户是否走容器。由装配层注入（查会话归属 + 用户 runtime mode）。 */
  shouldHandle(sessionId: number): Promise<boolean>;
  /** 会话归属用户的 id（用于容器请求寻址）。 */
  userIdOf(sessionId: number): Promise<number | null>;
}

/**
 * MCP stdio 容器路由（技术方案 §5.10）：与 McpClientManager 同接口的路由包装。
 * 容器用户：连接与 callTool 派发到容器内 ContainerMcpBridge（容器内 spawn stdio 子进程）；
 * 其他用户：直通宿主机 McpClientManager。HTTP 型 MCP 不涉子进程，两路都留宿主机/容器内
 * 按同一 connect 语义（容器内 HTTP 也可直连，这里统一按 serverType 无差别转发）。
 */
export class RoutingMcpClientManager {
  constructor(
    private readonly deps: {
      host: McpClientManager;
      router: DockerToolRouter;
      probe: RuntimeModeProbe;
    },
  ) {}

  async connectAndListTools(
    sessionId: number, server: McpServer, env: Record<string, string>,
    cancelFlag?: { get(): boolean } | null,
  ): Promise<McpToolRef[]> {
    if (!(await this.deps.probe.shouldHandle(sessionId))) {
      return this.deps.host.connectAndListTools(sessionId, server, env, cancelFlag);
    }
    const refs = await this.deps.router.mcpConnect({
      userId: await this.userIdOf(sessionId),
      sessionId,
      server: {
        id: server.id ?? 0,
        name: server.name ?? '',
        serverType: server.serverType ?? '',
        command: server.command ?? null,
        argsJson: server.argsJson ?? null,
        url: server.url ?? null,
      },
      env,
    });
    return refs.map(toMcpToolRef);
  }

  async callTool(sessionId: number | null, serverId: number, toolName: string, argumentsJson: string): Promise<string> {
    if (sessionId == null || !(await this.deps.probe.shouldHandle(sessionId))) {
      return this.deps.host.callTool(sessionId, serverId, toolName, argumentsJson);
    }
    return this.deps.router.mcpCall({
      userId: await this.userIdOf(sessionId),
      sessionId,
      serverId,
      toolName,
      argumentsJson,
    });
  }

  /** admin「测试连接」在宿主机执行（运维动作，与用户运行时无关）。 */
  async testConnection(server: McpServer, env: Record<string, string>): Promise<McpToolRef[]> {
    return this.deps.host.testConnection(server, env);
  }

  async closeSession(sessionId: number): Promise<void> {
    await this.deps.host.closeSession(sessionId);
    try {
      if (await this.deps.probe.shouldHandle(sessionId)) {
        const userId = await this.tryUserIdOf(sessionId);
        if (userId != null) {
          await this.deps.router.mcpCloseSession({ userId, sessionId });
        }
      }
    } catch (e) {
      harnessLog('debug', `RoutingMcpClientManager.closeSession container cleanup skipped: ${(e as Error).message}`);
    }
  }

  hasSessionClients(sessionId: number): boolean {
    // 宿主机侧不再持有容器用户的 stdio 子进程，这里只反映 host 侧连接；
    // 容器侧连接存活与否由 tool_call 链路的错误反馈，不影响工具列表下发
    return this.deps.host.hasSessionClients(sessionId);
  }

  private async userIdOf(sessionId: number): Promise<number> {
    const userId = await this.tryUserIdOf(sessionId);
    if (userId == null) throw new Error(`session not found for MCP routing: ${sessionId}`);
    return userId;
  }

  private async tryUserIdOf(sessionId: number): Promise<number | null> {
    return this.deps.probe.userIdOf(sessionId);
  }
}

function toMcpToolRef(ref: McpToolRefLike): McpToolRef {
  return {
    serverId: ref.serverId,
    serverName: ref.serverName,
    toolName: ref.toolName,
    description: ref.description,
    inputSchema: ref.inputSchema,
    fullToolName: ref.fullToolName,
  };
}
