import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { ErrorCode } from '../common/error-code.js';
import { BusinessException } from '../common/business-exception.js';
import { registerQuickCommandRoutes } from './command.routes.js';
import { registerPermissionRoutes } from '../permission/permission.routes.js';

function authedApp(userId = 7) {
  const app = Fastify();
  app.setErrorHandler(handleError);
  app.addHook('preHandler', (req, _r, done) => {
    (req as { userId?: number }).userId = userId;
    done();
  });
  return app;
}

describe('GET /v1/quick-commands skill filter', () => {
  function mount(resolveSystemSkillNames = vi.fn(async () => ['java', 'bigdata'])) {
    const app = authedApp();
    registerQuickCommandRoutes(app, {
      userCommandService: { listAvailableForUser: async () => [] },
      agentService: { getAgent: vi.fn(async (id: number) => ({ id, skillNames: '["java"]' })) },
      skillLoader: {
        getAllDocuments: () => [
          { name: 'java', description: '系统 java' },
          { name: 'python', description: '系统 python' },
          { name: 'bigdata', description: '系统数仓' },
        ],
      },
      skillSyncService: {
        getUserSkillDocuments: async () => [{ name: 'mine', description: '个人' }, { name: 'java', description: '个人 java' }],
        resolveSystemSkillNames,
      },
    } as never);
    return { app, resolveSystemSkillNames };
  }

  it('带 agentId 时只列出该用户的系统名单，个人技能仍在且盖过同名描述', async () => {
    const { app, resolveSystemSkillNames } = mount();
    const body = JSON.parse((await app.inject({ method: 'GET', url: '/v1/quick-commands?agentId=4' })).body);
    expect(body.code).toBe(0);
    expect(body.data.skills.map((item: { name: string }) => item.name)).toEqual(['bigdata', 'mine', 'java']);
    expect(body.data.skills.find((item: { name: string }) => item.name === 'java').description).toBe('个人 java');
    expect(resolveSystemSkillNames).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }), 7);
    await app.close();
  });

  it('解析结果为空时不列出系统技能；不带 agentId 时仍列出全部', async () => {
    const empty = mount(vi.fn(async () => []));
    const filtered = JSON.parse((await empty.app.inject({ method: 'GET', url: '/v1/quick-commands?agentId=4' })).body);
    expect(filtered.data.skills.map((item: { name: string }) => item.name)).toEqual(['mine', 'java']);
    await empty.app.close();

    const open = mount();
    const all = JSON.parse((await open.app.inject({ method: 'GET', url: '/v1/quick-commands' })).body);
    expect(all.data.skills.map((item: { name: string }) => item.name)).toEqual(['python', 'bigdata', 'mine', 'java']);
    await open.app.close();
  });
});

describe('role skill grant routes', () => {
  it('没有 role:write 时不写授权', async () => {
    const app = authedApp();
    const replaceForRole = vi.fn();
    registerPermissionRoutes(app, {
      hasPermission: async (_userId: number, code: string) => code === 'role:read',
    } as never, {
      listForRole: vi.fn(async () => []),
      listAll: vi.fn(async () => []),
      replaceForRole,
    } as never);
    const denied = await app.inject({
      method: 'PUT', url: '/v1/roles/3/skills', payload: { grants: [] },
    });
    expect(denied.statusCode).toBe(403);
    expect(replaceForRole).not.toHaveBeenCalled();
    await app.close();
  });

  it('角色不存在时返回 ROLE_NOT_FOUND 且不写表', async () => {
    const app = authedApp();
    const replaceForRole = vi.fn(async () => {
      throw new BusinessException(ErrorCode.ROLE_NOT_FOUND);
    });
    registerPermissionRoutes(app, {
      hasPermission: async () => true,
    } as never, { replaceForRole, listForRole: vi.fn(), listAll: vi.fn() } as never);
    const missing = JSON.parse((await app.inject({
      method: 'PUT', url: '/v1/roles/9/skills', payload: { grants: [] },
    })).body);
    expect(missing.code).toBe(ErrorCode.ROLE_NOT_FOUND.code);
    expect(replaceForRole).toHaveBeenCalledWith(9, []);
    await app.close();
  });
});
