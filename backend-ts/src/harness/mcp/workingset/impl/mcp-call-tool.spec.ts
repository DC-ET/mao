import { describe, expect, it, vi } from 'vitest';
import { McpCallTool } from './mcp-call-tool.js';
import type { McpToolRef } from '../../entity/mcp-server.js';

function ref(serverId: number, serverName: string, toolName: string): McpToolRef {
  return {
    serverId,
    serverName,
    toolName,
    description: `${toolName} desc`,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  };
}

function makeTool(options: {
  executionMode?: string | null;
  cloud?: McpToolRef[];
  local?: McpToolRef[];
  sessionMissing?: boolean;
}) {
  const clientManager = { callTool: vi.fn(async () => 'mcp-result') };
  const sessionMapper = {
    selectById: vi.fn(async () => (options.sessionMissing ? null : { executionMode: options.executionMode ?? 'CLOUD' })),
  };
  const toolsRegistry = {
    getCloudSnapshot: vi.fn(() => options.cloud ?? []),
    getSessionTools: vi.fn(() => options.local ?? []),
  };
  return {
    clientManager,
    sessionMapper,
    tool: new McpCallTool({
      sessionMapper: sessionMapper as never,
      toolsRegistry,
      clientManager,
    }),
  };
}

describe('McpCallTool', () => {
  it('calls the CLOUD MCP client with the resolved server id and inner arguments', async () => {
    const { tool, clientManager } = makeTool({
      executionMode: 'CLOUD',
      cloud: [ref(11, 'fs', 'read_file')],
    });
    const result = await tool.execute(
      JSON.stringify({ server: 'fs', tool: 'read_file', arguments: { path: 'a.txt' } }),
      7, 9, 'workspace',
    );
    expect(result).toBe('mcp-result');
    expect(clientManager.callTool).toHaveBeenCalledWith(7, 11, 'read_file', '{"path":"a.txt"}');
  });

  it('defaults missing arguments to an empty object', async () => {
    const { tool, clientManager } = makeTool({ cloud: [ref(11, 'fs', 'list')] });
    await tool.execute(JSON.stringify({ server: 'fs', tool: 'list' }), 7, 9, 'workspace');
    expect(clientManager.callTool).toHaveBeenCalledWith(7, 11, 'list', '{}');
  });

  it('rejects invalid JSON without calling the MCP server', async () => {
    const { tool, clientManager } = makeTool({ cloud: [ref(11, 'fs', 'read_file')] });
    const result = JSON.parse(await tool.execute('{not-json', 7, 9, null) as string);
    expect(result.error).toContain('不是合法 JSON');
    expect(clientManager.callTool).not.toHaveBeenCalled();
  });

  it('rejects missing server / tool', async () => {
    const { tool } = makeTool({ cloud: [ref(11, 'fs', 'read_file')] });
    const missingServer = JSON.parse(await tool.execute(JSON.stringify({ tool: 'read_file' }), 7, 9, null) as string);
    expect(missingServer.error).toContain('缺少 server');
    const missingTool = JSON.parse(await tool.execute(JSON.stringify({ server: 'fs' }), 7, 9, null) as string);
    expect(missingTool.error).toContain('缺少 server');
  });

  it('rejects a non-object arguments field', async () => {
    const { tool, clientManager } = makeTool({ cloud: [ref(11, 'fs', 'read_file')] });
    const result = JSON.parse(await tool.execute(
      JSON.stringify({ server: 'fs', tool: 'read_file', arguments: ['x'] }), 7, 9, null,
    ) as string);
    expect(result.error).toContain('arguments 必须是 JSON 对象');
    expect(clientManager.callTool).not.toHaveBeenCalled();
  });

  it('reports an empty session snapshot distinctly from an unknown tool', async () => {
    const { tool, clientManager } = makeTool({ cloud: [] });
    const empty = JSON.parse(await tool.execute(JSON.stringify({ server: 'fs', tool: 'read_file' }), 7, 9, null) as string);
    expect(empty.error).toContain('没有可用的 MCP 工具');
    expect(clientManager.callTool).not.toHaveBeenCalled();
  });

  it('lists available servers / tools when the target is not found', async () => {
    const { tool } = makeTool({ cloud: [ref(11, 'fs', 'read_file'), ref(12, 'github', 'list_issues')] });
    const result = JSON.parse(await tool.execute(JSON.stringify({ server: 'fs', tool: 'missing' }), 7, 9, null) as string);
    expect(result.error).toContain('未找到 MCP 工具 fs.missing');
    expect(result.availableServers).toEqual(['fs', 'github']);
    expect(result.availableTools).toEqual(['read_file']);
  });

  it('refuses to execute in LOCAL sessions (dispatcher must restore first)', async () => {
    const { tool, clientManager } = makeTool({
      executionMode: 'LOCAL',
      local: [ref(0, 'fs', 'read_file')],
    });
    const result = JSON.parse(await tool.execute(JSON.stringify({ server: 'fs', tool: 'read_file' }), 7, 9, null) as string);
    expect(result.error).toContain('LOCAL 会话');
    expect(clientManager.callTool).not.toHaveBeenCalled();
  });

  it('requires a session id', async () => {
    const { tool } = makeTool({});
    const result = JSON.parse(await tool.execute(JSON.stringify({ server: 'fs', tool: 'read_file' })) as string);
    expect(result.error).toContain('需要会话上下文');
  });
});
