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

  it('formats errors structured content and image parts', async () => {
    const mgr = new McpClientManager();
    await mgr.connectAndListTools(1, { id: 1, name: 'http', serverType: TYPE_HTTP, url: 'https://mcp.example/rpc' }, {});
    callTool.mockResolvedValueOnce({ isError: true, content: [{ text: 'boom' }] });
    expect(JSON.parse(await mgr.callTool(1, 1, 't', '{}')).error).toBe('boom');
    callTool.mockResolvedValueOnce({ structuredContent: { a: 1 } });
    expect(JSON.parse(await mgr.callTool(1, 1, 't', 'not-json'))).toEqual({ a: 1 });
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
});
