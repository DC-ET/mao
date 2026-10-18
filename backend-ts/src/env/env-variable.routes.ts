import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf, pathId, queryOptStr } from '../common/request.js';
import { maskEnvValueForAdmin, type EnvVariableService } from './env-variable.service.js';
import type { EnvVariable } from './types.js';

type PermissionChecker = { hasPermission(userId: number, code: string): Promise<boolean> };
type SessionLookup = {
  findById(id: number): Promise<{ userId?: number | null; workspace?: string | null } | null>;
};
type UserLookup = { findById(id: number): Promise<{ username?: string | null } | null> };

export interface EnvVariableRouteDeps {
  envVariableService: EnvVariableService;
  sessionLookup: SessionLookup;
}

export interface AdminEnvVariableRouteDeps {
  envVariableService: EnvVariableService;
  permissionService: PermissionChecker;
  userLookup?: UserLookup;
}

/** 用户侧：本人全局变量 + 工作区变量 + 会话生效变量（技术方案 §5.5）。 */
export function registerEnvVariableRoutes(app: FastifyInstance, deps: EnvVariableRouteDeps): void {
  const { envVariableService, sessionLookup } = deps;

  app.get('/v1/user/env-variables', async (request, reply) => {
    const userId = requireUserId(request);
    const list = await envVariableService.listUser(userId);
    return sendOk(reply, list.map(toVO));
  });

  app.post('/v1/user/env-variables', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ envKey?: string; envValue?: string; note?: string | null }>(request);
    const created = await envVariableService.createUser(userId, {
      envKey: body.envKey ?? '',
      envValue: body.envValue ?? '',
      note: body.note,
    });
    return sendOk(reply, toVO(created));
  });

  app.put('/v1/user/env-variables/:id', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ envKey?: string; envValue?: string; note?: string | null }>(request);
    const updated = await envVariableService.updateUser(userId, requireId(request), {
      envKey: body.envKey,
      envValue: body.envValue,
      note: body.note,
    });
    return sendOk(reply, toVO(updated));
  });

  app.delete('/v1/user/env-variables/:id', async (request, reply) => {
    const userId = requireUserId(request);
    await envVariableService.deleteUser(userId, requireId(request));
    return sendOk(reply);
  });

  app.get('/v1/user/workspace-env-variables', async (request, reply) => {
    const userId = requireUserId(request);
    const workspace = queryOptStr(request, 'workspace');
    const list = await envVariableService.listWorkspace(userId, workspace);
    return sendOk(reply, list.map(toVO));
  });

  app.post('/v1/user/workspace-env-variables', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ workspacePath?: string; envKey?: string; envValue?: string; note?: string | null }>(request);
    const created = await envVariableService.createWorkspace(userId, {
      workspacePath: body.workspacePath ?? '',
      envKey: body.envKey ?? '',
      envValue: body.envValue ?? '',
      note: body.note,
    });
    return sendOk(reply, toVO(created));
  });

  app.put('/v1/user/workspace-env-variables/:id', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ envKey?: string; envValue?: string; note?: string | null }>(request);
    const updated = await envVariableService.updateWorkspace(userId, requireId(request), {
      envKey: body.envKey,
      envValue: body.envValue,
      note: body.note,
    });
    return sendOk(reply, toVO(updated));
  });

  app.delete('/v1/user/workspace-env-variables/:id', async (request, reply) => {
    const userId = requireUserId(request);
    await envVariableService.deleteWorkspace(userId, requireId(request));
    return sendOk(reply);
  });

  app.get('/v1/sessions/:id/effective-env', async (request, reply) => {
    const userId = requireUserId(request);
    const sessionId = requireId(request);
    const session = await sessionLookup.findById(sessionId);
    if (!session) throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
    // 防越权读他人环境构成：会话归属必须与登录用户一致
    if (session.userId !== userId) throw new BusinessException(ErrorCode.FORBIDDEN);
    const result = await envVariableService.resolveEffectiveEnv(userId, session.workspace);
    return sendOk(reply, result);
  });
}

