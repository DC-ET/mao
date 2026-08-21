import { describe, expect, it, vi } from 'vitest';
import {
  MysqlAgentExperienceRepository,
  MysqlAgentRepository,
} from './agent.repository.js';
import { MysqlUserRepository } from '../user/user.repository.js';
import { MysqlLlmModelRepository } from '../model/model.repository.js';
import {
  MysqlPermissionRepository,
  MysqlRolePermissionRepository,
  MysqlRoleRepository,
  MysqlUserRoleRepository,
} from '../permission/permission.repository.js';

function mockDb(queryOne: unknown = { id: 1 }, query: unknown[] = [{ id: 1 }]) {
  return {
    query: vi.fn(async () => query),
    queryOne: vi.fn(async () => queryOne),
    execute: vi.fn(async () => ({ affectedRows: 1, insertId: 1 })),
    insert: vi.fn(async () => 5),
    updateById: vi.fn(async () => undefined),
  };
}

describe('MysqlAgentRepository', () => {
  it('covers list find insert update delete and experiences', async () => {
    const db = mockDb();
    const repo = new MysqlAgentRepository(db as never);
    await repo.selectList();
    await repo.selectList('coder');
    await repo.findById(1);
    await repo.selectById(1);
    expect(await repo.findByIds([])).toEqual([]);
    await repo.findByIds([1, 2]);
    await repo.findDefault();
    const agent = { name: 'a', systemPrompt: 'p' };
    expect(await repo.insert(agent as never)).toBe(5);
    await repo.updateById({ id: 5, name: 'a', systemPrompt: 'p' } as never);
    await repo.updateById({ name: 'a', systemPrompt: 'p' } as never);
    await repo.deleteById(5);
    await repo.clearDefaultFlag();

    const exp = new MysqlAgentExperienceRepository(db as never);
    await exp.listByAgentId(1);
    await exp.listEnabledByAgentId(1);
    await exp.findById(1);
    await exp.insert({ agentId: 1, content: 'c' });
    await exp.updateById({ id: 1, agentId: 1, content: 'c' });
    await exp.deleteById(1);
    await exp.deleteByAgentId(1);
  });
});

describe('MysqlUserRepository', () => {
  it('covers lookups insert update and paging', async () => {
    const db = mockDb({ cnt: 2 }, [{ id: 1, username: 'a' }]);
    const repo = new MysqlUserRepository(db as never);
    await repo.findById(1);
    expect(await repo.findByIds([])).toEqual([]);
    await repo.findByIds([1]);
    await repo.listOptions();
    await repo.findByUsername('a');
    await repo.findByEmail('a@b.c');
    await repo.findByFeishuUserId('f');
    expect(await repo.countByUsername('a')).toBe(2);
    expect(await repo.countByEmailExcept('a@b.c', 1)).toBe(2);
    const user = { username: 'a' };
    expect(await repo.insert(user)).toBe(5);
    await repo.updateById({ id: 5, username: 'a' });
    await repo.updateById({ username: 'a' });
    await repo.updateFields(5, { status: 0 });
    await repo.selectPage(1, 20);
    await repo.selectPage(1, 20, 'ada', 1);
  });
});

describe('MysqlLlmModelRepository', () => {
  it('covers filtered paging and crud', async () => {
    const db = mockDb({ cnt: 1 }, [{ id: 1, name: 'm' }]);
    const repo = new MysqlLlmModelRepository(db as never);
    await repo.selectPage(1, 10, {});
    await repo.selectPage(1, 10, {
      keyword: 'gpt', provider: 'openai', status: 1, supportsVision: 1, isDefault: 1, modelType: 'chat',
    });
    await repo.findById(1);
    await repo.selectById(1);
    expect(await repo.findByIds([])).toEqual([]);
    await repo.findByIds([1]);
    await repo.findDefault();
    await repo.selectDefault();
    await repo.listProviders();
    await repo.listActiveText();
    await repo.findFirstActiveByType('text');
    await repo.countActiveExcept(1);
    const model = { name: 'm', provider: 'openai', modelId: 'g' };
    await repo.insert(model as never);
    await repo.updateById({ id: 1, ...model } as never);
    await repo.updateById(model as never);
    await repo.deleteById(1);
    await repo.clearDefaultFlag();
    const sessionModels = new (await import('../model/model.repository.js')).MysqlSessionModelRepository(db as never);
    await sessionModels.reassignModelId(1, 2);
  });
});

describe('permission repositories', () => {
  it('covers role permission and user-role mappers', async () => {
    const db = mockDb({ cnt: 1 }, [{ id: 1 }]);
    const roles = new MysqlRoleRepository(db as never);
    await roles.findById(1);
    await roles.findByCode('ADMIN');
    await roles.findAll();
    expect(await roles.findByIds([])).toEqual([]);
    await roles.findByIds([1, 2]);
    await roles.insert({ name: 'r', code: 'R' });
    await roles.updateById({ id: 1, name: 'r', code: 'R' });

    const perms = new MysqlPermissionRepository(db as never);
    await perms.findAll();
    await perms.findByIds([1]);
    expect(await perms.findByIds([])).toEqual([]);
    await perms.countByIdsAndCode([1], 'user:read');
    expect(await perms.countByIdsAndCode([], 'x')).toBe(0);

    const rp = new MysqlRolePermissionRepository(db as never);
    await rp.findByRoleId(1);
    await rp.findByRoleIds([1]);
    expect(await rp.findByRoleIds([])).toEqual([]);
    await rp.deleteByRoleId(1);
    await rp.insert({ roleId: 1, permissionId: 2 });

    const ur = new MysqlUserRoleRepository(db as never);
    await ur.findByUserId(1);
    await ur.findByUserIds([1]);
    expect(await ur.findByUserIds([])).toEqual([]);
    await ur.findByRoleId(1);
    await ur.countByRoleId(1);
    await ur.countByUserAndRole(1, 2);
    await ur.deleteByUserId(1);
    await ur.insert({ userId: 1, roleId: 2 });
  });
});
