import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MCP_LOAD_MODE, McpLoadModeResolver, parseMcpLoadMode, toApiMcpLoadMode,
} from './mcp-load-mode.js';

function resolverWith(options: {
  userMode?: 'working_set' | 'full' | null;
  globalValue?: string | null;
  userThrows?: boolean;
  globalThrows?: boolean;
  now?: () => number;
}) {
  const getUser = vi.fn(async () => {
    if (options.userThrows) throw new Error('db down');
    return options.userMode ?? null;
  });
  const getValue = vi.fn(async () => {
    if (options.globalThrows) throw new Error('db down');
    return options.globalValue ?? null;
  });
  const resolver = new McpLoadModeResolver({
    userLoadMode: { get: getUser },
    systemSettingService: { getValue },
    now: options.now,
  });
  return { resolver, getUser, getValue };
}

describe('parseMcpLoadMode', () => {
  it('accepts DB / API spellings case-insensitively', () => {
    expect(parseMcpLoadMode('WORKING_SET')).toBe('working_set');
    expect(parseMcpLoadMode('working_set')).toBe('working_set');
    expect(parseMcpLoadMode('FULL')).toBe('full');
    expect(parseMcpLoadMode(' full ')).toBe('full');
  });

  it('returns null for empty / unknown values', () => {
    expect(parseMcpLoadMode(null)).toBeNull();
    expect(parseMcpLoadMode('')).toBeNull();
    expect(parseMcpLoadMode('FULL_INJECTION')).toBeNull();
  });

  it('maps internal values back to the API spelling', () => {
    expect(toApiMcpLoadMode('working_set')).toBe('WORKING_SET');
    expect(toApiMcpLoadMode('full')).toBe('FULL');
  });
});

describe('McpLoadModeResolver', () => {
  it('prefers user preference over global default', async () => {
    const { resolver, getValue } = resolverWith({ userMode: 'full', globalValue: 'working_set' });
    expect(await resolver.resolve(7)).toBe('full');
    expect(getValue).not.toHaveBeenCalled();
  });

  it('falls back to the global default when the user has no row', async () => {
    const { resolver } = resolverWith({ userMode: null, globalValue: 'full' });
    expect(await resolver.resolve(7)).toBe('full');
  });

  it('falls back to working_set when nothing is configured', async () => {
    const { resolver } = resolverWith({ userMode: null, globalValue: null });
    expect(await resolver.resolve(7)).toBe(DEFAULT_MCP_LOAD_MODE);
  });

  it('treats an invalid global value as working_set', async () => {
    const { resolver } = resolverWith({ userMode: null, globalValue: 'nonsense' });
    expect(await resolver.resolve(7)).toBe('working_set');
  });

  it('degrades to working_set when the database throws', async () => {
    const { resolver } = resolverWith({ userThrows: true });
    expect(await resolver.resolve(7)).toBe('working_set');
  });

  it('caches within the TTL and re-reads after it expires', async () => {
    let now = 1_000;
    const { resolver, getUser } = resolverWith({ userMode: 'working_set', now: () => now });
    await resolver.resolve(7);
    await resolver.resolve(7);
    expect(getUser).toHaveBeenCalledTimes(1);
    now += 5_001;
    await resolver.resolve(7);
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it('invalidates a single user without flushing other users', async () => {
    const { resolver, getUser } = resolverWith({ userMode: 'working_set' });
    await resolver.resolve(7);
    await resolver.resolve(8);
    resolver.invalidate(7);
    await resolver.resolve(7);
    expect(getUser).toHaveBeenCalledTimes(3);
  });
});
