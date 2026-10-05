import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerAgentBundleRoutes } from './agent-bundle.routes.js';
import { registerSharedAgentRoutes } from './shared-agent.routes.js';
import { BUNDLE_FORMAT } from './agent-bundle.types.js';
import type { SharedAgentVO } from './shared-agent.service.js';

function appWithUser(userId: number | null) {
  const fastify = Fastify();
  fastify.setErrorHandler(handleError);
  fastify.addHook('preHandler', (req, _r, done) => {
    if (userId != null) req.userId = userId;
    done();
  });
  return fastify;
}

describe('Agent bundle routes 权限与响应契约', () => {
  let permission: { hasPermission: ReturnType<typeof vi.fn> };
  let exportBundle: ReturnType<typeof vi.fn>;
  let importBundle: ReturnType<typeof vi.fn>;
  let app: ReturnType<typeof appWithUser>;

  beforeEach(() => {
    permission = { hasPermission: vi.fn(async () => false) };
    exportBundle = vi.fn(async () => ({
      bundle: { format: BUNDLE_FORMAT, formatVersion: 1, agent: { name: 'A', systemPrompt: 'p' } },
      filename: 'mao-agent-bundle-A-v1.json',
    }));
    importBundle = vi.fn(async () => ({ agentId: 9, report: { finalName: 'A' } }));
    app = appWithUser(7);
    registerAgentBundleRoutes(app, {
      agentBundleService: { exportBundle, importBundle } as never,
      permissionService: permission,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('非 agent:write 用户访问导出/导入被拒，service 不被触达', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/agents/1/bundle' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v1/agent-bundle/import', payload: {} })).statusCode).toBe(403);
    expect(exportBundle).not.toHaveBeenCalled();
    expect(importBundle).not.toHaveBeenCalled();
    expect(permission.hasPermission).toHaveBeenCalledWith(7, 'agent:write');
  });

  it('导出响应为 bundle JSON 本体（非 Result 信封）+ attachment 头；inlineSkills 透传', async () => {
    permission.hasPermission = vi.fn(async () => true);
    const res = await app.inject({ method: 'GET', url: '/v1/agents/3/bundle?inlineSkills=code-review@12' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="mao-agent-bundle-A-v1.json"');
    const body = res.json();
    // bundle 文件顶层即格式契约，不再是 { code, data } 信封
    expect(body.format).toBe(BUNDLE_FORMAT);
    expect(body.code).toBeUndefined();
    expect(exportBundle).toHaveBeenCalledWith(3, 'code-review@12');
  });

  it('重复 inlineSkills 查询参数归一为逗号分隔字符串（不 500）', async () => {
    permission.hasPermission = vi.fn(async () => true);
    const res = await app.inject({ method: 'GET', url: '/v1/agents/3/bundle?inlineSkills=a&inlineSkills=b%4012' });
    expect(res.statusCode).toBe(200);
    expect(exportBundle).toHaveBeenCalledWith(3, 'a,b@12');
  });

  it('confirm=false 预检与 confirm=true 落库均透传操作者', async () => {
    permission.hasPermission = vi.fn(async () => true);
    const precheck = await app.inject({ method: 'POST', url: '/v1/agent-bundle/import', payload: { bundle: { format: BUNDLE_FORMAT } } });
    expect(precheck.json().code).toBe(0);
    expect(importBundle).toHaveBeenCalledWith({ format: BUNDLE_FORMAT }, false, 7);
    const commit = await app.inject({ method: 'POST', url: '/v1/agent-bundle/import', payload: { bundle: { format: BUNDLE_FORMAT }, confirm: true } });
    expect(commit.json().data).toMatchObject({ agentId: 9 });
    expect(importBundle).toHaveBeenLastCalledWith({ format: BUNDLE_FORMAT }, true, 7);
  });

  it('未登录访问导出/导入返回 401', async () => {
    const anon = appWithUser(null);
    registerAgentBundleRoutes(anon, {
      agentBundleService: { exportBundle, importBundle } as never,
      permissionService: permission,
    });
    try {
      expect((await anon.inject({ method: 'GET', url: '/v1/agents/1/bundle' })).statusCode).toBe(401);
      expect((await anon.inject({ method: 'POST', url: '/v1/agent-bundle/import', payload: {} })).statusCode).toBe(401);
    } finally {
      await anon.close();
    }
  });
});

describe('Shared agent routes 权限', () => {
  let permission: { hasPermission: ReturnType<typeof vi.fn> };
  let sharedAgentService: {
    listSharedAgents: ReturnType<typeof vi.fn>;
    putEntry: ReturnType<typeof vi.fn>;
    removeEntry: ReturnType<typeof vi.fn>;
  };
  let app: ReturnType<typeof appWithUser>;

  beforeEach(() => {
    permission = { hasPermission: vi.fn(async () => false) };
    const vo: SharedAgentVO = {
      agentId: 3, name: '评审员', description: null, avatarUrl: null,
      note: '适合 PR 评审', sortOrder: 0, missingSkills: ['x'], mcpIssues: [],
    };
    sharedAgentService = {
      listSharedAgents: vi.fn(async () => [vo]),
      putEntry: vi.fn(),
      removeEntry: vi.fn(),
    };
    app = appWithUser(7);
    registerSharedAgentRoutes(app, { sharedAgentService: sharedAgentService as never, permissionService: permission });
  });

  afterEach(async () => {
    await app.close();
  });

  it('普通登录用户可 GET /v1/shared-agents，写路径被拒', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/shared-agents' });
    expect(list.statusCode).toBe(200);
    expect(list.json().data[0]).toMatchObject({ agentId: 3, note: '适合 PR 评审', missingSkills: ['x'] });
    expect(sharedAgentService.listSharedAgents).toHaveBeenCalledWith(7);

    expect((await app.inject({ method: 'PUT', url: '/v1/agents/3/shared-entry', payload: { note: 'x' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/v1/agents/3/shared-entry' })).statusCode).toBe(403);
    expect(sharedAgentService.putEntry).not.toHaveBeenCalled();
    expect(sharedAgentService.removeEntry).not.toHaveBeenCalled();
  });

  it('agent:write 用户可上架/下架', async () => {
    permission.hasPermission = vi.fn(async () => true);
    const put = await app.inject({
      method: 'PUT', url: '/v1/agents/3/shared-entry',
      payload: { note: '推荐语', sortOrder: 2 },
    });
    expect(put.statusCode).toBe(200);
    expect(sharedAgentService.putEntry).toHaveBeenCalledWith(3, '推荐语', 2, 7);
    const del = await app.inject({ method: 'DELETE', url: '/v1/agents/3/shared-entry' });
    expect(del.statusCode).toBe(200);
    expect(sharedAgentService.removeEntry).toHaveBeenCalledWith(3);
  });

  it('未登录 GET /v1/shared-agents 返回 401', async () => {
    const anon = appWithUser(null);
    registerSharedAgentRoutes(anon, { sharedAgentService: sharedAgentService as never, permissionService: permission });
    try {
      expect((await anon.inject({ method: 'GET', url: '/v1/shared-agents' })).statusCode).toBe(401);
    } finally {
      await anon.close();
    }
  });
});
