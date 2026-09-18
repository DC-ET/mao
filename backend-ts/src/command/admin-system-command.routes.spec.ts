import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerAdminSystemCommandRoutes } from './admin-system-command.routes.js';
import type { UserCommand, UserCommandRepository } from './types.js';

function createRepo(overrides: Partial<UserCommandRepository> = {}): UserCommandRepository {
  return {
    listByUserId: vi.fn(async () => []),
    listPersonalAll: vi.fn(async () => []),
    findByIdAndUserId: vi.fn(async () => null),
    findByUserIdAndName: vi.fn(async () => null),
    insert: vi.fn(async (c) => {
      c.id = 100;
      return 100;
    }),
    updateById: vi.fn(async () => undefined),
    deleteById: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function createApp(options: {
  admin?: boolean;
  commandRepo?: UserCommandRepository;
  commands?: {
    system?: UserCommand[];
    personal?: UserCommand[];
    findByIdAndUserId?: (id: number, userId: number) => UserCommand | null;
  };
}) {
  const system = options.commands?.system ?? [];
  const personal = options.commands?.personal ?? [];
  const commandRepo = options.commandRepo ?? createRepo({
    listByUserId: vi.fn(async (userId: number) => (userId === 0 ? system : [])),
    listPersonalAll: vi.fn(async () => personal),
    findByIdAndUserId: vi.fn(async (id: number, userId: number) => {
      if (options.commands?.findByIdAndUserId) {
        return options.commands.findByIdAndUserId(id, userId);
      }
      return [...system, ...personal].find((c) => c.id === id && c.userId === userId) ?? null;
    }),
  });

  const app = Fastify();
  app.setErrorHandler(handleError);
  app.addHook('preHandler', (req, _r, done) => {
    req.userId = 9;
    done();
  });
  registerAdminSystemCommandRoutes(app, {
    commandRepo,
    permissionService: { isAdmin: vi.fn(async () => options.admin !== false) },
    userLookup: {
      findByIds: vi.fn(async (ids: number[]) => ids.map((id) => ({
        id,
        username: `user${id}`,
        displayName: `用户${id}`,
      }))),
    },
  });
  return { app, commandRepo };
}

describe('admin system/user command routes', () => {
  it('listsSystemCommandsAndManagesCrud', async () => {
    const system: UserCommand[] = [{
      id: 1,
      userId: 0,
      name: 'code_review',
      content: '审查代码',
      createdAt: '2026-01-01 10:00:00',
    }];
    const { app, commandRepo } = await createApp({
      commands: { system },
    });

    const list = JSON.parse((await app.inject({ method: 'GET', url: '/v1/admin/system-commands' })).body);
    expect(list.code).toBe(0);
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({ id: 1, name: 'code_review', content: '审查代码', userId: 0 });

    const created = JSON.parse((await app.inject({
      method: 'POST',
      url: '/v1/admin/system-commands',
      payload: { name: 'plan', content: '写方案' },
    })).body);
    expect(created.code).toBe(0);
    expect(created.data.id).toBe(100);
    expect(commandRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ userId: 0, name: 'plan' }));

    const badName = JSON.parse((await app.inject({
      method: 'POST',
      url: '/v1/admin/system-commands',
      payload: { name: 'bad name', content: 'x' },
    })).body);
    expect(badName.code).toBeGreaterThan(0);

    await app.close();
  });

  it('listsPersonalCommandsWithUserAndDeletesThem', async () => {
    const personal: UserCommand[] = [{
      id: 21,
      userId: 7,
      name: 'my_cmd',
      content: '个人指令内容',
      createdAt: '2026-02-02 11:00:00',
    }];
    const { app, commandRepo } = await createApp({
      commands: { personal },
    });

    const list = JSON.parse((await app.inject({ method: 'GET', url: '/v1/admin/user-commands' })).body);
    expect(list.code).toBe(0);
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({
      id: 21,
      userId: 7,
      name: 'my_cmd',
      username: 'user7',
      displayName: '用户7',
    });

    const detail = JSON.parse((await app.inject({
      method: 'GET',
      url: '/v1/admin/user-commands/7/21',
    })).body);
    expect(detail.code).toBe(0);
    expect(detail.data.name).toBe('my_cmd');

    const deleted = JSON.parse((await app.inject({
      method: 'DELETE',
      url: '/v1/admin/user-commands/7/21',
    })).body);
    expect(deleted.code).toBe(0);
    expect(commandRepo.deleteById).toHaveBeenCalledWith(21);

    const missing = JSON.parse((await app.inject({
      method: 'DELETE',
      url: '/v1/admin/user-commands/7/999',
    })).body);
    expect(missing.code).toBe(404);

    const invalidUser = JSON.parse((await app.inject({
      method: 'GET',
      url: '/v1/admin/user-commands/0/21',
    })).body);
    expect(invalidUser.code).toBe(400);

    await app.close();
  });

  it('rejectsNonAdminAccess', async () => {
    const { app } = await createApp({ admin: false });
    const res = JSON.parse((await app.inject({ method: 'GET', url: '/v1/admin/user-commands' })).body);
    expect(res.code).toBe(1002);
    await app.close();
  });
});
