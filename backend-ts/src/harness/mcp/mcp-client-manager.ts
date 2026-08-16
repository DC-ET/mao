import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { harnessLog } from '../log.js';
import { TYPE_STDIO, fullToolName, normalizeMcpInputSchema, type McpServer, type McpToolRef } from './entity/mcp-server.js';

type AnyClient = {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }>;
  callTool(args: { name: string; arguments?: Record<string, unknown> }): Promise<{
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
  }>;
  close(): Promise<void>;
};

export class McpClientManager {
  private readonly sessionClients = new Map<number, Map<number, AnyClient>>();

  constructor(private readonly clientTimeoutSeconds = 120) {}

  async connectAndListTools(sessionId: number, server: McpServer, env: Record<string, string>): Promise<McpToolRef[]> {
    const client = await this.connect(server, env);
    let map = this.sessionClients.get(sessionId);
    if (!map) {
      map = new Map();
      this.sessionClients.set(sessionId, map);
    }
    map.set(server.id!, client);
    const tools = await this.toToolRefs(server, await client.listTools());
    harnessLog('info', `MCP client connected (CLOUD): session=${sessionId}, server=${server.name}, tools=${tools.length}`);
    return tools;
  }

  async callTool(sessionId: number | null, serverId: number, toolName: string, argumentsJson: string): Promise<string> {
    const client = sessionId != null ? this.sessionClients.get(sessionId)?.get(serverId) : undefined;
    if (!client) return JSON.stringify({ error: `MCP connection not found for serverId=${serverId}` });
    try {
      const args = parseArguments(argumentsJson);
      const result = await client.callTool({ name: toolName, arguments: args });
      return formatResult(result);
    } catch (e) {
      harnessLog('warn', `MCP callTool failed: serverId=${serverId}, tool=${toolName}, error=${(e as Error).message}`);
      return JSON.stringify({ error: 'MCP tool call failed: ' + escapeJson((e as Error).message) });
    }
  }

  async testConnection(server: McpServer, env: Record<string, string>): Promise<McpToolRef[]> {
    const client = await this.connect(server, env);
    try {
      const tools = await this.toToolRefs(server, await client.listTools());
      harnessLog('info', `MCP test connection OK: server=${server.name}, tools=${tools.length}`);
      return tools;
    } finally {
      await this.closeClient(server.name ?? '', client);
    }
  }

  async closeSession(sessionId: number): Promise<void> {
    const clients = this.sessionClients.get(sessionId);
    this.sessionClients.delete(sessionId);
    if (!clients) return;
    for (const [serverId, client] of clients) {
      await this.closeClient(`session-${sessionId}/server-${serverId}`, client);
    }
    harnessLog('info', `Closed ${clients.size} MCP client connections for session ${sessionId}`);
  }

  hasSessionClients(sessionId: number): boolean {
    const clients = this.sessionClients.get(sessionId);
    return clients != null && clients.size > 0;
  }

  private async connect(server: McpServer, env: Record<string, string>): Promise<AnyClient> {
    const transport = this.buildTransport(server, env);
    try {
      const client = new Client({ name: 'mao', version: '1.0.0' }) as unknown as AnyClient;
      await client.connect(transport);
      return client;
    } catch (e) {
      throw new Error(`连接 MCP 服务器 ${server.name} 失败: ${(e as Error).message}`, { cause: e });
    }
  }

  private buildTransport(server: McpServer, env: Record<string, string>): unknown {
    if (server.serverType === TYPE_STDIO) {
      const args = parseArgs(server.argsJson);
      return new StdioClientTransport({
        command: server.command ?? '',
        args,
        env: { ...process.env, ...env } as Record<string, string>,
      });
    }
    const url = new URL(server.url ?? '');
    try {
      return new StreamableHTTPClientTransport(url);
    } catch {
      return new SSEClientTransport(url);
    }
  }

  private async toToolRefs(
    server: McpServer,
    result: { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> },
  ): Promise<McpToolRef[]> {
    const refs: McpToolRef[] = [];
    for (const tool of result.tools ?? []) {
      refs.push({
        serverId: server.id!,
        serverName: server.name ?? '',
        toolName: tool.name,
        description: tool.description ?? '',
        inputSchema: normalizeMcpInputSchema(tool.inputSchema),
        fullToolName: fullToolName(server.name ?? '', tool.name),
      });
    }
    return refs;
  }

  private async closeClient(label: string, client: AnyClient): Promise<void> {
    try {
      await client.close();
    } catch (e) {
      harnessLog('debug', `Failed to close MCP client ${label}: ${(e as Error).message}`);
    }
  }
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

function parseArguments(argumentsJson: string | null | undefined): Record<string, unknown> {
  if (!argumentsJson || argumentsJson.trim() === '') return {};
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
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

function escapeJson(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
