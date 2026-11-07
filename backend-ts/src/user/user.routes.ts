import type { FastifyInstance } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf, pathId, queryInt, queryOptInt, queryOptStr } from '../common/request.js';
import { javaLocalDateTimeString } from '../common/datetime.js';
import type { PermissionService } from '../permission/permission.service.js';
import type { User, UserRepository } from './types.js';
import { UserService } from './user.service.js';
import type { ContainerOps } from '../harness/container/container-registry.js';

export function registerUserRoutes(
  app: FastifyInstance,
  userService: UserService,
  userRepo: UserRepository,
  permissionService: PermissionService,
  /** 容器运维（Docker 模式）：未注入时不注册「重建容器」接口（host-only 部署保持一致）。 */
  containerOps?: ContainerOps,
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

  // 自助改密：登录态即可（不挂 requirePermission，无 user:write 的普通角色也可改自己的密码）；
  // 两次输入一致性在路由层拒绝（与管理员重置路由同文案），旧密码校验在 service。
  app.put('/v1/users/me/password', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ oldPassword?: string; newPassword?: string; confirmPassword?: string }>(request);
    if (body.newPassword == null || body.newPassword !== body.confirmPassword) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '两次输入的密码不一致');
    }
    await userService.changeOwnPassword(userId, body.oldPassword ?? '', body.newPassword);
    return sendOk(reply);
  });

  app.get('/v1/users', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'user:read');
    const page = queryInt(request, 'page', 1);
    const size = queryInt(request, 'size', 20);
    const keyword = queryOptStr(request, 'keyword');
    const status = queryOptInt(request, 'status');
    const authSource = queryOptStr(request, 'authSource');
    const roleId = queryOptInt(request, 'roleId');
    const pageResult = await userService.listUsers(page, size, keyword, status, authSource, roleId);
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
      runtimeMode?: string | null;
    }>(request);
    const user = await userService.updateUser(
      pathId(request), body.displayName, body.email, body.roleIds, body.status, userId, body.runtimeMode,
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

  // 单用户容器重建（Docker 模式，容器域名解析注入方案 §4.11）：
  // 立即把该用户容器按最新配置重建（停→rm→docker run），跳过"下次使用时惰性重建"的等待。
  // 权限 container:manage；异常不抛出（recycleUser 返回 failed + 错误摘要），便于后台逐条展示。
  if (containerOps) {
    app.post('/v1/users/:id/container/recycle', async (request, reply) => {
      const currentUserId = requireUserId(request);
      await requirePermission(permissionService, currentUserId, 'container:manage');
      // body.agentId（2026-11-07 复合容器方案 §5.10）：指定时只回收该 (user, agent) 容器，
      // 缺省回收该用户全部在册容器（聚合结果）
      const body = bodyOf<{ force?: boolean; agentId?: number }>(request);
      const result = await containerOps.recycleUser(pathId(request), { force: body.force === true, agentId: body.agentId });
      return sendOk(reply, result);
    });
  }
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
    runtimeMode: user.runtimeMode ?? null,
    authSource: UserService.resolveAuthSource(user),
    roleIds: roles.map((r) => r.id),
    roleNames: roles.map((r) => r.name),
    lastLoginAt: javaLocalDateTimeString(user.lastLoginAt),
    createdAt: javaLocalDateTimeString(user.createdAt),
  };
}
