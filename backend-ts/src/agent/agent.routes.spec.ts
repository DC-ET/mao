import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerAgentRoutes } from './agent.routes.js';
import { registerModelRoutes } from '../model/model.routes.js';
import { registerCommandRoutes } from '../command/command.routes.js';
import { registerUserRoutes } from '../user/user.routes.js';
import { registerAdminAnalyticsRoutes, registerAdminRuntimeRoutes } from '../admin/admin.routes.js';
import { registerMcpServerRoutes } from '../harness/mcp/controller/mcp-server.routes.js';

async function appWithUser(register: (app: ReturnType<typeof Fastify>) => void) {
  const fastify = Fastify();
  fastify.setErrorHandler(handleError);
  fastify.addHook('preHandler', (req, _r, done) => {
    req.userId = 7;
    done();
  });
  register(fastify);
  return fastify;
}

describe('CRUD routes', () => {
  it('agent routes list get create update delete and experiences', async () => {
    const agent = { id: 1, name: 'A', systemPrompt: 'p', creatorId: 7, isDefault: 0 };
    const agentService = {
      listAgents: vi.fn(async () => [agent]),
      getAgent: vi.fn(async () => agent),
      createAgent: vi.fn(async () => agent),
      updateAgent: vi.fn(async () => agent),
      deleteAgent: vi.fn(),
      getAgentExperiences: vi.fn(async () => [{ id: 1, content: 'c', sortOrder: 0, enabled: 1 }]),
    };
    const experienceService = {
      listByAgentId: vi.fn(async () => [{ id: 1, content: 'c', sortOrder: 0, enabled: 1 }]),
      create: vi.fn(async () => ({ id: 2, content: 'n', sortOrder: 1, enabled: 1 })),
      update: vi.fn(async () => ({ id: 1, content: 'u', sortOrder: 1, enabled: 1 })),
      delete: vi.fn(),
    };
    const userRepo = { findById: vi.fn(async () => ({ id: 7, username: 'ada', displayName: 'Ada' })) };
    const mcpServerValidator = { validateForAgent: vi.fn(async (ids: number[]) => ids) };
    const app = await appWithUser((f) => registerAgentRoutes(f, {
      agentService: agentService as never,
      experienceService: experienceService as never,
      userRepo: userRepo as never,
      mcpServerValidator: mcpServerValidator as never,
    }));
    expect((await app.inject({ method: 'GET', url: '/v1/agents' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/agents/1' })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST', url: '/v1/agents', payload: { name: 'A', systemPrompt: 'p' },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'PUT', url: '/v1/agents/1', payload: { name: 'B' },
    })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/v1/agents/1' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/agents/1/experiences' })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST', url: '/v1/agents/1/experiences', payload: { content: 'n' },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'PUT', url: '/v1/agents/1/experiences/1', payload: { content: 'u' },
    })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/v1/agents/1/experiences/1' })).statusCode).toBe(200);
    await app.close();
  });

  it('model command user admin and mcp preference routes', async () => {
    const model = { id: 3, name: 'gpt', provider: 'openai', modelId: 'g', status: 1 };
    const modelService = {
      listModels: vi.fn(async () => ({ records: [model], total: 1, page: 1, size: 10 })),
      listActiveModels: vi.fn(async () => [model]),
      listProviders: vi.fn(async () => ['openai']),
      getDefaultModel: vi.fn(async () => model),
      getModel: vi.fn(async () => model),
      createModel: vi.fn(async () => model),
      updateModel: vi.fn(async () => model),
      updateStatus: vi.fn(async () => model),
      deleteModel: vi.fn(),
      testConnection: vi.fn(async () => ({ ok: true })),
    };
    const commandService = {
      listByUserId: vi.fn(async () => [{ id: 1, name: 'c', content: 'x' }]),
      create: vi.fn(async () => ({ id: 1, name: 'c', content: 'x' })),
      update: vi.fn(async () => ({ id: 1, name: 'c', content: 'y' })),
      delete: vi.fn(),
      listAvailableForUser: vi.fn(async () => [{ name: 'c', content: 'x' }]),
    };
    const userService = {
      updateOwnProfile: vi.fn(),
      listUsers: vi.fn(async () => ({ records: [{ id: 7, username: 'ada' }], total: 1 })),
      createUser: vi.fn(async () => ({ id: 8, username: 'b' })),
      updateUser: vi.fn(),
      disableUser: vi.fn(),
    };
    const userRepo = {
      findById: vi.fn(async () => ({ id: 7, username: 'ada', displayName: 'Ada', status: 1 })),
    };
    const permission = {
      hasPermission: vi.fn(async () => true),
      isAdmin: vi.fn(async () => true),
      getUserPermissionCodes: vi.fn(async () => ['user:read']),
    };
    const jwt = {
      getUserIdFromToken: vi.fn(() => 7),
      validateToken: vi.fn(() => true),
      validateAccessToken: vi.fn(() => true),
    };
    const analytics = { summary: vi.fn(async () => ({ overview: {} })) };
    const mcpServerService = {
      listEnabled: vi.fn(async () => [{ id: 1, name: 's', status: 'ENABLED' }]),
      listMine: vi.fn(async () => []),
      list: vi.fn(async () => []),
      get: vi.fn(async () => ({ id: 1, name: 's' })),
      create: vi.fn(async () => ({ id: 1, name: 's' })),
      update: vi.fn(async () => ({ id: 1 })),
      updateStatus: vi.fn(),
      delete: vi.fn(),
    };
    const mcpPref = {
      getDisabledServerIds: vi.fn(async () => []),
      save: vi.fn(),
    };

    const app = await appWithUser((f) => {
      registerModelRoutes(f, { modelService: modelService as never });
      registerCommandRoutes(f, {
        userCommandService: commandService as never,
        agentService: { getAgent: vi.fn(async () => ({ id: 1, skillNames: '["java"]' })) } as never,
        skillLoader: { getAllDocuments: () => [{ name: 'java', description: 'j' }] } as never,
        skillSyncService: { getUserSkillDocuments: async () => [] } as never,
      });
      registerUserRoutes(f, userService as never, userRepo as never, permission as never);
      registerAdminAnalyticsRoutes(f, {
        jwt: jwt as never, analytics: analytics as never, userRepo: userRepo as never,
        passwordHasher: { hash: async (s: string) => s, matches: async () => true },
        rootDir: '/tmp',
      });
      registerAdminRuntimeRoutes(f, {
        jwt: jwt as never, analytics: analytics as never, userRepo: userRepo as never,
        passwordHasher: { hash: async (s: string) => s, matches: async () => true },
        rootDir: '/tmp',
      });
      registerMcpServerRoutes(f, {
        mcpServerService: mcpServerService as never,
        mcpClientManager: { disconnectSession: vi.fn() } as never,
        userMcpPreferenceService: mcpPref as never,
        permissionService: permission,
      });
    });

    const hits = [
      ['GET', '/v1/models'],
      ['GET', '/v1/models/active'],
      ['GET', '/v1/models/providers'],
      ['GET', '/v1/models/default'],
      ['GET', '/v1/models/3'],
      ['GET', '/v1/user-commands'],
      ['GET', '/v1/user-commands/system'],
      ['GET', '/v1/quick-commands'],
      ['GET', '/v1/users/me'],
      ['GET', '/v1/mcp-servers/preferences'],
      ['GET', '/v1/admin/analytics/summary'],
      ['GET', '/v1/admin/runtime/sessions'],
    ] as const;
    for (const [method, url] of hits) {
      const res = await app.inject({ method, url, headers: { authorization: 'Bearer test-token' } });
      expect(res.statusCode, `${method} ${url} ${res.body}`).toBe(200);
    }
    await app.close();
  });
});
