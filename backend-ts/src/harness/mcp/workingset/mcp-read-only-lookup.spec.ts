import { describe, expect, it, vi } from 'vitest';
import { createMcpReadOnlyLookup } from './mcp-read-only-lookup.js';

function build(options: {
  mode?: 'working_set' | 'full';
  refs?: Array<{ serverName: string; toolName: string; readOnly?: boolean }>;
  userId?: number;
  sessionMissing?: boolean;
  resolveThrows?: boolean;
}) {
  const sessionMapper = {
    selectById: vi.fn(async () => (options.sessionMissing ? null : { id: 10, userId: options.userId ?? 7 })),
  };
  const loadModeResolver = {
    resolve: vi.fn(async () => {
      if (options.resolveThrows) throw new Error('db down');
      return options.mode ?? 'working_set';
    }),
  };
  const toolsRegistry = {
    getSessionTools: vi.fn(() => (options.refs ?? []).map((ref) => ({
      serverId: 5,
      serverName: ref.serverName,
      toolName: ref.toolName,
      description: '',
      inputSchema: {},
      annotations: ref.readOnly === true ? { readOnlyHint: true } : null,
    }))),
    getCloudSnapshot: vi.fn(() => []),
  };
  return {
    sessionMapper,
    loadModeResolver,
    toolsRegistry,
    lookup: createMcpReadOnlyLookup({ sessionMapper, loadModeResolver, toolsRegistry }),
  };
}

describe('createMcpReadOnlyLookup', () => {
  it('returns true only for an explicitly read-only tool in working set mode', async () => {
    const { lookup } = build({
      mode: 'working_set',
      refs: [{ serverName: 'fs', toolName: 'read_file', readOnly: true }],
    });
    await expect(lookup(10, 'mcp__fs__read_file')).resolves.toBe(true);
  });

  it('never relaxes approval in full injection mode (old behavior preserved)', async () => {
    const { lookup } = build({
      mode: 'full',
      refs: [{ serverName: 'fs', toolName: 'read_file', readOnly: true }],
    });
    await expect(lookup(10, 'mcp__fs__read_file')).resolves.toBe(false);
  });

  it('returns false for unannotated tools even in working set mode', async () => {
    const { lookup } = build({
      mode: 'working_set',
      refs: [{ serverName: 'fs', toolName: 'write_file' }],
    });
    await expect(lookup(10, 'mcp__fs__write_file')).resolves.toBe(false);
  });

  it('returns false when the session is unknown or the mode lookup fails', async () => {
    const missing = build({ sessionMissing: true, refs: [{ serverName: 'fs', toolName: 'read_file', readOnly: true }] });
    await expect(missing.lookup(10, 'mcp__fs__read_file')).resolves.toBe(false);
    const failing = build({ resolveThrows: true, refs: [{ serverName: 'fs', toolName: 'read_file', readOnly: true }] });
    await expect(failing.lookup(10, 'mcp__fs__read_file')).resolves.toBe(false);
    const anonymous = build({ refs: [{ serverName: 'fs', toolName: 'read_file', readOnly: true }] });
    await expect(anonymous.lookup(null, 'mcp__fs__read_file')).resolves.toBe(false);
  });
});
