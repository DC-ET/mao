import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpClientManager } from './mcp-client-manager.js';
import { TYPE_HTTP, TYPE_STDIO } from './entity/mcp-server.js';

const { connect, listTools, callTool, close } = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  listTools: vi.fn(async () => ({
    tools: [{ name: 'read', description: 'read files', inputSchema: { type: 'object' } }],
  })),
  callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
  close: vi.fn(async () => undefined),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = connect;
    listTools = listTools;
    callTool = callTool;
    close = close;
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(public opts: unknown) {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {
    constructor(public url: URL) {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(public url: URL) {
      if (url.pathname.includes('force-sse')) throw new Error('streamable unavailable');
    }
  },
}));

describe('McpClientManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connect.mockResolvedValue(undefined);
    listTools.mockResolvedValue({
      tools: [{ name: 'read', description: 'read files', inputSchema: { type: 'object' } }],
    });
    callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    close.mockResolvedValue(undefined);
  });

  it('connects stdio server and lists tools', async () => {
    const mgr = new McpClientManager(30);
    const tools = await mgr.connectAndListTools(11, {
      id: 3, name: 'fs', serverType: TYPE_STDIO, command: 'npx', argsJson: '["-y","mcp-fs"]',
    }, { TOKEN: 'x' });
    expect(tools).toHaveLength(1);
    expect(tools[0].fullToolName).toBe('mcp__fs__read');
    expect(mgr.hasSessionClients(11)).toBe(true);
    expect(await mgr.callTool(11, 3, 'read', '{"path":"/a"}')).toBe('ok');
    expect(await mgr.callTool(11, 99, 'missing', '{}')).toContain('not found');
  });

  it('rejects invalid arguments JSON without calling the MCP tool', async () => {
    const mgr = new McpClientManager();
    await mgr.connectAndListTools(12, { id: 4, name: 'fs', serverType: TYPE_STDIO, command: 'node' }, {});
    callTool.mockClear();
    for (const bad of ['not-json', '{"path":', '[1,2]', '"text"']) {
      const result = JSON.parse(await mgr.callTool(12, 4, 'read', bad));
      expect(result.error).toContain('参数不是合法 JSON 对象');
    }
    expect(callTool).not.toHaveBeenCalled();
    // 空参数仍按 {} 正常调用
    callTool.mockResolvedValueOnce({ content: [{ text: 'ok' }] });
    expect(await mgr.callTool(12, 4, 'read', '')).toBe('ok');
    expect(callTool).toHaveBeenCalledWith({ name: 'read', arguments: {} });
  });

  it('formats errors structured content and image parts', async () => {
    const mgr = new McpClientManager();
    await mgr.connectAndListTools(1, { id: 1, name: 'http', serverType: TYPE_HTTP, url: 'https://mcp.example/rpc' }, {});
    callTool.mockResolvedValueOnce({ isError: true, content: [{ text: 'boom' }] });
    expect(JSON.parse(await mgr.callTool(1, 1, 't', '{}')).error).toBe('boom');
    callTool.mockResolvedValueOnce({ structuredContent: { a: 1 } });
    expect(JSON.parse(await mgr.callTool(1, 1, 't', '{"q":1}'))).toEqual({ a: 1 });
    callTool.mockResolvedValueOnce({ content: [{ type: 'image' }] });
    expect(await mgr.callTool(1, 1, 't', '')).toContain('图片');
    callTool.mockRejectedValueOnce(new Error('timeout "x"'));
    expect(JSON.parse(await mgr.callTool(1, 1, 't', '{}')).error).toContain('failed');
  });

  it('testConnection closes client and falls back to SSE transport', async () => {
    const mgr = new McpClientManager();
    const tools = await mgr.testConnection({
      id: 8, name: 'sse', serverType: TYPE_HTTP, url: 'https://mcp.example/force-sse',
    }, {});
    expect(tools[0].toolName).toBe('read');
    expect(close).toHaveBeenCalled();
  });

  it('closeSession closes all clients even when close throws', async () => {
    const mgr = new McpClientManager();
    await mgr.connectAndListTools(4, { id: 1, name: 'a', serverType: TYPE_STDIO, command: 'npx', argsJson: '[]' }, {});
    close.mockRejectedValueOnce(new Error('already closed'));
    await mgr.closeSession(4);
    expect(mgr.hasSessionClients(4)).toBe(false);
    await mgr.closeSession(99);
  });

  it('wraps connect failures', async () => {
    connect.mockRejectedValueOnce(new Error('refused'));
    const mgr = new McpClientManager();
    await expect(mgr.testConnection({
      id: 2, name: 'bad', serverType: TYPE_STDIO, command: 'npx', argsJson: 'not-json',
    }, {})).rejects.toThrow(/连接 MCP 服务器 bad 失败/);
  });

  describe('connectAndListTools cancel and timeout', () => {
    it('aborts a hanging connect once the cancel flag is set', async () => {
      // 复刻线上 session 2026：MCP 连接挂起 → buildContext 永不返回 → 执行体到不了
      // finally → WS handler 的 claim/future 永久残留 → 该会话后续发送全被
      // session_already_running 拒绝。取消标志置位后必须立刻中断。
      connect.mockImplementation(() => new Promise(() => { /* never settles */ }));
      const mgr = new McpClientManager(30, 60);
      const cancelled = { v: false, get: () => cancelled.v };
      setTimeout(() => { cancelled.v = true; }, 50);
      await expect(mgr.connectAndListTools(
        31, { id: 5, name: 'hang', serverType: TYPE_STDIO, command: 'npx' }, {}, cancelled,
      )).rejects.toThrow(/被取消/);
      // 取消后不得留下悬空连接
      expect(mgr.hasSessionClients(31)).toBe(false);
    }, 10_000);

    it('aborts a hanging connect on timeout even without a cancel flag', async () => {
      connect.mockImplementation(() => new Promise(() => { /* never settles */ }));
      const mgr = new McpClientManager(30, 1);
      await expect(mgr.connectAndListTools(
        32, { id: 6, name: 'slow', serverType: TYPE_STDIO, command: 'npx' }, {}, null,
      )).rejects.toThrow(/超时/);
      expect(mgr.hasSessionClients(32)).toBe(false);
    }, 10_000);

    it('aborts a hanging listTools on timeout and drops the registered client', async () => {
      connect.mockResolvedValue(undefined);
      listTools.mockImplementation(() => new Promise(() => { /* never settles */ }));
      const mgr = new McpClientManager(30, 1);
      await expect(mgr.connectAndListTools(
        33, { id: 7, name: 'slow-list', serverType: TYPE_STDIO, command: 'npx' }, {}, null,
      )).rejects.toThrow(/超时/);
      expect(mgr.hasSessionClients(33)).toBe(false);
    }, 10_000);

    it('completes normally when the flag stays false', async () => {
      const mgr = new McpClientManager(30, 60);
      const tools = await mgr.connectAndListTools(
        34, { id: 8, name: 'ok', serverType: TYPE_STDIO, command: 'npx' }, {}, { get: () => false },
      );
      expect(tools).toHaveLength(1);
      expect(mgr.hasSessionClients(34)).toBe(true);
    });

    it('a failing server does not close other servers already connected in the same session', async () => {
      // connectForCloud 逐个连接：单个 server 失败只回收它自己，否则同会话
      // 已连上的 server 会被连带断掉，本轮工具整体不可用。
      const mgr = new McpClientManager(30, 60);
      await mgr.connectAndListTools(
        35, { id: 9, name: 'first', serverType: TYPE_STDIO, command: 'npx' }, {}, null,
      );
      connect.mockImplementationOnce(() => new Promise(() => { /* never settles */ }));
      const cancelled = { v: false, get: () => cancelled.v };
      setTimeout(() => { cancelled.v = true; }, 50);
      await expect(mgr.connectAndListTools(
        35, { id: 10, name: 'second', serverType: TYPE_STDIO, command: 'npx' }, {}, cancelled,
      )).rejects.toThrow(/被取消/);
      expect(mgr.hasSessionClients(35)).toBe(true);
    }, 10_000);
  });
});