/** 管理侧：系统层 CRUD + 用户层只读（需求变更 c）。 */
export function registerAdminEnvVariableRoutes(app: FastifyInstance, deps: AdminEnvVariableRouteDeps): void {
  const { envVariableService, permissionService, userLookup } = deps;

  app.get('/v1/admin/system-env-variables', async (request, reply) => {
    await requirePermission(permissionService, requireUserId(request), 'settings:read');
    const list = await envVariableService.listSystem();
    return sendOk(reply, list.map(toVO));
  });

  app.post('/v1/admin/system-env-variables', async (request, reply) => {
    await requirePermission(permissionService, requireUserId(request), 'settings:write');
    const body = bodyOf<{ envKey?: string; envValue?: string; note?: string | null }>(request);
    const created = await envVariableService.createSystem({
      envKey: body.envKey ?? '',
      envValue: body.envValue ?? '',
      note: body.note,
    });
    return sendOk(reply, toVO(created));
  });

  app.put('/v1/admin/system-env-variables/:id', async (request, reply) => {
    await requirePermission(permissionService, requireUserId(request), 'settings:write');
    const body = bodyOf<{ envKey?: string; envValue?: string; note?: string | null }>(request);
    const updated = await envVariableService.updateSystem(requireId(request), {
      envKey: body.envKey,
      envValue: body.envValue,
      note: body.note,
    });
    return sendOk(reply, toVO(updated));
  });

  app.delete('/v1/admin/system-env-variables/:id', async (request, reply) => {
    await requirePermission(permissionService, requireUserId(request), 'settings:write');
    await envVariableService.deleteSystem(requireId(request));
    return sendOk(reply);
  });

  // 只读视图：键名明文 + 值密文长度掩码；不提供任何写路由（管理员不可代配用户变量）
  app.get('/v1/admin/users/:id/env-variables', async (request, reply) => {
    await requirePermission(permissionService, requireUserId(request), 'user:read');
    const targetUserId = requireId(request);
    const username = await usernameOf(userLookup, targetUserId);
    const list = await envVariableService.listUserForAdmin(targetUserId);
    return sendOk(reply, list.map((row) => toAdminVO(row, targetUserId, username, null)));
  });

  app.get('/v1/admin/users/:id/workspace-env-variables', async (request, reply) => {
    await requirePermission(permissionService, requireUserId(request), 'user:read');
    const targetUserId = requireId(request);
    const username = await usernameOf(userLookup, targetUserId);
    const workspace = queryOptStr(request, 'workspace');
    const list = await envVariableService.listWorkspaceForAdmin(targetUserId, workspace);
    return sendOk(reply, list.map((row) => toAdminVO(row, targetUserId, username, row.workspacePath ?? null)));
  });
}

/** 用户侧 VO：不含 value 字段（连 **** 占位都不给），值只在服务端内存与 DB 密文中存在。 */
/** 路径 id 必须是正整数：NaN 直接透传到 SQL 绑定会抛 500，这里提前拒绝。 */
function requireId(request: FastifyRequest, name = 'id'): number {
  const id = pathId(request, name);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'ID 无效');
  }
  return id;
}

function toVO(row: EnvVariable) {
  return {
    id: row.id,
    envKey: row.envKey,
    note: row.note ?? null,
    createdAt: isoTime(row.createdAt),
    updatedAt: isoTime(row.updatedAt),
  };
}

function toAdminVO(row: EnvVariable, userId: number, username: string, workspacePath: string | null) {
  return {
    id: row.id,
    userId,
    username,
    workspacePath,
    envKey: row.envKey,
    maskedValue: maskEnvValueForAdmin(row.envValue),
    note: row.note ?? null,
    createdAt: isoTime(row.createdAt),
    updatedAt: isoTime(row.updatedAt),
  };
}

async function usernameOf(userLookup: UserLookup | undefined, userId: number): Promise<string> {
  if (!userLookup) return '';
  const user = await userLookup.findById(userId).catch(() => null);
  return user?.username ?? '';
}

function isoTime(value: string | null | undefined): string | null {
  if (value == null || value === '') return null;
  return String(value).replace(' ', 'T');
}
