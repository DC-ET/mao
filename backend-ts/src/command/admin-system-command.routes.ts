import type { FastifyInstance } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';
import { requireRequestPermission, sendJson, sendOk } from '../common/http-error.js';
import { bodyOf, pathId, pathParam, queryOptInt, queryOptStr } from '../common/request.js';
import { fail } from '../common/result.js';
import type { CommandVisibility } from '@mao/contracts';
import { SYSTEM_USER_ID } from './command.service.js';
import type { AdminUserCommandVO, CommandRoleGrant, CommandRoleOption, UserCommand, UserCommandRepository } from './types.js';

const ROLE_IDS_REQUIRED = '指定角色时至少选择一个角色';
const VISIBILITY_INVALID = '可见范围只能是 all 或 roles';
const ROLE_ID_INVALID = '角色 ID 必须是正整数';
const ROLE_UNKNOWN = '存在未知或已删除的角色';

const NAME_PATTERN = /^[a-zA-Z0-9\u4e00-\u9fa5_-]+$/;

export interface AdminSystemCommandRouteDeps {
  commandRepo: UserCommandRepository;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
  userLookup?: {
    findByIds(ids: number[]): Promise<Array<{ id: number; username: string; displayName?: string | null }>>;
  };
}

interface VisibilityBody {
  visibility?: unknown;
  roleIds?: unknown;
}

interface CreateSystemCommandRequest extends VisibilityBody {
  name?: string;
  content?: string;
}

interface UpdateSystemCommandRequest extends VisibilityBody {
  name?: string;
  content?: string;
}

interface PromotePersonalCommandRequest extends VisibilityBody {
  name?: string;
  content?: string;
}

