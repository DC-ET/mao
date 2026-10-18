import { describe, expect, it, vi } from 'vitest';
import { McpDescribeTool } from './mcp-describe-tool.js';
import type { McpToolRef } from '../../entity/mcp-server.js';

function ref(serverId: number, serverName: string, toolName: string): McpToolRef {
  return {
    serverId,
    serverName,
    toolName,
    description: `${toolName} desc`,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  };
}

function makeTool(options: { executionMode?: string; cloud?: McpToolRef[]; local?: McpToolRef[] }) {
  const sessionMapper = { selectById: vi.fn(async () => ({ executionMode: options.executionMode ?? 'CLOUD' })) };
  const toolsRegistry = {
    getCloudSnapshot: vi.fn(() => options.cloud ?? []),
    getSessionTools: vi.fn(() => options.local ?? []),
  };
  return {
    toolsRegistry,
    tool: new McpDescribeTool({ sessionMapper: sessionMapper as never, toolsRegistry }),
  };
}

describe('McpDescribeTool', () => {
  it('returns the cached schema from the CLOUD snapshot', async () => {
    const { tool, toolsRegistry } = makeTool({ cloud: [ref(11, 'fs', 'read_file')] });
    const result = JSON.parse(await tool.execute(JSON.stringify({ server: 'fs', tool: 'read_file' }), 7, 9, null) as string);
    expect(result).toEqual({
      server: 'fs',
      tool: 'read_file',
      description: 'read_file desc',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    });
    expect(toolsRegistry.getSessionTools).not.toHaveBeenCalled();
  });

  it('reads the LOCAL report list for LOCAL sessions', async () => {
    const { tool, toolsRegistry } = makeTool({
      executionMode: 'LOCAL',
      local: [ref(0, 'fs', 'read_file')],
    });
    const result = JSON.parse(await tool.execute(JSON.stringify({ server: 'fs', tool: 'read_file' }), 7, 9, null) as string);
    expect(result.tool).toBe('read_file');
    expect(toolsRegistry.getSessionTools).toHaveBeenCalledWith(7);
    expect(toolsRegistry.getCloudSnapshot).not.toHaveBeenCalled();
  });

  it('lists available tools when the target is unknown', async () => {
    const { tool } = makeTool({ local: [ref(0, 'fs', 'read_file')], executionMode: 'LOCAL' });
    const result = JSON.parse(await tool.execute(JSON.stringify({ server: 'fs', tool: 'nope' }), 7, 9, null) as string);
    expect(result.error).toContain('未找到 MCP 工具 fs.nope');
    expect(result.availableTools).toEqual(['read_file']);
  });

  it('distinguishes an empty tool list from an unknown tool', async () => {
    const { tool } = makeTool({ local: [], executionMode: 'LOCAL' });
    const result = JSON.parse(await tool.execute(JSON.stringify({ server: 'fs', tool: 'read_file' }), 7, 9, null) as string);
    expect(result.error).toContain('没有可用的 MCP 工具');
  });

  it('rejects malformed arguments', async () => {
    const { tool } = makeTool({});
    expect(JSON.parse(await tool.execute('[]', 7, 9, null) as string).error).toContain('必须是 JSON 对象');
    expect(JSON.parse(await tool.execute('', 7, 9, null) as string).error).toContain('不能为空');
  });
});
