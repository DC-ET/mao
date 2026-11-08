import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mcpWhitelistEnv } from '../mcp/mcp-client-manager.js';
import { normalizeMcpAnnotations } from '../mcp/entity/mcp-server.js';
import type { McpServerSpec, RuntimeEnvelope } from './runtime-channel-protocol.js';

type AnyClient = {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: unknown }> }>;
  callTool(args: { name: string; arguments?: Record<string, unknown> }): Promise<{
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
  }>;
  close(): Promise<void>;
};

/** connect / listTools 的兜底超时：能 spawn 但不响应 initialize 的 server 会让 buildContext 每轮挂死。 */
const MCP_CONNECT_TIMEOUT_MS = 60_000;

/**
 * Promise 超时包装（与宿主 McpClientManager.withTimeout 同款）。用 Promise.race 而非在轮询
 * 回调里 throw：定时器回调中的异常不会 reject 外层 Promise，调用方仍会永久挂起。
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    // 主流程先行结束时不再由本定时器持有事件循环
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export interface ContainerMcpToolRef {
  serverId: number;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  fullToolName: string;
  annotations?: { readOnlyHint?: boolean } | null;
}

/**
 * 容器内 MCP stdio 代理（技术方案 §5.10）：按会话维度持有 stdio client，
 * 连接与 callTool 都发生在容器内。env 只含白名单键 + server 自身 envJson + envelope 用户凭据，
 * 容器内本就没有平台凭据，白名单用于避免继承 agent 进程的无关变量。
 */
export class ContainerMcpBridge {
  private readonly sessionClients = new Map<number, Map<number, AnyClient>>();

  async connectAndListTools(
    sessionId: number,
    server: McpServerSpec,
    serverEnv: Record<string, string>,
    envelope?: RuntimeEnvelope,
  ): Promise<ContainerMcpToolRef[]> {
    const client = new Client({ name: 'mao', version: '1.0.0' }) as unknown as AnyClient;
    const transport = new StdioClientTransport({
      command: server.command ?? '',
      args: parseArgs(server.argsJson),
      env: containerMcpEnv(serverEnv, envelope),
    });
    try {
      // 必须有超时：StdioClientTransport.start() 在 connect 里就已 spawn 子进程，
      // 挂起的 server（能 spawn 但不回 initialize）会把整轮 buildContext 无限期拖住。
      await withTimeout(
        client.connect(transport),
        MCP_CONNECT_TIMEOUT_MS,
        `连接 MCP 服务器 ${server.name} 超时（60s）`,
      );
      let map = this.sessionClients.get(sessionId);
      if (!map) {
        map = new Map();
        this.sessionClients.set(sessionId, map);
      }
      const previous = map.get(server.id);
      if (previous) {
        await closeQuietly(previous);
      }
      map.set(server.id, client);
      const tools = await withTimeout(
        client.listTools(),
        MCP_CONNECT_TIMEOUT_MS,
        `MCP listTools 超时（60s）：${server.name}`,
      );
      const refs: ContainerMcpToolRef[] = [];
      for (const tool of tools.tools ?? []) {
        refs.push({
          serverId: server.id,
          serverName: server.name ?? '',
          toolName: tool.name,
          description: tool.description ?? '',
          inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
          fullToolName: `mcp__${server.name}__${tool.name}`,
          annotations: normalizeMcpAnnotations(tool.annotations),
        });
      }
      return refs;
    } catch (e) {
      // 每条失败路径都必须回收：connect/listTools 抛错时 StdioClientTransport 已 spawn 的子进程
      // 不会自己退出，不关就等于每轮执行泄漏一个（容器 --pids-limit 下逐渐耗尽）。
      // 先摘 map（可能已入），再 close——Client.close 会关 transport 并杀掉子进程。
      const map = this.sessionClients.get(sessionId);
      if (map?.get(server.id) === client) {
        map.delete(server.id);
        if (map.size === 0) this.sessionClients.delete(sessionId);
      }
      await closeQuietly(client);
      throw e;
    }
  }

