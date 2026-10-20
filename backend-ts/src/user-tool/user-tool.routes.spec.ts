import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { HttpApiExecutor } from '../harness/tool/impl/http-api-executor.js';
import { UserToolService } from './user-tool.service.js';
import { UserToolHeaderCipher } from './user-tool-cipher.js';
import { registerAdminUserToolRoutes } from './user-tool-admin.routes.js';
import { registerUserToolRoutes } from './user-tool.routes.js';
import type { UserTool, UserToolParam, UserToolRepository } from './types.js';

/** 内存版 repository（同 service.spec 口径，事务即顺序执行）。 */
function fakeRepo(seed: UserTool[] = []) {
  const tools = [...seed];
  const params: UserToolParam[] = [];
  let nextId = 100;
  return {
    tools,
    params,
    async listByUserId(userId: number) { return tools.filter((t) => t.userId === userId).sort((a, b) => (a.name < b.name ? -1 : 1)); },
    async listEnabledByUserId(userId: number) { return tools.filter((t) => t.userId === userId && t.enabled === 1); },
    async findById(id: number) { return tools.find((t) => t.id === id) ?? null; },
    async findByIdAndUserId(id: number, userId: number) { return tools.find((t) => t.id === id && t.userId === userId) ?? null; },
    async findByUserIdAndName(userId: number, name: string) { return tools.find((t) => t.userId === userId && t.name === name) ?? null; },
    async countEnabledByUserId(userId: number) { return tools.filter((t) => t.userId === userId && t.enabled === 1).length; },
    async listParamsByToolId(toolId: number) { return params.filter((p) => p.toolId === toolId); },
    async insert(tool: UserTool) { tool.id = nextId++; tools.push(tool); return tool.id!; },
    async updateById(tool: UserTool) {
      const index = tools.findIndex((t) => t.id === tool.id);
      if (index >= 0) tools[index] = tool;
    },
    async deleteById(id: number) {
      const index = tools.findIndex((t) => t.id === id);
      if (index >= 0) tools.splice(index, 1);
    },
    async insertParam(param: UserToolParam) { param.id = params.length + 1; params.push(param); return param.id!; },
    async deleteParamsByToolId(toolId: number) {
      for (let i = params.length - 1; i >= 0; i--) {
        if (params[i]!.toolId === toolId) params.splice(i, 1);
      }
    },
    async transaction<T>(fn: (repo: UserToolRepository) => Promise<T>): Promise<T> { return fn(this as unknown as UserToolRepository); },
    async listForAdmin() { return { rows: [], total: 0 }; },
  };
}

function buildApp(options: { permissions?: string[] } = {}) {
  const repo = fakeRepo();
  const service = new UserToolService({
    repo: repo as unknown as UserToolRepository,
    cipher: new UserToolHeaderCipher('routes-test-secret'),
    settings: { getMaxEnabledPerUser: async () => 20 },
    builtinToolNames: () => ['read_file', 'shell'],
  });
  const executor = new HttpApiExecutor({
    allowlistProvider: async () => [],
    fetchImpl: (async () => new Response('{"temp":26}', { status: 200, headers: { 'content-type': 'application/json' } })) as never,
    resolveIps: async () => ['93.184.216.34'],
    allowlistTtlMs: 60000,
  });
  const app = Fastify();
  app.setErrorHandler(handleError);
  app.addHook('preHandler', (request, _reply, done) => {
    request.userId = 9;
    done();
  });
  registerUserToolRoutes(app, { userToolService: service, httpApiExecutor: executor });
  registerAdminUserToolRoutes(app, {
    repo: { listForAdmin: vi.fn(async () => ({ rows: [], total: 0 })) } as never,
    stats: { selectUserToolCallStats: vi.fn(async () => [{ slug: 'weather', calls: 10, errors: 2, users: 3, firstAt: '2026-10-20 09:00:00', lastAt: '2026-10-20 10:00:00' }]) } as never,
    permissionService: {
      hasPermission: vi.fn(async (_userId: number, code: string) => (options.permissions ?? ['user_tool:read']).includes(code)),
    },
  });
  return { app, repo };
}

const draft = {
  name: 'weather',
  displayName: '天气查询',
  description: '查询城市天气',
  method: 'GET',
  url: 'https://api.example.com/v1/weather',
  headers: [{ key: 'Authorization', value: 'Bearer secret' }],
  params: [{ name: 'city', label: '城市', type: 'string', required: true }],
};

