import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../../../common/business-exception.js';
import { McpSecretCipher } from '../crypto/mcp-secret-cipher.js';
import { GLOBAL_USER_ID, STATUS_DISABLED, STATUS_ENABLED, TYPE_HTTP, TYPE_STDIO, type McpServer } from '../entity/mcp-server.js';
import type { McpServerMapper } from '../mapper/mcp-server.mapper.js';
import type { UserMcpPreferenceService } from '../preference/service/user-mcp-preference.service.js';
import { McpServerService } from './mcp-server.service.js';

describe('McpServerService', () => {
  const mapper = {
    selectById: vi.fn(),
    insert: vi.fn().mockResolvedValue(1),
    countByUserIdAndName: vi.fn().mockResolvedValue(0),
    countByNameWhereUserIdNot: vi.fn().mockResolvedValue(0),
    updateById: vi.fn(),
    physicalDeleteById: vi.fn(),
    list: vi.fn(),
    listEnabledGlobal: vi.fn(),
    listMine: vi.fn(),
  } as unknown as McpServerMapper & Record<string, ReturnType<typeof vi.fn>>;
  const secretCipher = new McpSecretCipher('test-secret');
  const preferenceService = { deleteByServer: vi.fn() } as unknown as UserMcpPreferenceService;
  const service = new McpServerService(mapper, secretCipher, preferenceService);

  beforeEach(() => {
    vi.clearAllMocks();
    mapper.insert.mockResolvedValue(1);
    mapper.countByUserIdAndName.mockResolvedValue(0);
    mapper.countByNameWhereUserIdNot.mockResolvedValue(0);
  });

  function enabled(): McpServer {
    return {
      id: 1, userId: GLOBAL_USER_ID, name: 'filesystem', serverType: TYPE_STDIO,
      command: 'npx', argsJson: '["-y","@modelcontextprotocol/server-filesystem"]', status: STATUS_ENABLED,
    };
  }

  it('validateForAgentReturnsDeduplicatedExistingEnabledIdsInOrder', async () => {
    mapper.selectById.mockResolvedValue(enabled());
    expect(await service.validateForAgent([1, 1, 1])).toEqual([1]);
  });

  it('validateForAgentRejectsMissingServer', async () => {
    mapper.selectById.mockResolvedValue(null);
    await expect(service.validateForAgent([99])).rejects.toBeInstanceOf(BusinessException);
    await expect(service.validateForAgent([99])).rejects.toThrow(/不存在/);
  });

  it('validateForAgentRejectsDisabledServer', async () => {
    mapper.selectById.mockResolvedValue({ id: 2, userId: GLOBAL_USER_ID, name: 'old-server', status: STATUS_DISABLED });
    await expect(service.validateForAgent([2])).rejects.toThrow(/已停用/);
  });

  it('validateForAgentReturnsEmptyForNullOrEmpty', async () => {
    expect(await service.validateForAgent(null)).toEqual([]);
    expect(await service.validateForAgent([])).toEqual([]);
  });

  it('rejectsServerNameWithConsecutiveUnderscores', async () => {
    await expect(service.create('foo__bar', null, TYPE_STDIO, 'npx', ['-y', 'x'], null, null))
      .rejects.toThrow(/连续下划线/);
  });

  it('acceptsServerNameWithSingleUnderscore', async () => {
    const created = await service.create('foo_bar', null, TYPE_STDIO, 'npx', ['-y', 'x'], null, null);
    expect(created.name).toBe('foo_bar');
    expect(created.status).toBe(STATUS_ENABLED);
  });

  it('createStoresEncryptedEnvAndDecryptsRoundTrip', async () => {
    const created = await service.create(
      'github', null, TYPE_HTTP, null, null, 'https://mcp.example.com/github',
      { API_KEY: 'sk-secret-123' },
    );
    expect(created.envJson).toBeTruthy();
    expect(created.envJson).not.toContain('sk-secret-123');
    expect(service.decryptEnv(created).API_KEY).toBe('sk-secret-123');
  });

  it('validateForAgentRejectsUserOwnServer', async () => {
    mapper.selectById.mockResolvedValue({ id: 100, userId: 9, name: 'my-storage', status: STATUS_ENABLED });
    await expect(service.validateForAgent([100])).rejects.toThrow(/私有服务器/);
  });

  it('createMineAssignsOwnerAndRejectsNameConflictingWithGlobal', async () => {
    mapper.countByUserIdAndName.mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const mine = await service.createMine(9, 'my-storage', null, TYPE_HTTP, null, null, 'https://my.example.com', null);
    expect(mine.userId).toBe(9);
    expect(mine.status).toBe(STATUS_ENABLED);
    await expect(service.createMine(9, 'my-storage', null, TYPE_HTTP, null, null, 'https://my.example.com', null))
      .rejects.toThrow(/全局|其他 MCP 服务器/);
  });

  it('createGlobalRejectsNameConflictingWithUserOwnServer', async () => {
    mapper.countByUserIdAndName.mockResolvedValueOnce(0);
    mapper.countByNameWhereUserIdNot.mockResolvedValueOnce(1);
    await expect(service.create('foo', null, TYPE_HTTP, null, null, 'https://global.example.com', null))
      .rejects.toThrow(/其他 MCP 服务器/);
  });

  it('createMineAllowsSameNameForDifferentUsers', async () => {
    mapper.countByUserIdAndName.mockResolvedValue(0);
    mapper.countByNameWhereUserIdNot.mockResolvedValue(0);
    const a = await service.createMine(9, 'foo', null, TYPE_HTTP, null, null, 'https://a.example.com', null);
    const b = await service.createMine(10, 'foo', null, TYPE_HTTP, null, null, 'https://b.example.com', null);
    expect(a.userId).toBe(9);
    expect(b.userId).toBe(10);
  });

  it('lists get update status delete and decrypt', async () => {
    mapper.list.mockResolvedValue([{ id: 1, userId: 9, name: 'a', envJson: 'secret' }]);
    mapper.listEnabledGlobal.mockResolvedValue([{ id: 2, envJson: 'x' }]);
    mapper.listMine.mockResolvedValue([{ id: 3, envJson: 'y' }]);
    mapper.selectById.mockResolvedValue({
      id: 1, userId: GLOBAL_USER_ID, name: 'filesystem', serverType: TYPE_STDIO,
      command: 'npx', argsJson: '["-y","x"]', status: STATUS_ENABLED, envJson: 'enc',
    });
    expect((await service.list('fs', STATUS_ENABLED))[0].envJson).toBeNull();
    expect((await service.listEnabled())[0].envJson).toBeNull();
    expect(await service.listMine(null)).toEqual([]);
    expect((await service.listMine(9))[0].envJson).toBeNull();
    expect((await service.get(1)).envJson).toBeNull();
    mapper.selectById.mockResolvedValueOnce(null);
    await expect(service.get(99)).rejects.toBeInstanceOf(BusinessException);

    mapper.selectById.mockResolvedValue({
      id: 5, userId: 9, name: 'mine', serverType: TYPE_HTTP, url: 'https://m.example', status: STATUS_ENABLED,
    });
    expect((await service.getMine(9, 5)).name).toBe('mine');
    await expect(service.getMine(8, 5)).rejects.toThrow(/无权/);

    mapper.selectById.mockResolvedValue({
      id: 1, userId: GLOBAL_USER_ID, name: 'filesystem', serverType: TYPE_STDIO,
      command: 'npx', argsJson: '["-y","x"]', status: STATUS_ENABLED,
    });
    expect((await service.getForRuntime(1)).name).toBe('filesystem');
    await service.update(1, 'filesystem', 'desc', TYPE_STDIO, 'npx', ['-y', 'x'], null, { A: '1' });
    expect(mapper.updateById).toHaveBeenCalled();

    mapper.selectById.mockResolvedValue({ id: 5, userId: 9, name: 'mine', serverType: TYPE_HTTP, url: 'https://m.example' });
    await service.updateMine(9, 5, null, 'd', TYPE_HTTP, null, null, 'https://m.example/v2', null);
    mapper.selectById.mockResolvedValue({ id: 5, userId: 9, name: 'mine' });
    await expect(service.update(5, 'x', null, TYPE_HTTP, null, null, 'https://x.example', null)).rejects.toThrow(/无权编辑/);

    mapper.selectById.mockResolvedValue({ id: 1, userId: GLOBAL_USER_ID, name: 'filesystem' });
    await service.updateStatus(1, STATUS_DISABLED);
    await expect(service.updateStatus(1, 'BAD')).rejects.toThrow(/状态值不合法/);

    mapper.selectById.mockResolvedValue({ id: 1, userId: GLOBAL_USER_ID, name: 'filesystem' });
    await service.delete(1);
    expect(mapper.physicalDeleteById).toHaveBeenCalledWith(1);
    mapper.selectById.mockResolvedValue({ id: 5, userId: 9, name: 'mine' });
    await service.deleteMine(9, 5);
    mapper.selectById.mockResolvedValue({ id: 5, userId: 9, name: 'mine' });
    await expect(service.deleteMine(8, 5)).rejects.toThrow(/无权/);

    mapper.selectById.mockResolvedValue({ id: 1, userId: GLOBAL_USER_ID, name: 'filesystem', status: STATUS_ENABLED });
    await service.validatePreferenceTarget(7, 1);
    mapper.selectById.mockResolvedValue({ id: 5, userId: 9, name: 'mine', status: STATUS_ENABLED });
    await service.validatePreferenceTarget(9, 5);
    await expect(service.validatePreferenceTarget(8, 5)).rejects.toThrow(/无权/);

    expect(service.decryptEnv({ envJson: '' })).toEqual({});
    mapper.countByUserIdAndName.mockResolvedValue(0);
    mapper.countByNameWhereUserIdNot.mockResolvedValue(0);
    const created = await service.create('envsrv', null, TYPE_HTTP, null, null, 'https://e.example', { K: 'v' });
    expect(service.decryptEnv(created).K).toBe('v');
  });

  it('rejects invalid types and missing required fields', async () => {
    await expect(service.create('x', null, 'FOO', null, null, null, null)).rejects.toThrow(/STDIO 或 HTTP/);
    await expect(service.create('x', null, TYPE_STDIO, '', ['a'], null, null)).rejects.toThrow(/启动命令/);
    await expect(service.create('x', null, TYPE_STDIO, 'npx', [], null, null)).rejects.toThrow(/启动参数/);
    await expect(service.create('x', null, TYPE_HTTP, null, null, 'ftp://x', null)).rejects.toThrow(/http/);
    await expect(service.create('BadName', null, TYPE_HTTP, null, null, 'https://x', null)).rejects.toThrow(/小写字母/);
  });
});
