import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { getCliVersion } from '../../util/version';

export interface McpServerSpec {
  name: string;
  type?: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface McpToolDef {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface McpServerReport {
  name: string;
  connected: boolean;
  tools: McpToolDef[];
  error: string | null;
}

interface McpConn {
  proc?: ChildProcessWithoutNullStreams;
  nextId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  buf: Buffer;
}

const MCP_TIMEOUT_MS = 30_000;
const MCP_CALL_TIMEOUT_MS = 120_000;

function frame(msg: object): Buffer {
  const json = JSON.stringify(msg);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function attachStdioReader(conn: McpConn, proc: ChildProcessWithoutNullStreams): void {
  proc.stdout.on('data', (chunk: Buffer) => {
    conn.buf = Buffer.concat([conn.buf, chunk]);
    while (true) {
      const headerEnd = conn.buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = conn.buf.subarray(0, headerEnd).toString('utf8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        conn.buf = conn.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(match[1]);
      const start = headerEnd + 4;
      if (conn.buf.length < start + len) return;
      const body = conn.buf.subarray(start, start + len).toString('utf8');
      conn.buf = conn.buf.subarray(start + len);
      try {
        const parsed = JSON.parse(body) as { id?: number; result?: unknown; error?: { message?: string } };
        if (parsed.id != null) {
          const waiter = conn.pending.get(parsed.id);
          if (waiter) {
            conn.pending.delete(parsed.id);
            if (parsed.error) waiter.reject(new Error(parsed.error.message || 'MCP error'));
            else waiter.resolve(parsed.result);
          }
        }
      } catch {
        // ignore malformed
      }
    }
  });
}

function rpc(conn: McpConn, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
  const id = ++conn.nextId;
  const proc = conn.proc;
  if (!proc?.stdin.writable) return Promise.reject(new Error('MCP stdin closed'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      reject(new Error(`MCP ${method} timed out`));
    }, timeoutMs);
    conn.pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    proc.stdin.write(frame({ jsonrpc: '2.0', id, method, params }));
  });
}

function notify(conn: McpConn, method: string, params: unknown): void {
  conn.proc?.stdin.write(frame({ jsonrpc: '2.0', method, params }));
}

async function connectStdio(server: McpServerSpec): Promise<{ conn: McpConn; tools: McpToolDef[] }> {
  if (!server.command) throw new Error(`MCP server "${server.name}": STDIO requires command`);
  const env = { ...process.env, ...(server.env ?? {}) };
  const proc = spawn(server.command, Array.isArray(server.args) ? server.args.map(String) : [], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const conn: McpConn = { proc, nextId: 0, pending: new Map(), buf: Buffer.alloc(0) };
  attachStdioReader(conn, proc);
  proc.stderr.resume();
  await rpc(conn, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mao-agent', version: getCliVersion() },
  }, MCP_TIMEOUT_MS);
  notify(conn, 'notifications/initialized', {});
  const listed = await rpc(conn, 'tools/list', {}, MCP_TIMEOUT_MS) as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
  const tools = (listed.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description || '',
    schema: t.inputSchema || { type: 'object', properties: {} },
  }));
  return { conn, tools };
}

async function connectHttp(server: McpServerSpec): Promise<{ tools: McpToolDef[]; sessionId?: string }> {
  if (!server.url) throw new Error(`MCP server "${server.name}": HTTP requires url`);
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const res = await fetch(server.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mao-agent', version: getCliVersion() },
      },
    }),
  });
  if (!res.ok) throw new Error(`HTTP MCP initialize failed: ${res.status}`);
  // Streamable HTTP 会话协商：服务端通过 Mcp-Session-Id 响应头下发会话标识，
  // 后续 tools/list 与 tools/call 必须原样回传，否则无状态服务端视为新会话。
  const sessionId = res.headers.get('mcp-session-id') ?? undefined;
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const list = await fetch(server.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  if (!list.ok) throw new Error(`HTTP MCP tools/list failed: ${list.status}`);
  const body = await list.json() as { result?: { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> } };
  const tools = (body.result?.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description || '',
    schema: t.inputSchema || { type: 'object', properties: {} },
  }));
  return { tools, sessionId };
}

export class McpManager {
  private readonly sessions = new Map<number, Map<string, { conn?: McpConn; tools: McpToolDef[]; httpUrl?: string; mcpSessionId?: string }>>();

  async sync(sessionId: number, servers: McpServerSpec[]): Promise<McpServerReport[]> {
    await this.close(sessionId);
    const map = new Map<string, { conn?: McpConn; tools: McpToolDef[]; httpUrl?: string; mcpSessionId?: string }>();
    this.sessions.set(sessionId, map);
    const reports: McpServerReport[] = [];
    for (const server of servers) {
      const name = server.name;
      if (!name) continue;
      try {
        const type = String(server.type || 'STDIO').toUpperCase();
        if (type === 'HTTP' || type === 'SSE') {
          const { tools, sessionId: mcpSessionId } = await connectHttp(server);
          map.set(name, { tools, httpUrl: server.url, mcpSessionId });
          reports.push({ name, connected: true, tools, error: null });
        } else {
          const { conn, tools } = await connectStdio(server);
          map.set(name, { conn, tools });
          reports.push({ name, connected: true, tools, error: null });
        }
      } catch (e) {
        reports.push({ name, connected: false, tools: [], error: e instanceof Error ? e.message : String(e) });
      }
    }
    return reports;
  }

  async call(sessionId: number, serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const conn = this.sessions.get(sessionId)?.get(serverName);
    if (!conn) throw new Error(`MCP server "${serverName}" is not connected`);
    if (conn.httpUrl) {
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
      if (conn.mcpSessionId) headers['mcp-session-id'] = conn.mcpSessionId;
      const res = await fetch(conn.httpUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: { name: toolName, arguments: args },
        }),
      });
      if (!res.ok) throw new Error(`HTTP MCP call failed: ${res.status}`);
      const body = await res.json() as { result?: unknown; error?: { message?: string } };
      if (body.error) throw new Error(body.error.message || 'MCP error');
      return formatCallResult(body.result);
    }
    if (!conn.conn) throw new Error(`MCP server "${serverName}" has no transport`);
    const result = await rpc(conn.conn, 'tools/call', { name: toolName, arguments: args }, MCP_CALL_TIMEOUT_MS);
    return formatCallResult(result);
  }

  async close(sessionId: number): Promise<void> {
    const map = this.sessions.get(sessionId);
    if (!map) return;
    this.sessions.delete(sessionId);
    for (const entry of map.values()) {
      try {
        entry.conn?.proc?.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  }
}

function formatCallResult(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const obj = result as { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  if (obj.structuredContent != null) return JSON.stringify(obj.structuredContent);
  if (Array.isArray(obj.content)) {
    return obj.content.map((c) => c.text || JSON.stringify(c)).join('\n');
  }
  return JSON.stringify(result);
}

export function parseMcpToolName(toolName: string): { serverName: string; toolName: string } | null {
  if (!toolName.startsWith('mcp__')) return null;
  const rest = toolName.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) return null;
  const serverName = rest.slice(0, sep);
  const inner = rest.slice(sep + 2);
  if (!serverName || !inner) return null;
  return { serverName, toolName: inner };
}
