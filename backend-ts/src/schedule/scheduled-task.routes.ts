import type { FastifyInstance } from 'fastify';
import { requireUserId } from '../common/auth.js';
import { sendJson } from '../common/http-error.js';
import { failCode, ok } from '../common/result.js';
import { ErrorCode } from '../common/error-code.js';
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
  app.get('/v1/scheduled-tasks', async (req, reply) => {
    const userId = requireUserId(req, deps.jwt);
    sendJson(reply, 200, ok(await deps.service.listByUser(userId)));
  });

  app.get('/v1/scheduled-tasks/all', async (req, reply) => {
    const userId = requireUserId(req, deps.jwt);
    if (deps.permission && !(await deps.permission.hasPermission(userId, 'session:read'))) {
      throw new BusinessException(ErrorCode.FORBIDDEN);
    }
    const q = req.query as { pageNum?: string; pageSize?: string };
    sendJson(reply, 200, ok(await deps.service.listAll(Number(q.pageNum ?? 1), Number(q.pageSize ?? 20))));
  });

  app.get('/v1/scheduled-tasks/:id', async (req, reply) => {
    const userId = requireUserId(req, deps.jwt);
    const id = Number((req.params as { id: string }).id);
    const task = await deps.service.getById(id);
    if (task == null) {
      sendJson(reply, 200, failCode(ErrorCode.SCHEDULED_TASK_NOT_FOUND));
      return;
    }
    if (task.userId !== userId) {
      sendJson(reply, 200, failCode(ErrorCode.SCHEDULED_TASK_ACCESS_DENIED));
      return;
    }
    sendJson(reply, 200, ok(task));
  });

  app.put('/v1/scheduled-tasks/:id', async (req, reply) => {
    const userId = requireUserId(req, deps.jwt);
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { name?: string; prompt?: string; cronExpression?: string; status?: string; once?: boolean };
    sendJson(reply, 200, ok(await deps.service.updateTask(id, userId, body.name, body.prompt, body.cronExpression, body.status, body.once)));
  });

  app.delete('/v1/scheduled-tasks/:id', async (req, reply) => {
    const userId = requireUserId(req, deps.jwt);
    const id = Number((req.params as { id: string }).id);
    await deps.service.deleteTask(id, userId);
    sendJson(reply, 200, ok(null));
  });
}
