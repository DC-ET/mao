import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerAuditLogRoutes } from '../audit/audit.routes.js';
import { registerMcpServerRoutes } from '../harness/mcp/controller/mcp-server.routes.js';
import { registerPermissionRoutes } from './permission.routes.js';
import { registerScheduledTaskRoutes } from '../schedule/scheduled-task.routes.js';

function appWith(allow: string[]) {
  const app = Fastify();
  app.setErrorHandler(handleError);
  app.addHook('preHandler', (req, _r, done) => {
    req.userId = 7;
    done();
  });
  const hasPermission = vi.fn(async (_userId: number, code: string) => allow.includes(code));
  return { app, hasPermission };
}

describe('admin permission gates', () => {
  it('lets user:write list roles without opening the permission catalog', async () => {
    const { app, hasPermission } = appWith(['user:write']);
    const createRole = vi.fn();
    registerPermissionRoutes(app, {
      hasPermission,
      listRoles: async () => [{ id: 3, name: '运营', code: 'OPS', description: null }],
      getRolePermissionIds: async () => [],
      countRoleUsers: async () => 0,
      createRole,
      updateRole: async () => null,
      listPermissions: async () => [],
      assignPermissions: async () => undefined,
      changeRolesWithAdminGuard: async () => undefined,
    } as never);

    const roles = JSON.parse((await app.inject({ method: 'GET', url: '/v1/roles' })).body);
    expect(roles.code).toBe(0);
    expect(roles.data[0].code).toBe('OPS');
    const catalog = JSON.parse((await app.inject({ method: 'GET', url: '/v1/permissions' })).body);
    expect(catalog.code).toBe(1002);
    const created = JSON.parse((await app.inject({
      method: 'POST', url: '/v1/roles', payload: { name: 'n', code: 'N' },
    })).body);
    expect(created.code).toBe(1002);
    expect(createRole).not.toHaveBeenCalled();
    await app.close();
  });

  it('requires audit:read for audit logs', async () => {
    const denied = appWith([]);
    const list = vi.fn(async () => ({ records: [], total: 0, page: 1, size: 20 }));
    registerAuditLogRoutes(denied.app, {
      auditLogService: { list, get: vi.fn() } as never,
      permissionService: { hasPermission: denied.hasPermission },
    });
    const blocked = JSON.parse((await denied.app.inject({ method: 'GET', url: '/v1/audit/logs' })).body);
    expect(blocked.code).toBe(1002);
    expect(list).not.toHaveBeenCalled();
    await denied.app.close();

    const allowed = appWith(['audit:read']);
    registerAuditLogRoutes(allowed.app, {
      auditLogService: { list, get: vi.fn(async () => ({ id: 1 })) } as never,
      permissionService: { hasPermission: allowed.hasPermission },
    });
    const ok = JSON.parse((await allowed.app.inject({ method: 'GET', url: '/v1/audit/logs' })).body);
    expect(ok.code).toBe(0);
    await allowed.app.close();
  });

  it('lets agent:write load enabled MCP servers without mcp:read', async () => {
    const { app, hasPermission } = appWith(['agent:write']);
    const listEnabled = vi.fn(async () => [{ id: 1, name: 'fs' }]);
    const list = vi.fn(async () => []);
    registerMcpServerRoutes(app, {
      mcpServerService: { listEnabled, list } as never,
      mcpClientManager: {} as never,
      userMcpPreferenceService: {} as never,
      permissionService: { hasPermission },
    });
    const enabled = JSON.parse((await app.inject({ method: 'GET', url: '/v1/mcp-servers/enabled' })).body);
    expect(enabled.code).toBe(0);
    expect(listEnabled).toHaveBeenCalled();
    const governance = JSON.parse((await app.inject({ method: 'GET', url: '/v1/mcp-servers' })).body);
    expect(governance.code).toBe(1002);
    expect(list).not.toHaveBeenCalled();
    await app.close();
  });

  it('uses scheduled-task:read for cross-user task lists', async () => {
    const jwt = {
      validateAccessToken: () => true,
      getUserIdFromToken: () => 7,
    };
    const listAll = vi.fn(async () => ({ records: [], total: 0 }));
    const listByUser = vi.fn(async () => []);

    const denied = Fastify();
    denied.setErrorHandler(handleError);
    registerScheduledTaskRoutes(denied, {
      jwt: jwt as never,
      service: { listAll, listByUser } as never,
      permission: { hasPermission: async (_userId: number, code: string) => code === 'session:read' } as never,
    });
    const blocked = JSON.parse((await denied.inject({
      method: 'GET', url: '/v1/scheduled-tasks/all', headers: { authorization: 'Bearer t' },
    })).body);
    expect(blocked.code).toBe(1002);
    expect(listAll).not.toHaveBeenCalled();
    const own = JSON.parse((await denied.inject({
      method: 'GET', url: '/v1/scheduled-tasks', headers: { authorization: 'Bearer t' },
    })).body);
    expect(own.code).toBe(0);
    expect(listByUser).toHaveBeenCalled();
    await denied.close();

    const allowed = Fastify();
    allowed.setErrorHandler(handleError);
    registerScheduledTaskRoutes(allowed, {
      jwt: jwt as never,
      service: { listAll, listByUser } as never,
      permission: { hasPermission: async (_userId: number, code: string) => code === 'scheduled-task:read' } as never,
    });
    const ok = JSON.parse((await allowed.inject({
      method: 'GET', url: '/v1/scheduled-tasks/all', headers: { authorization: 'Bearer t' },
    })).body);
    expect(ok.code).toBe(0);
    expect(listAll).toHaveBeenCalled();
    await allowed.close();
  });
});
