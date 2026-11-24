import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerCommandRoutes } from './command.routes.js';

function createApp(service: Record<string, ReturnType<typeof vi.fn>>) {
  const app = Fastify();
  app.setErrorHandler(handleError);
  app.addHook('preHandler', (req, _r, done) => {
    req.userId = 9;
    done();
  });
  registerCommandRoutes(app, {
    userCommandService: service as never,
    agentService: { getAgent: vi.fn(async () => ({ id: 1, skillNames: null })) } as never,
    skillLoader: { getAllDocuments: () => [] } as never,
    skillSyncService: { getUserSkillDocuments: async () => [] } as never,
  });
  return app;
}

describe('user command visibility routes', () => {
  it('returns only the system commands visible to the caller', async () => {
    const service = {
      listVisibleSystemForUser: vi.fn(async () => [{ id: 1, name: 'review', content: '全局' }]),
      listByUserId: vi.fn(async () => {
        throw new Error('system tab must not list every system command');
      }),
      listAvailableForUser: vi.fn(async () => [{ id: 1, name: 'review', content: '全局' }]),
    };
    const app = createApp(service);
    const body = JSON.parse((await app.inject({ method: 'GET', url: '/v1/user-commands/system' })).body);
    expect(body.code).toBe(0);
    expect(body.data).toEqual([{ id: 1, name: 'review', content: '全局' }]);
    expect(service.listVisibleSystemForUser).toHaveBeenCalledWith(9);
    expect(body.data).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'warehouse' })]));

    const quick = JSON.parse((await app.inject({ method: 'GET', url: '/v1/quick-commands' })).body);
    expect(quick.data.commands.map((item: { name: string }) => item.name)).toEqual(['review']);
    expect(service.listAvailableForUser).toHaveBeenCalledWith(9);
    await app.close();
  });

  it('rejects the system command list without a user', async () => {
    const app = Fastify();
    app.setErrorHandler(handleError);
    registerCommandRoutes(app, {
      userCommandService: { listVisibleSystemForUser: vi.fn() } as never,
    });
    const body = JSON.parse((await app.inject({ method: 'GET', url: '/v1/user-commands/system' })).body);
    expect(body.code).toBe(1001);
    await app.close();
  });
});
