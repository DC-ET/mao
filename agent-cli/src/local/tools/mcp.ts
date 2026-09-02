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
  buf: string;
  stderrTail: string;
  dead: boolean;
}

const MCP_TIMEOUT_MS = 30_000;
const MCP_CALL_TIMEOUT_MS = 120_000;
const MCP_CONNECT_TIMEOUT_MS = 45_000;
const STDERR_TAIL_LIMIT = 4000;
/** 只透传子进程运行所必需的变量，绝不把 MAO_TOKEN / MAO_REFRESH_TOKEN 等凭据交给远端指定的可执行文件。 */
const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'TZ', 'USER', 'LOGNAME',
  'SystemRoot', 'SystemDrive', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'PATHEXT', 'COMSPEC', 'USERPROFILE',
];

export function buildMcpEnv(spec: McpServerSpec): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value != null) env[key] = value;
  }
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    if (value != null) env[key] = String(value);
  }
  return env;
}

/** MCP stdio 传输是行分隔 JSON（消息内不得含换行）。 */
function frame(msg: object): string {
  return `${JSON.stringify(msg)}\n`;
}

function killTree(proc: ChildProcessWithoutNullStreams | undefined): void {
  if (!proc?.pid) return;
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      // 进程已退出
    }
  }
}

function failConn(conn: McpConn, message: string): void {
  conn.dead = true;
  const error = new Error(message);
  for (const waiter of conn.pending.values()) waiter.reject(error);
  conn.pending.clear();
}

function attachStdioReader(conn: McpConn, proc: ChildProcessWithoutNullStreams, serverName: string): void {
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    conn.buf += chunk;
    let nl = conn.buf.indexOf('\n');
    while (nl >= 0) {
      const line = conn.buf.slice(0, nl).trim();
      conn.buf = conn.buf.slice(nl + 1);
      nl = conn.buf.indexOf('\n');
      if (!line) continue;
      let parsed: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        parsed = JSON.parse(line) as typeof parsed;
      } catch {
        continue;
      }
      if (parsed.id == null) continue;
      const waiter = conn.pending.get(parsed.id);
      if (!waiter) continue;
      conn.pending.delete(parsed.id);
      if (parsed.error) waiter.reject(new Error(parsed.error.message || 'MCP error'));
      else waiter.resolve(parsed.result);
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk: string) => {
    conn.stderrTail = (conn.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
  });
  proc.on('error', (e: Error) => {
    failConn(conn, `MCP server "${serverName}" 启动失败：${e.message}`);
  });
  proc.on('exit', (code, signal) => {
    const detail = conn.stderrTail.trim();
    failConn(
      conn,
      `MCP server "${serverName}" 已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）${detail ? `：${detail}` : ''}`,
    );
  });
}

function rpc(conn: McpConn, method: string, params: unknown, timeoutMs: number, serverName: string): Promise<unknown> {
  const id = ++conn.nextId;
  const proc = conn.proc;
  if (conn.dead || !proc?.stdin.writable) return Promise.reject(new Error(`MCP server "${serverName}" 连接已断开`));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      // 超时说明子进程无响应，直接杀掉进程组，避免僵尸进程与后续调用继续排队。
      killTree(conn.proc);
      const detail = conn.stderrTail.trim();
      reject(new Error(`MCP ${method} timed out${detail ? `：${detail}` : ''}`));
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

function mapTools(listed: { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }): McpToolDef[] {
  return (listed.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description || '',
    schema: t.inputSchema || { type: 'object', properties: {} },
  }));
}

