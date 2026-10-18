import { describe, expect, it } from 'vitest';
import { buildMcpWorkingSet } from './mcp-working-set.js';
import type { McpServer, McpToolRef } from '../entity/mcp-server.js';

function server(id: number, name: string, description: string | null = null): McpServer {
  return { id, name, description };
}

function tool(
  serverId: number,
  serverName: string,
  toolName: string,
  readOnly?: boolean,
): McpToolRef {
  return {
    serverId,
    serverName,
    toolName,
    description: '',
    inputSchema: { type: 'object', properties: {} },
    annotations: readOnly === true ? { readOnlyHint: true } : null,
  };
}

describe('buildMcpWorkingSet', () => {
  it('sorts servers and tools deterministically across input orders', () => {
    const servers = [server(2, 'github'), server(1, 'filesystem')];
    const tools = [
      tool(1, 'filesystem', 'write_file'),
      tool(2, 'github', 'list_issues'),
      tool(1, 'filesystem', 'read_file'),
    ];
    const first = buildMcpWorkingSet(servers, tools);
    const second = buildMcpWorkingSet([...servers].reverse(), [...tools].reverse());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.servers.map((s) => s.name)).toEqual(['filesystem', 'github']);
    expect(first.servers[0].tools.map((t) => t.name)).toEqual(['read_file', 'write_file']);
  });

  it('marks readOnlyHint tools and counts annotated tools only', () => {
    const result = buildMcpWorkingSet(
      [server(1, 'fs')],
      [tool(1, 'fs', 'read_file', true), tool(1, 'fs', 'write_file'), tool(1, 'fs', 'move_file')],
    );
    const fs = result.servers[0];
    expect(fs.tools.find((t) => t.name === 'read_file')?.readOnly).toBe(true);
    expect(fs.tools.find((t) => t.name === 'write_file')?.readOnly).toBe(false);
    expect(fs.readOnlyCount).toBe(1);
    expect(fs.writeCount).toBe(2);
    expect(fs.hasAnnotations).toBe(true);
  });

  it('does not claim annotation counts when the server returns no annotations', () => {
    const result = buildMcpWorkingSet([server(1, 'fs')], [tool(1, 'fs', 'read_file')]);
    expect(result.servers[0].hasAnnotations).toBe(false);
    expect(result.servers[0].readOnlyCount).toBe(0);
  });

  it('keeps failed servers listed with a reason', () => {
    const result = buildMcpWorkingSet(
      [server(1, 'fs'), server(2, 'github')],
      [tool(1, 'fs', 'read_file')],
      [{ serverId: 2, serverName: 'github', reason: '连接超时' }],
    );
    expect(result.servers.map((s) => s.name)).toEqual(['fs', 'github']);
    expect(result.servers[0].unavailableReason).toBeNull();
    expect(result.servers[1].unavailableReason).toBe('连接超时');
  });

  it('matches failure by server name when serverId is missing (LOCAL report)', () => {
    const result = buildMcpWorkingSet(
      [{ id: undefined, name: 'fs' }],
      [tool(0, 'fs', 'read_file')],
      [{ serverId: null, serverName: 'fs', reason: '连接失败' }],
    );
    expect(result.servers[0].unavailableReason).toBe('连接失败');
  });

  it('dedupes repeated tools and drops empty names', () => {
    const result = buildMcpWorkingSet(
      [server(1, 'fs')],
      [tool(1, 'fs', 'read_file'), tool(1, 'fs', 'read_file'), tool(1, 'fs', '  ')],
    );
    expect(result.servers[0].tools.map((t) => t.name)).toEqual(['read_file']);
  });

  it('returns an empty structure for no servers (no section rendered)', () => {
    expect(buildMcpWorkingSet([], [tool(1, 'fs', 'read_file')]).servers).toEqual([]);
  });
});
