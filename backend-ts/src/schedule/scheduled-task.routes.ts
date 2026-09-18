import type { FastifyInstance } from 'fastify';
import { requireUserId } from '../common/auth.js';
import { sendJson } from '../common/http-error.js';
import { failCode, ok } from '../common/result.js';
import { ErrorCode } from '../common/error-code.js';
import { queryInt, queryOptBool, queryOptInt, queryOptStr } from '../common/request.js';
import type { JwtService } from '../crypto/jwt.service.js';
import type { PermissionService } from '../permission/permission.service.js';
import { BusinessException } from '../common/business-exception.js';
import type { ScheduledTaskService } from './scheduled-task.service.js';

export interface ScheduledTaskRouteDeps {
  jwt: JwtService;
  service: ScheduledTaskService;
  permission?: PermissionService;
}

export function registerScheduledTaskRoutes(app: FastifyInstance, deps: ScheduledTaskRouteDeps): void {
  /** 持 session:read 可跨用户读写；未接 permission 时视为无管理旁路 */
  async function hasManagePermission(userId: number): Promise<boolean> {
    return deps.permission ? await deps.permission.hasPermission(userId, 'session:read') : false;
  }

  app.get('/v1/scheduled-tasks', async (req, reply) => {
    const userId = requireUserId(req, deps.jwt);
    sendJson(reply, 200, ok(await deps.service.listByUser(userId)));
  });

  app.get('/v1/scheduled-tasks/all', async (req, reply) => {
    const userId = requireUserId(req, deps.jwt);
    if (deps.permission && !(await hasManagePermission(userId))) {
      throw new BusinessException(ErrorCode.FORBIDDEN);
    }
    const page = queryInt(req, 'pageNum', 1);
    const size = queryInt(req, 'pageSize', 20);
    const status = queryOptStr(req, 'status');
    if (status != null && status !== 'ACTIVE' && status !== 'PAUSED') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'status 只能为 ACTIVE 或 PAUSED');
    }
    sendJson(reply, 200, ok(await deps.service.listAll(page, size, {
      keyword: queryOptStr(req, 'keyword'),
      userId: queryOptInt(req, 'userId') ?? null,
      agentId: queryOptInt(req, 'agentId') ?? null,
      status,
      finished: queryOptBool(req, 'finished') ?? null,
    })));
  });

  app.get('/v1/scheduled-tasks/:id', async (req, reply) => {
    const userId = requireUserId(req, deps.jwt);
    const id = Number((req.params as { id: string }).id);
    const task = await deps.service.getById(id);
    if (task == null) {
      sendJson(reply, 200, failCode(ErrorCode.SCHEDULED_TASK_NOT_FOUND));
      return;
    }
    if (task.userId !== userId && !(await hasManagePermission(userId))) {
      sendJson(reply, 200, failCode(ErrorCode.SCHEDULED_TASK_ACCESS_DENIED));
      return;
    }
    sendJson(reply, 200, ok(task));
  });

  app.put('/v1/scheduled-tasks/:id', async (req, reply) => {
    const userId = requireUserId(req, deps.jwt);
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { name?: string; prompt?: string; cronExpression?: string; status?: string; once?: boolean };
    const allowNonOwner = await hasManagePermission(userId);
    sendJson(reply, 200, ok(await deps.service.updateTask(id, userId, body.name, body.prompt, body.cronExpression, body.status, body.once, { allowNonOwner })));
  });

  app.delete('/v1/scheduled-tasks/:id', async (req, reply) => {
    const userId = requireUserId(req, deps.jwt);
    const id = Number((req.params as { id: string }).id);
    const allowNonOwner = await hasManagePermission(userId);
    await deps.service.deleteTask(id, userId, { allowNonOwner });
    sendJson(reply, 200, ok(null));
  });
}
