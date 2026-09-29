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

  constructor(
    private readonly clientTimeoutSeconds = 120,
    /** 连接 + listTools 的整体超时：裸 fetch 无超时，SDK 的 SSE 还会退避重连，必须兜底 */
    private readonly connectTimeoutSeconds = 60,
  ) {}

  async connectAndListTools(
    sessionId: number, server: McpServer, env: Record<string, string>,
    cancelFlag?: { get(): boolean } | null,
  ): Promise<McpToolRef[]> {
    // 取消感知的连接：buildContext 在 LLM 首轮之前连接 MCP，用户此时点「停止」没有任何
    // 别的出口。裸 fetch 没有超时，SDK 的 SSE 还会按退避重连（1s→30s 收敛，最多 2 次），
    // 一次挂起就能把整次执行无限期拖住——执行体到不了 finally，WS handler 的 claim/future
    // 永久残留，该会话后续发送与重试全被 session_already_running 拒绝。
    // 用 race 而非在轮询回调里 throw：setInterval 回调中的异常不会 reject 外层 Promise，
    // 调用方仍会永久挂起。
    const deadline = Date.now() + this.connectTimeoutSeconds * 1000;
    let poll: NodeJS.Timeout | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      poll = setInterval(() => {
        if (cancelFlag?.get()) {
          reject(new Error(`连接 MCP 服务器 ${server.name} 被取消`));
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(`连接 MCP 服务器 ${server.name} 超时（${this.connectTimeoutSeconds}s）`));
        }
      }, 500);
      // 主流程先行结束时不再由本定时器持有事件循环
      poll.unref();
    });

    const connectAndList = async (): Promise<McpToolRef[]> => {
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
      const tools = await this.withTimeout(
        client.listTools(),
        this.connectTimeoutSeconds * 1000,
        `MCP listTools 超时（${this.connectTimeoutSeconds}s）：${server.name}`,
      );
      const refs = await this.toToolRefs(server, tools);
      harnessLog('info', `MCP client connected (CLOUD): session=${sessionId}, server=${server.name}, tools=${refs.length}`);
      return refs;
    };

    try {
      return await Promise.race([connectAndList(), abortPromise]);
    } catch (e) {
      // 只回收本次 server 的连接：connectForCloud 逐个连接，误关整个会话会连带
      // 断掉同会话里已连上的其它 server（那会让本轮工具整体不可用）。
      await this.closeSessionServer(sessionId, server.id!);
      throw e;
    } finally {
      if (poll) clearInterval(poll);
    }
  }

  /** 关闭会话内单个 server 的连接（含 STDIO 子进程），不影响同会话其它 server。 */
  private async closeSessionServer(sessionId: number, serverId: number): Promise<void> {
    const map = this.sessionClients.get(sessionId);
    if (!map) return;
    const client = map.get(serverId);
    if (!client) return;
    map.delete(serverId);
    if (map.size === 0) this.sessionClients.delete(sessionId);
    await this.closeClient(`session-${sessionId}/server-${serverId}`, client);
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
