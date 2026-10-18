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
    await client.connect(transport);
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
    const tools = await client.listTools();
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
