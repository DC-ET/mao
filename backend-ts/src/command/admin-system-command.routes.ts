import type { FastifyInstance } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';
import { requireAdmin, sendJson, sendOk } from '../common/http-error.js';
import { bodyOf, pathId, pathParam } from '../common/request.js';
import { fail } from '../common/result.js';
import { SYSTEM_USER_ID } from './command.service.js';
import type { AdminUserCommandVO, UserCommand, UserCommandRepository } from './types.js';

const NAME_PATTERN = /^[a-zA-Z0-9\u4e00-\u9fa5_-]+$/;

export interface AdminSystemCommandRouteDeps {
  commandRepo: UserCommandRepository;
  permissionService: { isAdmin(userId: number | null | undefined): Promise<boolean> };
  userLookup?: {
    findByIds(ids: number[]): Promise<Array<{ id: number; username: string; displayName?: string | null }>>;
  };
}

interface CreateSystemCommandRequest {
  name?: string;
  content?: string;
}

interface UpdateSystemCommandRequest {
  name?: string;
  content?: string;
}

export function registerAdminSystemCommandRoutes(app: FastifyInstance, deps: AdminSystemCommandRouteDeps): void {
  const { commandRepo, permissionService, userLookup } = deps;

  // 列表：查询所有系统指令
  app.get('/v1/admin/system-commands', async (request, reply) => {
    await requireAdmin(permissionService, request);
    const commands = await commandRepo.listByUserId(SYSTEM_USER_ID);
    return sendOk(reply, commands.map(toAdminVO));
  });

  // 详情：查询单条系统指令
  app.get('/v1/admin/system-commands/:id', async (request, reply) => {
    await requireAdmin(permissionService, request);
    const command = await commandRepo.findByIdAndUserId(pathId(request), SYSTEM_USER_ID);
    if (command == null) {
      return sendJson(reply, 200, fail(404, '指令不存在'));
    }
    return sendOk(reply, toAdminVO(command));
  });

  // 新增：创建系统指令
  app.post('/v1/admin/system-commands', async (request, reply) => {
    await requireAdmin(permissionService, request);
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

    const command: UserCommand = { userId: SYSTEM_USER_ID, name: body.name!, content: body.content! };
    await commandRepo.insert(command);
    return sendOk(reply, toAdminVO(command));
  });

  // 编辑：更新系统指令
  app.put('/v1/admin/system-commands/:id', async (request, reply) => {
    await requireAdmin(permissionService, request);
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
    await commandRepo.updateById(command);
    return sendOk(reply, toAdminVO(command));
  });

  // 删除：删除系统指令
  app.delete('/v1/admin/system-commands/:id', async (request, reply) => {
    await requireAdmin(permissionService, request);
    const command = await commandRepo.findByIdAndUserId(pathId(request), SYSTEM_USER_ID);
    if (command == null) {
      throw new BusinessException(ErrorCode.COMMAND_NOT_FOUND);
    }
    await commandRepo.deleteById(pathId(request));
    return sendOk(reply);
  });

  // 列表：跨用户查看个人指令
  app.get('/v1/admin/user-commands', async (request, reply) => {
    await requireAdmin(permissionService, request);
    const commands = await commandRepo.listPersonalAll();
    const userIds = [...new Set(commands.map((c) => c.userId))];
    const users = userIds.length > 0 && userLookup ? await userLookup.findByIds(userIds) : [];
    const userMap = new Map(users.map((u) => [u.id, u]));
    return sendOk(reply, commands.map((command) => {
      const user = userMap.get(command.userId);
      return {
        ...toAdminVO(command),
        userId: command.userId,
        username: user?.username ?? null,
        displayName: user?.displayName ?? null,
      } satisfies AdminUserCommandVO;
    }));
  });

  // 详情：查询指定用户的个人指令
  app.get('/v1/admin/user-commands/:userId/:id', async (request, reply) => {
    await requireAdmin(permissionService, request);
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

  // 删除：删除指定用户的个人指令
  app.delete('/v1/admin/user-commands/:userId/:id', async (request, reply) => {
    await requireAdmin(permissionService, request);
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
    createdAt: command.createdAt ?? null,
    updatedAt: command.updatedAt ?? null,
  };
}
