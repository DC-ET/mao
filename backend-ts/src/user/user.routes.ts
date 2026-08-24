import type { FastifyInstance } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf, pathId, queryInt, queryOptInt, queryOptStr } from '../common/request.js';
import { javaLocalDateTimeString } from '../common/datetime.js';
import type { PermissionService } from '../permission/permission.service.js';
import type { User, UserRepository } from './types.js';
import { UserService } from './user.service.js';

export function registerUserRoutes(
  app: FastifyInstance,
  userService: UserService,
  userRepo: UserRepository,
  permissionService: PermissionService,
): void {
  app.get('/v1/users/me', async (request, reply) => {
    const userId = requireUserId(request);
    const user = await userRepo.findById(userId);
    if (!user) {
      throw new BusinessException(ErrorCode.UNAUTHORIZED);
    }
    return sendOk(reply, await toUserInfoVO(user, permissionService));
  });

  app.put('/v1/users/me/profile', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ displayName?: string; email?: string; avatarUrl?: string }>(request);
    await userService.updateOwnProfile(userId, body.displayName, body.email, body.avatarUrl);
    const user = await userRepo.findById(userId);
    return sendOk(reply, await toUserInfoVO(user!, permissionService));
  });

  app.get('/v1/users', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'user:read');
    const page = queryInt(request, 'page', 1);
    const size = queryInt(request, 'size', 20);
    const keyword = queryOptStr(request, 'keyword');
    const status = queryOptInt(request, 'status');
    const pageResult = await userService.listUsers(page, size, keyword, status);
    const records = pageResult.records;
    const roleMap = await userService.batchGetUserRoles(records.map((u) => u.id!).filter(Boolean));
    const voList = records.map((u) => toUserVO(u, roleMap.get(u.id!) ?? []));
    return sendOk(reply, { records: voList, total: pageResult.total });
  });

  app.get('/v1/users/:id', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'user:read');
    const user = await userService.getUser(pathId(request));
    const roles = await userService.getUserRoles(user.id!);
    return sendOk(reply, toUserVO(user, roles));
  });

  app.post('/v1/users', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'user:write');
    const body = bodyOf<{
      username?: string;
      displayName?: string;
      email?: string;
      password?: string;
      roleIds?: number[];
      status?: number;
    }>(request);
    const user = await userService.createUser(
      body.username ?? '',
      body.displayName ?? '',
      body.email,
      body.password ?? '',
      body.roleIds,
      body.status,
    );
    const roles = await userService.getUserRoles(user.id!);
    return sendOk(reply, toUserVO(user, roles));
  });

  app.put('/v1/users/:id', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'user:write');
    const body = bodyOf<{
      displayName?: string;
      email?: string;
      roleIds?: number[];
      status?: number;
    }>(request);
    const user = await userService.updateUser(
      pathId(request), body.displayName, body.email, body.roleIds, body.status, userId,
    );
    const roles = await userService.getUserRoles(user.id!);
    return sendOk(reply, toUserVO(user, roles));
  });

  app.put('/v1/users/:id/password', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'user:write');
    const body = bodyOf<{ newPassword?: string; confirmPassword?: string }>(request);
    if (body.newPassword == null || body.newPassword !== body.confirmPassword) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '两次输入的密码不一致');
    }
    await userService.resetPassword(pathId(request), body.newPassword);
    return sendOk(reply);
  });

  app.put('/v1/users/:id/status', async (request, reply) => {
    const currentUserId = requireUserId(request);
    await requirePermission(permissionService, currentUserId, 'user:write');
    const body = bodyOf<{ status?: number }>(request);
    await userService.updateUserStatus(pathId(request), body.status, currentUserId);
    return sendOk(reply);
  });
}

async function toUserInfoVO(user: User, permissionService: PermissionService) {
  const codes = await permissionService.getUserPermissionCodes(user.id!);
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    avatarUrl: user.avatarUrl,
    authSource: UserService.resolveAuthSource(user),
    permissions: [...new Set(codes)],
    isAdmin: await permissionService.isAdmin(user.id),
  };
}

function toUserVO(user: User, roles: Array<{ id?: number; name: string }>) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    avatarUrl: user.avatarUrl,
    status: user.status,
    authSource: UserService.resolveAuthSource(user),
    roleIds: roles.map((r) => r.id),
    roleNames: roles.map((r) => r.name),
    lastLoginAt: javaLocalDateTimeString(user.lastLoginAt),
    createdAt: javaLocalDateTimeString(user.createdAt),
  };
}