  async callTool(sessionId: number, serverId: number, toolName: string, argumentsJson: string): Promise<string> {
    const client = this.sessionClients.get(sessionId)?.get(serverId);
    if (!client) return JSON.stringify({ error: `MCP connection not found in container for serverId=${serverId}` });
    const args = parseArguments(argumentsJson);
    if (args == null) {
      return JSON.stringify({ error: `MCP 工具参数不是合法 JSON 对象，请重新生成参数后重试: ${toolName}` });
    }
    try {
      const result = await client.callTool({ name: toolName, arguments: args });
      return formatResult(result);
    } catch (e) {
      return JSON.stringify({ error: 'MCP tool call failed: ' + (e as Error).message });
    }
  }

  async closeSession(sessionId: number): Promise<void> {
    const clients = this.sessionClients.get(sessionId);
    this.sessionClients.delete(sessionId);
    if (!clients) return;
    for (const [, client] of clients) {
      await closeQuietly(client);
    }
  }

  closeAll(): void {
    for (const [sessionId] of [...this.sessionClients.entries()]) {
      void this.closeSession(sessionId);
    }
  }
}

/** 容器内 spawn env：白名单继承（容器内进程 env 无平台凭据）+ server 自身 env + 用户级凭据。 */
export function containerMcpEnv(serverEnv: Record<string, string>, envelope?: RuntimeEnvelope): Record<string, string> {
  const userCreds: Record<string, string> = {};
  if (envelope) {
    for (const [domain, token] of Object.entries(envelope.gitTokens ?? {})) {
      userCreds[gitTokenEnvKey(domain)] = token;
    }
    if (envelope.maoToken) userCreds.MAO_TOKEN = envelope.maoToken;
    if (envelope.maoBaseUrl) userCreds.MAO_BASE_URL = envelope.maoBaseUrl;
    if (envelope.ecpToken) userCreds.ECP_TOKEN = envelope.ecpToken;
    if (envelope.larkUat) {
      userCreds.LARKSUITE_CLI_USER_ACCESS_TOKEN = envelope.larkUat.uat;
      userCreds.LARKSUITE_CLI_APP_ID = envelope.larkUat.appId;
    }
    // §5.13 依赖目录 env：容器内同样以 /deps 为安装位置
    Object.assign(userCreds, envelope.depsEnv ?? {});
  }
  return { ...mcpWhitelistEnv(serverEnv), ...userCreds };
}

function gitTokenEnvKey(domain: string): string {
  // 与 GitCredentialService.envVarNameForDomain 同一口径（容器内不得 import 该模块）
  return `GIT_TOKEN_${domain.replace(/[.-]/g, '_')}`;
}

function parseArgs(argsJson: string | null | undefined): string[] {
  if (!argsJson || argsJson.trim() === '') return [];
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseArguments(argumentsJson: string | null | undefined): Record<string, unknown> | null {
  if (!argumentsJson || argumentsJson.trim() === '') return {};
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function formatResult(result: {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
}): string {
  if (!result) return JSON.stringify({ error: 'Empty MCP tool result' });
  if (result.isError) {
    const text = (result.content ?? []).map((c) => c.text).filter(Boolean).join('\n');
    return JSON.stringify({ error: text || 'MCP tool returned error' });
  }
  if (result.structuredContent != null) {
    try {
      return JSON.stringify(result.structuredContent);
    } catch { /* fall through */ }
  }
  const parts: string[] = [];
  for (const c of result.content ?? []) {
    if (c.type === 'text' || c.text) parts.push(c.text ?? '');
    else if (c.type === 'image') parts.push('[图片内容：MCP 服务器返回了图片（base64），请根据上下文说明图片内容]');
  }
  return parts.join('\n');
}

async function closeQuietly(client: AnyClient): Promise<void> {
  try {
    await client.close();
  } catch { /* ignore */ }
}