export function registerAdminSystemCommandRoutes(app: FastifyInstance, deps: AdminSystemCommandRouteDeps): void {
  const { commandRepo, permissionService, userLookup } = deps;

  // 列表：查询所有系统指令
  app.get('/v1/admin/system-commands', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'command:read');
    const commands = await commandRepo.listByUserId(SYSTEM_USER_ID);
    return sendOk(reply, await toSystemAdminVOList(commandRepo, commands));
  });

  // 角色下拉。必须写在 /:id 之前，否则 role-options 会被当成 id。
  app.get('/v1/admin/system-commands/role-options', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'command:read');
    const roles = await commandRepo.listActiveRoles();
    return sendOk(reply, roles.map(toRoleOption));
  });

  // 详情：查询单条系统指令
  app.get('/v1/admin/system-commands/:id', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'command:read');
    const command = await commandRepo.findByIdAndUserId(pathId(request), SYSTEM_USER_ID);
    if (command == null) {
      return sendJson(reply, 200, fail(404, '指令不存在'));
    }
    const [vo] = await toSystemAdminVOList(commandRepo, [command]);
    return sendOk(reply, vo);
  });

  // 新增：创建系统指令
  app.post('/v1/admin/system-commands', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'command:write');
    const body = bodyOf<CreateSystemCommandRequest>(request);
    if (!hasText(body.name)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '指令名称不能为空');
    }
    if (!hasText(body.content)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '指令内容不能为空');
    }
    validateName(body.name!);

    const existing = await commandRepo.findByUserIdAndName(SYSTEM_USER_ID, body.name!);
    if (existing != null) {
      throw new BusinessException(ErrorCode.COMMAND_NAME_DUPLICATE);
    }

    const scope = await resolveVisibility(commandRepo, body, true);
    const command: UserCommand = { userId: SYSTEM_USER_ID, name: body.name!, content: body.content! };
    await commandRepo.insertWithVisibility(command, scope.visibility, scope.roleIds);
    const [vo] = await toSystemAdminVOList(commandRepo, [command]);
    return sendOk(reply, vo);
  });

  // 编辑：更新系统指令
  app.put('/v1/admin/system-commands/:id', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'command:write');
    const body = bodyOf<UpdateSystemCommandRequest>(request);
    if (!hasText(body.content)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '指令内容不能为空');
    }

    const command = await commandRepo.findByIdAndUserId(pathId(request), SYSTEM_USER_ID);
    if (command == null) {
      throw new BusinessException(ErrorCode.COMMAND_NOT_FOUND);
    }

    if (hasText(body.name) && body.name !== command.name) {
      validateName(body.name!);
      const existing = await commandRepo.findByUserIdAndName(SYSTEM_USER_ID, body.name!);
      if (existing != null && existing.id !== command.id) {
        throw new BusinessException(ErrorCode.COMMAND_NAME_DUPLICATE);
      }
      command.name = body.name!;
    }

    command.content = body.content!;
    if (body.visibility === undefined) {
      await commandRepo.updateById(command);
    } else {
      const scope = await resolveVisibility(commandRepo, body, false);
      await commandRepo.updateWithVisibility(command, scope.visibility, scope.roleIds);
    }
    const [vo] = await toSystemAdminVOList(commandRepo, [command]);
    return sendOk(reply, vo);
  });

  // 删除：删除系统指令
  app.delete('/v1/admin/system-commands/:id', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'command:write');
    const command = await commandRepo.findByIdAndUserId(pathId(request), SYSTEM_USER_ID);
    if (command == null) {
      throw new BusinessException(ErrorCode.COMMAND_NOT_FOUND);
    }
    await commandRepo.deleteById(pathId(request));
    return sendOk(reply);
  });

  // 列表：跨用户查看个人指令。支持 pageNum/pageSize/keyword/userId（keyword 匹配指令名/内容，LIKE 已转义；
  // userId 过滤指定用户的个人指令）。兼容约定：不传任何新参数时返回全量数组；传入分页/关键词/用户后按条件过滤分页，
  // 返回结构仍为数组（前端按数组消费），条件过滤时的总数通过响应头 x-total-count 透出。
  app.get('/v1/admin/user-commands', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'command:read');
    const pageNum = queryOptInt(request, 'pageNum');
    const pageSize = queryOptInt(request, 'pageSize');
    const keyword = queryOptStr(request, 'keyword');
    const userId = queryOptInt(request, 'userId');
    const filtered = pageNum != null || pageSize != null || keyword != null || userId != null;
    if (!filtered) {
      const commands = await commandRepo.listPersonalAll();
      return sendOk(reply, await toAdminUserVOList(commands, userLookup));
    }
    const page = await commandRepo.listPersonalPaged(
      Math.max(1, pageNum ?? 1),
      Math.min(200, Math.max(1, pageSize ?? 20)),
      keyword,
      userId,
    );
    reply.header('x-total-count', String(page.total));
    return sendOk(reply, await toAdminUserVOList(page.records, userLookup));
  });

  // 详情：查询指定用户的个人指令
  app.get('/v1/admin/user-commands/:userId/:id', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'command:read');
    const userId = Number(pathParam(request, 'userId'));
    if (!Number.isInteger(userId) || userId <= 0) {
      return sendJson(reply, 200, fail(400, '无效的用户 ID'));
    }
    const command = await commandRepo.findByIdAndUserId(pathId(request), userId);
    if (command == null || command.userId === SYSTEM_USER_ID) {
      return sendJson(reply, 200, fail(404, '指令不存在'));
    }
    return sendOk(reply, toAdminVO(command));
  });

  // 提升：把个人指令复制为系统指令（user_id=0）。原个人指令保留。
  // 可选 body.name / body.content 覆盖后再写入，便于避开已有系统指令重名或微调正文。
  app.post('/v1/admin/user-commands/:userId/:id/promote', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'command:write');
    const userId = Number(pathParam(request, 'userId'));
    if (!Number.isInteger(userId) || userId <= 0) {
      return sendJson(reply, 200, fail(400, '无效的用户 ID'));
    }
    const source = await commandRepo.findByIdAndUserId(pathId(request), userId);
    if (source == null || source.userId === SYSTEM_USER_ID) {
      return sendJson(reply, 200, fail(404, '指令不存在'));
    }

    const body = bodyOf<PromotePersonalCommandRequest>(request);
    const name = hasText(body.name) ? body.name!.trim() : source.name;
    const content = body.content !== undefined ? body.content : source.content;
    if (!hasText(name)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '指令名称不能为空');
    }
    if (!hasText(content)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '指令内容不能为空');
    }
    validateName(name);

    const existing = await commandRepo.findByUserIdAndName(SYSTEM_USER_ID, name);
    if (existing != null) {
      throw new BusinessException(ErrorCode.COMMAND_NAME_DUPLICATE);
    }

    const scope = await resolveVisibility(commandRepo, body, true);
    const command: UserCommand = { userId: SYSTEM_USER_ID, name, content };
    await commandRepo.insertWithVisibility(command, scope.visibility, scope.roleIds);
    const [vo] = await toSystemAdminVOList(commandRepo, [command]);
    return sendOk(reply, vo);
  });

  // 删除：删除指定用户的个人指令
  app.delete('/v1/admin/user-commands/:userId/:id', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'command:write');
    const userId = Number(pathParam(request, 'userId'));
    if (!Number.isInteger(userId) || userId <= 0) {
      return sendJson(reply, 200, fail(400, '无效的用户 ID'));
    }
    const command = await commandRepo.findByIdAndUserId(pathId(request), userId);
    if (command == null || command.userId === SYSTEM_USER_ID) {
      return sendJson(reply, 200, fail(404, '指令不存在'));
    }
    await commandRepo.deleteById(pathId(request));
    return sendOk(reply);
  });
}