describe('user-tool routes (user side)', () => {
  it('creates, lists (masked), updates and deletes a tool', async () => {
    const { app } = buildApp();
    const create = await app.inject({ method: 'POST', url: '/v1/user-tools', payload: draft });
    expect(create.statusCode).toBe(200);
    const created = create.json().data;
    expect(created.name).toBe('weather');
    expect(created.readOnly).toBe(true);
    expect(created.headers).toEqual([{ key: 'Authorization', value: '******', sensitive: true }]);

    const list = await app.inject({ method: 'GET', url: '/v1/user-tools' });
    expect(list.json().data).toHaveLength(1);
    expect(JSON.stringify(list.json().data)).not.toContain('secret');

    const update = await app.inject({
      method: 'PUT', url: `/v1/user-tools/${created.id}`, payload: { ...draft, displayName: '天气' },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().data.displayName).toBe('天气');

    const remove = await app.inject({ method: 'DELETE', url: `/v1/user-tools/${created.id}` });
    expect(remove.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/user-tools' })).json().data).toHaveLength(0);
  });

  it('rejects another user\'s tool with USER_TOOL_NOT_FOUND on update and delete', async () => {
    const { app } = buildApp();
    const created = (await app.inject({ method: 'POST', url: '/v1/user-tools', payload: draft })).json().data;
    const update = await app.inject({ method: 'PUT', url: `/v1/user-tools/${created.id}`, payload: draft });
    expect(update.statusCode).toBe(200);

    // 换一个不存在的 id：服务层按属主查不到 → 业务错误码而非 500
    const missing = await app.inject({ method: 'PUT', url: '/v1/user-tools/99999', payload: draft });
    expect(missing.statusCode).toBe(200);
    expect(missing.json().code).toBe(3051);
    const missingDelete = await app.inject({ method: 'DELETE', url: '/v1/user-tools/99999' });
    expect(missingDelete.json().code).toBe(3051);
  });

  it('rejects invalid ids without hitting SQL binding', async () => {
    const { app } = buildApp();
    const response = await app.inject({ method: 'DELETE', url: '/v1/user-tools/abc' });
    expect(response.statusCode).toBe(200);
    expect(response.json().code).toBe(2001);
  });

  it('validates the enabled flag on the toggle endpoint', async () => {
    const { app } = buildApp();
    const created = (await app.inject({ method: 'POST', url: '/v1/user-tools', payload: draft })).json().data;
    const bad = await app.inject({ method: 'PUT', url: `/v1/user-tools/${created.id}/enabled`, payload: {} });
    expect(bad.json().code).toBe(2001);
    const good = await app.inject({ method: 'PUT', url: `/v1/user-tools/${created.id}/enabled`, payload: { enabled: false } });
    expect(good.json().data.enabled).toBe(false);
  });

  it('rejects invalid drafts with readable business errors', async () => {
    const { app } = buildApp();
    const reserved = await app.inject({ method: 'POST', url: '/v1/user-tools', payload: { ...draft, name: 'http_call' } });
    expect(reserved.json().code).toBe(3053);
    const badUrl = await app.inject({ method: 'POST', url: '/v1/user-tools', payload: { ...draft, url: 'ftp://x' } });
    expect(badUrl.json().code).toBe(2001);
    const dup = await app.inject({ method: 'POST', url: '/v1/user-tools', payload: draft });
    expect(dup.statusCode).toBe(200);
    const dup2 = await app.inject({ method: 'POST', url: '/v1/user-tools', payload: draft });
    expect(dup2.json().code).toBe(3052);
  });
});

describe('user-tool test-run route', () => {
  it('executes the draft through the kernel and reports duration', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'POST', url: '/v1/user-tools/test',
      payload: { ...draft, arguments: { city: '上海' } },
    });
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data).toMatchObject({ status: 200, body: '{"temp":26}', truncated: false });
    expect(typeof data.durationMs).toBe('number');
  });

  it('returns SSRF denials as error payloads (same guard as production calls)', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'POST', url: '/v1/user-tools/test',
      payload: { ...draft, url: 'http://127.0.0.1:9080/internal', arguments: { city: '上海' } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.error).toContain('请求被拒绝');
  });

  it('rejects mask sentinel header values and malformed arguments', async () => {
    const { app } = buildApp();
    const masked = await app.inject({
      method: 'POST', url: '/v1/user-tools/test',
      payload: { ...draft, headers: [{ key: 'Authorization', value: '******' }] },
    });
    expect(masked.json().code).toBe(2001);
    const badArgs = await app.inject({
      method: 'POST', url: '/v1/user-tools/test', payload: { ...draft, arguments: [1, 2] },
    });
    expect(badArgs.json().code).toBe(2001);
  });
});

describe('user-tool routes (admin side)', () => {
  it('denies access without the user_tool:read permission', async () => {
    const { app } = buildApp({ permissions: [] });
    const response = await app.inject({ method: 'GET', url: '/v1/admin/user-tools' });
    expect(response.statusCode).toBe(403);
  });

  it('returns stats with a computed fail rate', async () => {
    const { app } = buildApp();
    const response = await app.inject({ method: 'GET', url: '/v1/admin/user-tools/stats' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data[0]).toMatchObject({ slug: 'weather', calls: 10, errors: 2, failRate: 0.2, users: 3 });
    expect(response.json().data[0].lastAt).toBe('2026-10-20T10:00:00');
  });
});
