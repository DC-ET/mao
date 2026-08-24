import type { FastifyInstance } from 'fastify';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf, pathId } from '../common/request.js';
import type { Permission, Role } from '../user/types.js';
import type { PermissionService } from './permission.service.js';

export function registerPermissionRoutes(app: FastifyInstance, permissionService: PermissionService): void {
  app.get('/v1/roles', async (request, reply) => {
    requireUserId(request);
    const roles = await permissionService.listRoles();
    const voList = await Promise.all(roles.map((r) => toRoleVO(r, permissionService)));
    return sendOk(reply, voList);
  });

  app.post('/v1/roles', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'user:write');
    const body = bodyOf<{ name?: string; code?: string; description?: string }>(request);
    const role = await permissionService.createRole(body.name ?? '', body.code ?? '', body.description);
    return sendOk(reply, await toRoleVO(role, permissionService));
  });

  app.put('/v1/roles/:id', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'user:write');
    const body = bodyOf<{ name?: string; description?: string }>(request);
    const role = await permissionService.updateRole(pathId(request), body.name, body.description);
    return sendOk(reply, role ? await toRoleVO(role, permissionService) : null);
  });

  app.get('/v1/permissions', async (request, reply) => {
    requireUserId(request);
    const list = await permissionService.listPermissions();
    return sendOk(reply, list.map(toPermissionVO));
  });

  app.put('/v1/roles/:id/permissions', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'user:write');
    const body = bodyOf<{ permissionIds?: number[] }>(request);
    await permissionService.assignPermissions(pathId(request), body.permissionIds ?? []);
    return sendOk(reply);
  });

  app.put('/v1/users/:id/roles', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'user:write');
    const body = bodyOf<{ roleIds?: number[] }>(request);
    const targetUserId = pathId(request);
    const roleIds = body.roleIds ?? [];
    await permissionService.assertCanChangeRoles(targetUserId, roleIds);
    await permissionService.assignRoles(targetUserId, roleIds);
    return sendOk(reply);
  });
}

async function toRoleVO(role: Role, permissionService: PermissionService) {
  return {
    id: role.id,
    name: role.name,
    code: role.code,
    description: role.description,
    permissionIds: await permissionService.getRolePermissionIds(role.id!),
    userCount: await permissionService.countRoleUsers(role.id!),
  };
}

function toPermissionVO(perm: Permission) {
  return {
    id: perm.id,
    name: perm.name,
    code: perm.code,
    description: perm.description,
  };
}
