import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerEntrySummary } from '@mao/contracts';
import { handleError } from '../../common/http-error.js';
import type { ContainerOps } from './container-registry.js';
import {
  registerAdminContainerRoutes,
  type ContainerAgentRef,
  type ContainerUserRef,
} from './container-admin.routes.js';

function entry(userId: number, agentId: number, patch: Partial<ContainerEntrySummary> = {}): ContainerEntrySummary {
  return {
    userId,
    agentId,
    containerName: `mao-user-${userId}-agent-${agentId}`,
    state: 'running',
    tracked: true,
    busy: false,
    startedAtMs: 1,
    lastUsedAtMs: 2,
    runtimeBuild: null,
    hostRuntimeBuild: 'host-1',
    pendingUpgrade: false,
    ageText: null,
    ...patch,
  };
}

function buildApp(opts: {
  userId?: number;
  allowed?: boolean;
  rows?: ContainerEntrySummary[];
  users?: ContainerUserRef[];
  agents?: ContainerAgentRef[];
} = {}) {
  const listEntries = vi.fn(async () => opts.rows ?? []);
  const findUsers = vi.fn(async () => opts.users ?? []);
  const findAgents = vi.fn(async () => opts.agents ?? []);
  const hasPermission = vi.fn(async (_userId: number, code: string) => opts.allowed !== false && code === 'container:manage');
  const app = Fastify();
  app.setErrorHandler(handleError);
  app.addHook('preHandler', async (request) => {
    if (opts.userId != null) (request as { userId?: number }).userId = opts.userId;
  });
  registerAdminContainerRoutes(app, {
    containerOps: { listEntries } as ContainerOps,
    permissionService: { hasPermission },
    userLookup: { findByIds: findUsers },
    agentLookup: { findByIds: findAgents },
  });
  return { app, listEntries, findUsers, findAgents, hasPermission };
}

describe('GET /v1/admin/containers 名称装配', () => {
  it('用显示名称和 Agent 名称填充列表，并保留原有字段', async () => {
    const { app, findUsers, findAgents } = buildApp({
      userId: 1,
      rows: [entry(2, 5), entry(2, 6), entry(3, 5, { tracked: false, state: 'stopped' })],
      users: [
        { id: 2, username: 'u2', displayName: '张三' },
        { id: 3, username: 'u3', displayName: null },
      ],
      agents: [
        { id: 5, name: '编码助手' },
        { id: 6, name: '  评审  ' },
      ],
    });
    const response = await app.inject({ method: 'GET', url: '/v1/admin/containers' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      expect.objectContaining({
        userId: 2, agentId: 5, userName: '张三', agentName: '编码助手',
        containerName: 'mao-user-2-agent-5', tracked: true, hostRuntimeBuild: 'host-1',
      }),
      expect.objectContaining({ userId: 2, agentId: 6, userName: '张三', agentName: '评审' }),
      expect.objectContaining({
        userId: 3, agentId: 5, userName: 'u3', agentName: '编码助手', tracked: false, state: 'stopped',
      }),
    ]);
    // 同一用户只查一次；id 按出现顺序去重
    expect(findUsers).toHaveBeenCalledWith([2, 3]);
    expect(findAgents).toHaveBeenCalledWith([5, 6]);
  });

  it('显示名称为空白时回落用户名；名称字段为空白或查不到时为 null', async () => {
    const { app } = buildApp({
      userId: 1,
      rows: [entry(7, 9), entry(8, 4)],
      users: [
        { id: '7', username: '  fallback  ', displayName: '   ' },
      ],
      agents: [
        { id: '9', name: '  ' },
      ],
    });
    const response = await app.inject({ method: 'GET', url: '/v1/admin/containers' });
    const data = response.json().data as Array<Record<string, unknown>>;
    // null 名称会被 Jackson 序列化省略；前端把缺字段当成没有名称，回落 #ID
    expect(data[0]).toMatchObject({ userId: 7, agentId: 9, userName: 'fallback' });
    expect(data[0]).not.toHaveProperty('agentName');
    expect(data[1]).toMatchObject({ userId: 8, agentId: 4 });
    expect(data[1]).not.toHaveProperty('userName');
    expect(data[1]).not.toHaveProperty('agentName');
  });

  it('没有容器时不查用户和 Agent', async () => {
    const { app, findUsers, findAgents, listEntries } = buildApp({ userId: 1, rows: [] });
    const response = await app.inject({ method: 'GET', url: '/v1/admin/containers' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
    expect(listEntries).toHaveBeenCalledTimes(1);
    expect(findUsers).not.toHaveBeenCalled();
    expect(findAgents).not.toHaveBeenCalled();
  });

  it('没有 container:manage 时返回 403，且不读容器列表', async () => {
    const { app, listEntries, findUsers } = buildApp({ userId: 1, allowed: false, rows: [entry(2, 5)] });
    const response = await app.inject({ method: 'GET', url: '/v1/admin/containers' });
    expect(response.statusCode).toBe(403);
    expect(listEntries).not.toHaveBeenCalled();
    expect(findUsers).not.toHaveBeenCalled();
  });

  it('未登录时返回 401，且不读容器列表', async () => {
    const { app, listEntries, hasPermission } = buildApp({ rows: [entry(2, 5)] });
    const response = await app.inject({ method: 'GET', url: '/v1/admin/containers' });
    expect(response.statusCode).toBe(401);
    expect(hasPermission).not.toHaveBeenCalled();
    expect(listEntries).not.toHaveBeenCalled();
  });
});
