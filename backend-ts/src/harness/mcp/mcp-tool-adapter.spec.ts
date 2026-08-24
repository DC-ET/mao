import { describe, expect, it, vi } from 'vitest';
import { McpToolAdapter } from './mcp-tool-adapter.js';
import type { McpClientManager } from './mcp-client-manager.js';
import type { McpToolRef } from './entity/mcp-server.js';

const ref: McpToolRef = {
  serverId: 42,
  serverName: 'filesystem',
  toolName: 'read_file',
  description: '读取文件内容',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
};

describe('McpToolAdapter', () => {
  it('exposesNamespacedToolName', () => {
    const adapter = new McpToolAdapter(ref, null);
    expect(adapter.getName()).toBe('mcp__filesystem__read_file');
  });

  it('passesThroughDescriptionAndInputSchema', () => {
    const adapter = new McpToolAdapter(ref, null);
    expect(adapter.getDescription()).toBe('读取文件内容');
    expect(adapter.getInputSchema()).toMatchObject({ type: 'object' });
    expect(adapter.getInputSchema().properties).toBeTruthy();
  });

  it('normalizesNullJsonSchemaTypeForStrictProviders', () => {
    const adapter = new McpToolAdapter({
      ...ref,
      inputSchema: { type: null, properties: { q: { type: null } } } as never,
    }, null);
    const schema = adapter.getInputSchema();
    expect(schema.type).toBe('object');
    expect((schema.properties as Record<string, { type: string }>).q.type).toBe('string');
  });

  it('readsLegacySchemaFieldFromLocalWsReport', () => {
    const adapter = new McpToolAdapter({
      serverId: 1,
      serverName: 'baidu_map',
      toolName: 'map_geocode',
      description: 'geocode',
      schema: { type: null, properties: { address: { type: 'string' } } },
    } as never, null);
    expect(adapter.getInputSchema().type).toBe('object');
  });

  it('flattensRootAnyOfForProvidersThatRejectTopLevelCombinators', () => {
    const adapter = new McpToolAdapter({
      ...ref,
      inputSchema: {
        anyOf: [
          { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
        ],
      },
    }, null);
    const schema = adapter.getInputSchema();
    expect(schema).not.toHaveProperty('anyOf');
    expect(schema.type).toBe('object');
    expect(schema.properties).toMatchObject({ path: { type: 'string' }, url: { type: 'string' } });
    expect(schema.required).toBeUndefined();
  });

  it('mergesRootAllOfRequiredProperties', () => {
    const adapter = new McpToolAdapter({
      ...ref,
      inputSchema: {
        allOf: [
          { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          { type: 'object', properties: { mode: { type: 'string' } }, required: ['mode'] },
        ],
      },
    }, null);
    const schema = adapter.getInputSchema();
    expect(schema).not.toHaveProperty('allOf');
    expect(schema.required).toEqual(['path', 'mode']);
  });

  it('delegatesExecutionToClientManagerWithSessionAndWorkspace', async () => {
    const clientManager = { callTool: vi.fn().mockResolvedValue('{"result":"content"}') } as unknown as McpClientManager;
    const adapter = new McpToolAdapter(ref, clientManager);
    const result = await adapter.execute('{"path":"/tmp/a.txt"}', 7, 9, '/workspace');
    expect(result).toBe('{"result":"content"}');
    expect(clientManager.callTool).toHaveBeenCalledWith(7, 42, 'read_file', '{"path":"/tmp/a.txt"}');
  });

  it('returnsErrorWhenNoClientManagerConfigured', async () => {
    const adapter = new McpToolAdapter(ref, null);
    const result = await adapter.execute('{}', 7, 9, null);
    expect(result).toContain('"error"');
    expect(result).toContain('LOCAL');
  });

  it('shortExecuteOverloadsFallThroughToFullSignature', async () => {
    const clientManager = { callTool: vi.fn().mockResolvedValue('ok') } as unknown as McpClientManager;
    const adapter = new McpToolAdapter(ref, clientManager);
    expect(await adapter.execute('{}')).toBe('ok');
    expect(await adapter.execute('{}', null)).toBe('ok');
    expect(await adapter.execute('{}', null, null)).toBe('ok');
  });
});