async function connectStdio(server: McpServerSpec): Promise<{ conn: McpConn; tools: McpToolDef[] }> {
  if (!server.command) throw new Error(`MCP server "${server.name}": STDIO requires command`);
  const proc = spawn(server.command, Array.isArray(server.args) ? server.args.map(String) : [], {
    env: buildMcpEnv(server),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  const conn: McpConn = { proc, nextId: 0, pending: new Map(), buf: '', stderrTail: '', dead: false };
  attachStdioReader(conn, proc, server.name);
  try {
    await rpc(conn, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mao-agent', version: getCliVersion() },
    }, MCP_TIMEOUT_MS, server.name);
    notify(conn, 'notifications/initialized', {});
    const listed = await rpc(conn, 'tools/list', {}, MCP_TIMEOUT_MS, server.name) as Parameters<typeof mapTools>[0];
    return { conn, tools: mapTools(listed) };
  } catch (e) {
    killTree(proc);
    throw e;
  }
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
  const body = await list.json() as { result?: Parameters<typeof mapTools>[0] };
  return { tools: mapTools(body.result ?? {}), sessionId };
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    task.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

interface McpEntry {
  conn?: McpConn;
  tools: McpToolDef[];
  httpUrl?: string;
  mcpSessionId?: string;
}

export interface McpSyncOptions {
  /** stdio 服务器会 spawn 服务端指定的可执行文件，视为需要审批的变更类操作。 */
  approveSpawn?: (server: McpServerSpec) => Promise<{ allowed: boolean; reason: string }>;
}

export class McpManager {
  private readonly sessions = new Map<number, Map<string, McpEntry>>();

  async sync(sessionId: number, servers: McpServerSpec[], opts: McpSyncOptions = {}): Promise<McpServerReport[]> {
    await this.close(sessionId);
    const map = new Map<string, McpEntry>();
    this.sessions.set(sessionId, map);
    const named = servers.filter((s) => Boolean(s.name));
    const reports = await Promise.all(named.map(async (server): Promise<McpServerReport> => {
      try {
        const type = String(server.type || 'STDIO').toUpperCase();
        if (type === 'HTTP' || type === 'SSE') {
          const { tools, sessionId: mcpSessionId } = await withTimeout(
            connectHttp(server), MCP_CONNECT_TIMEOUT_MS, `MCP server "${server.name}" 连接超时`,
          );
          map.set(server.name, { tools, httpUrl: server.url, mcpSessionId });
          return { name: server.name, connected: true, tools, error: null };
        }
        if (opts.approveSpawn) {
          const decision = await opts.approveSpawn(server);
          if (!decision.allowed) return { name: server.name, connected: false, tools: [], error: decision.reason };
        }
        const { conn, tools } = await withTimeout(
          connectStdio(server), MCP_CONNECT_TIMEOUT_MS, `MCP server "${server.name}" 连接超时`,
        );
        map.set(server.name, { conn, tools });
        return { name: server.name, connected: true, tools, error: null };
      } catch (e) {
        return { name: server.name, connected: false, tools: [], error: e instanceof Error ? e.message : String(e) };
      }
    }));
    return reports;
  }

  async call(sessionId: number, serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const entry = this.sessions.get(sessionId)?.get(serverName);
    if (!entry) throw new Error(`MCP server "${serverName}" is not connected`);
    if (entry.httpUrl) {
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
      if (entry.mcpSessionId) headers['mcp-session-id'] = entry.mcpSessionId;
      const res = await fetch(entry.httpUrl, {
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
    if (!entry.conn) throw new Error(`MCP server "${serverName}" has no transport`);
    const result = await rpc(entry.conn, 'tools/call', { name: toolName, arguments: args }, MCP_CALL_TIMEOUT_MS, serverName);
    return formatCallResult(result);
  }

  async close(sessionId: number): Promise<void> {
    const map = this.sessions.get(sessionId);
    if (!map) return;
    this.sessions.delete(sessionId);
    for (const entry of map.values()) {
      if (entry.conn) {
        entry.conn.dead = true;
        killTree(entry.conn.proc);
      }
    }
  }
}

/** MCP 工具报错必须抛出，否则错误内容会被当成正常结果喂给模型。 */
export function formatCallResult(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const obj = result as { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const text = obj.structuredContent != null
    ? JSON.stringify(obj.structuredContent)
    : Array.isArray(obj.content)
      ? obj.content.map((c) => c.text || JSON.stringify(c)).join('\n')
      : JSON.stringify(result);
  if (obj.isError === true) throw new Error(text || 'MCP tool reported an error');
  return text;
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
