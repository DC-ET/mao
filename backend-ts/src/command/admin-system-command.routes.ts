import type { FastifyInstance } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';
import { requireAdmin, sendJson, sendOk } from '../common/http-error.js';
import { bodyOf, pathId } from '../common/request.js';
import { fail } from '../common/result.js';
import { SYSTEM_USER_ID } from './command.service.js';
import type { UserCommand, UserCommandRepository, UserCommandVO } from './types.js';

const NAME_PATTERN = /^[a-zA-Z0-9\u4e00-\u9fa5_-]+$/;

export interface AdminSystemCommandRouteDeps {
  commandRepo: UserCommandRepository;
  permissionService: { isAdmin(userId: number | null | undefined): Promise<boolean> };
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
  const { commandRepo, permissionService } = deps;

  // 列表：查询所有系统指令
  app.get('/v1/admin/system-commands', async (request, reply) => {
    await requireAdmin(permissionService, request);
    const commands = await commandRepo.listByUserId(SYSTEM_USER_ID);
    return sendOk(reply, commands.map(toVO));
  });

  // 详情：查询单条系统指令
  app.get('/v1/admin/system-commands/:id', async (request, reply) => {
    await requireAdmin(permissionService, request);
    const command = await commandRepo.findByIdAndUserId(pathId(request), SYSTEM_USER_ID);
    if (command == null) {
      return sendJson(reply, 200, fail(404, '指令不存在'));
    }
    return sendOk(reply, toVO(command));
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
    return sendOk(reply, toVO(command));
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
    return sendOk(reply, toVO(command));
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
}

function validateName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new BusinessException(ErrorCode.COMMAND_NAME_INVALID);
  }
}

function toVO(command: UserCommand): UserCommandVO {
  return {
    id: command.id,
    name: command.name,
    content: command.content,
  };
}