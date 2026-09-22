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
    // 重连同一 serverId 时先关闭旧客户端，避免 STDIO 子进程泄漏
    const previous = map.get(server.id!);
    if (previous) {
      await this.closeClient(`session-${sessionId}/server-${server.id} (stale)`, previous);
    }
    map.set(server.id!, client);
    try {
      const tools = await this.toToolRefs(server, await client.listTools());
      harnessLog('info', `MCP client connected (CLOUD): session=${sessionId}, server=${server.name}, tools=${tools.length}`);
      return tools;
    } catch (e) {
      // listTools 失败时不留下悬空连接
      map.delete(server.id!);
      await this.closeClient(`session-${sessionId}/server-${server.id} (listTools failed)`, client);
      throw e;
    }
  }

  async callTool(sessionId: number | null, serverId: number, toolName: string, argumentsJson: string): Promise<string> {
    const client = sessionId != null ? this.sessionClients.get(sessionId)?.get(serverId) : undefined;
    if (!client) return JSON.stringify({ error: `MCP connection not found for serverId=${serverId}` });
    const args = parseArguments(argumentsJson);
    // 参数非法（模型输出被截断等）时兜底成 {} 会让 MCP 工具在缺参数下执行或报无关业务错，
    // 模型拿到的是误导性结果而非「参数不合法，重试」。与内置工具一致：直接返回错误、不发起调用。
    if (args == null) {
      harnessLog('warn', `MCP callTool rejected invalid arguments JSON: serverId=${serverId}, tool=${toolName}`);
      return JSON.stringify({ error: `MCP 工具参数不是合法 JSON 对象，请重新生成参数后重试: ${toolName}` });
    }
    try {
      // 必须有超时：MCP 服务器挂起会拖死整轮 Promise.all 工具执行
      const result = await this.withTimeout(
        client.callTool({ name: toolName, arguments: args }),
        this.clientTimeoutSeconds * 1000,
        `MCP tool call timed out after ${this.clientTimeoutSeconds}s: ${toolName}`,
      );
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
    // HTTP：先 Streamable，连接失败再回退 SSE。
    // StreamableHTTPClientTransport 构造通常不抛错，协议不兼容发生在 connect 阶段，
    // 因此回退必须包在 connect 而非构造器上。
    if (server.serverType !== TYPE_STDIO) {
      const url = new URL(server.url ?? '');
      try {
        const client = new Client({ name: 'mao', version: '1.0.0' }) as unknown as AnyClient;
        await client.connect(new StreamableHTTPClientTransport(url));
        return client;
      } catch (streamableErr) {
        harnessLog('info', `MCP StreamableHTTP connect failed for ${server.name}, trying SSE: ${(streamableErr as Error).message}`);
        try {
          const client = new Client({ name: 'mao', version: '1.0.0' }) as unknown as AnyClient;
          await client.connect(new SSEClientTransport(url));
          return client;
        } catch (sseErr) {
          throw new Error(
            `连接 MCP 服务器 ${server.name} 失败: streamable=${(streamableErr as Error).message}; sse=${(sseErr as Error).message}`,
            { cause: sseErr },
          );
        }
      }
    }
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
    // HTTP 路径在 connect() 中处理 Streamable→SSE 回退
    return new StreamableHTTPClientTransport(new URL(server.url ?? ''));
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

  private async withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
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

/** 解析工具参数；非法 JSON 或非对象返回 null（调用方据此拒绝调用），空参数视为 {}。 */
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

function escapeJson(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