function validateName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new BusinessException(ErrorCode.COMMAND_NAME_INVALID);
  }
}

function toAdminVO(command: UserCommand): AdminUserCommandVO {
  return {
    id: command.id,
    userId: command.userId,
    name: command.name,
    content: command.content,
    visibility: 'all',
    roleIds: [],
    roleNames: [],
    createdAt: command.createdAt ?? null,
    updatedAt: command.updatedAt ?? null,
  };
}

function toRoleOption(role: CommandRoleOption): CommandRoleOption {
  return { id: role.id, name: role.name, code: role.code };
}

/** 未传 visibility：创建缺省 all；更新则保持原值（调用方不要写角色行）。 */
async function resolveVisibility(
  commandRepo: UserCommandRepository,
  body: VisibilityBody,
  create: boolean,
): Promise<{ visibility: CommandVisibility; roleIds: number[] }> {
  if (body.visibility === undefined) {
    if (create) return { visibility: 'all', roleIds: [] };
    throw new Error('resolveVisibility requires visibility on update');
  }
  if (body.visibility !== 'all' && body.visibility !== 'roles') {
    throw new BusinessException(ErrorCode.PARAM_INVALID, VISIBILITY_INVALID);
  }
  if (body.visibility === 'all') {
    return { visibility: 'all', roleIds: [] };
  }
  const roleIds = parseRoleIds(body.roleIds);
  if (roleIds.length === 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, ROLE_IDS_REQUIRED);
  }
  const found = await commandRepo.findActiveRolesByIds(roleIds);
  if (found.length !== roleIds.length) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, ROLE_UNKNOWN);
  }
  return { visibility: 'roles', roleIds: sortRoleIds(found) };
}

function parseRoleIds(raw: unknown): number[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, ROLE_ID_INVALID);
  }
  const ids: number[] = [];
  for (const item of raw) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item <= 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, ROLE_ID_INVALID);
    }
    if (!ids.includes(item)) ids.push(item);
  }
  return ids;
}

function sortRoleIds(roles: CommandRoleOption[]): number[] {
  return [...roles]
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id - b.id)
    .map((role) => role.id);
}

function storedVisibility(command: UserCommand): CommandVisibility {
  if (command.visibility == null || command.visibility === 'all') return 'all';
  return 'roles';
}

async function toSystemAdminVOList(
  commandRepo: UserCommandRepository,
  commands: UserCommand[],
): Promise<AdminUserCommandVO[]> {
  const ids = commands.flatMap((command) => (command.id == null ? [] : [command.id]));
  const grants = await commandRepo.listActiveRoleGrants(ids);
  const byCommand = new Map<number, CommandRoleGrant[]>();
  for (const grant of grants) {
    const list = byCommand.get(grant.commandId) ?? [];
    list.push(grant);
    byCommand.set(grant.commandId, list);
  }
  return commands.map((command) => {
    const visibility = storedVisibility(command);
    const rows = visibility === 'roles' && command.id != null ? (byCommand.get(command.id) ?? []) : [];
    return {
      ...toAdminVO(command),
      visibility,
      roleIds: rows.map((row) => row.roleId),
      roleNames: rows.map((row) => row.roleName),
    };
  });
}

async function toAdminUserVOList(
  records: UserCommand[],
  userLookup: AdminSystemCommandRouteDeps['userLookup'],
): Promise<AdminUserCommandVO[]> {
  const userIds = [...new Set(records.map((c) => c.userId))];
  const users = userIds.length > 0 && userLookup ? await userLookup.findByIds(userIds) : [];
  const userMap = new Map(users.map((u) => [u.id, u]));
  return records.map((command) => {
    const user = userMap.get(command.userId);
    return {
      ...toAdminVO(command),
      userId: command.userId,
      username: user?.username ?? null,
      displayName: user?.displayName ?? null,
    } satisfies AdminUserCommandVO;
  });
}
