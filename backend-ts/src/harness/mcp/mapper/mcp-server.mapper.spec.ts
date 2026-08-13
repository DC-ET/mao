import { describe, expect, it, vi } from 'vitest';
import { McpServerMapper, UserMcpPreferenceMapper } from './mcp-server.mapper.js';

function mockDb() {
  return {
    query: vi.fn(async () => [{ id: 1 }]),
    queryOne: vi.fn(async () => ({ cnt: 2, id: 1 })),
    execute: vi.fn(async () => ({ affectedRows: 1 })),
    insert: vi.fn(async () => 8),
    updateById: vi.fn(),
  };
}

describe('McpServerMapper', () => {
  it('covers list insert update delete and counts', async () => {
    const db = mockDb();
    const mapper = new McpServerMapper(db as never);
    await mapper.list();
    await mapper.list('search', 'ENABLED');
    await mapper.listEnabledGlobal();
    await mapper.listMine(7);
    await mapper.selectById(1);
    await mapper.selectByName('n', 0);
    await mapper.selectOneByName('n');
    await mapper.insert({ name: 'n', serverType: 'stdio' } as never);
    await mapper.updateById(1, { name: 'n2' });
    await mapper.logicalDelete(1);
    await mapper.physicalDeleteById(1);
    expect(await mapper.countByUserIdAndName(0, 'n')).toBe(2);
    expect(await mapper.countByNameWhereUserIdNot('n', 0)).toBe(2);

    const pref = new UserMcpPreferenceMapper(db as never);
    await pref.listDisabledServerIds(7);
    await pref.get(7, 1);
    await pref.listByUser(7);
    await pref.insert({ userId: 7, serverId: 1, enabled: 0 });
    await pref.updateById(1, { enabled: 1 });
  });
});
