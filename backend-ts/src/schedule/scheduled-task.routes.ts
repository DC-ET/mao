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

/** 读门槛：跨用户列表/详情/预览。 */
const READ_PERMISSION = 'scheduled-task:read';
/** 写门槛：编辑、启停、删除他人任务。 */
const WRITE_PERMISSION = 'scheduled-task:write';

export function registerScheduledTaskRoutes(app: FastifyInstance, deps: ScheduledTaskRouteDeps): void {
  /** 未接 permission 时视为无管理旁路（本人任务仍可操作）。 */
  async function hasPermission(userId: number, code: string): Promise<boolean> {
    return deps.permission ? await deps.permission.hasPermission(userId, code) : false;
  }

  app.get('/v1/scheduled-tasks', async (req, reply) => {
    const userId = requireUserId(req, deps.jwt);
    sendJson(reply, 200, ok(await deps.service.listByUser(userId)));
  });

  app.get('/v1/scheduled-tasks/all', async (req, reply) => {
    const userId = requireUserId(req, deps.jwt);
    if (deps.permission && !(await hasPermission(userId, READ_PERMISSION))) {
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

  /**
   * Cron 表达式预览：只读语义，用同一套解析（含 Spring `?` 兼容）与同一时区算未来触发时间。
   * 非法表达式返回 ok + valid:false，不抛异常——编辑过程中输到一半属预期状态，不该弹全局错误。
   */
  app.post('/v1/scheduled-tasks/cron-preview', async (req, reply) => {
    const userId = requireUserId(req, deps.jwt);
    if (deps.permission && !(await hasPermission(userId, READ_PERMISSION))) {
      throw new BusinessException(ErrorCode.FORBIDDEN);
    }
    const body = (req.body ?? {}) as { expression?: unknown; count?: unknown };
    if (typeof body.expression !== 'string') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'expression 必须为字符串');
    }
    const count = body.count == null ? 3 : Number(body.count);
    if (!Number.isFinite(count)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'count 必须为数字');
    }
    sendJson(reply, 200, ok(deps.service.previewCron(body.expression, count)));
  });

  app.get('/v1/scheduled-tasks/:id', async (req, reply) => {
    const userId = requireUserId(req, deps.jwt);
    const id = Number((req.params as { id: string }).id);
    const task = await deps.service.getById(id);
    if (task == null) {
      sendJson(reply, 200, failCode(ErrorCode.SCHEDULED_TASK_NOT_FOUND));
      return;
    }
    if (task.userId !== userId && !(await hasPermission(userId, READ_PERMISSION))) {
      sendJson(reply, 200, failCode(ErrorCode.SCHEDULED_TASK_ACCESS_DENIED));
      return;
    }
    sendJson(reply, 200, ok(task));
  });

  app.put('/v1/scheduled-tasks/:id', async (req, reply) => {
    const userId = requireUserId(req, deps.jwt);
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { name?: string; prompt?: string; cronExpression?: string; status?: string; once?: boolean };
    const allowNonOwner = await hasPermission(userId, WRITE_PERMISSION);
    sendJson(reply, 200, ok(await deps.service.updateTask(id, userId, body.name, body.prompt, body.cronExpression, body.status, body.once, { allowNonOwner })));
  });

  app.delete('/v1/scheduled-tasks/:id', async (req, reply) => {
    const userId = requireUserId(req, deps.jwt);
    const id = Number((req.params as { id: string }).id);
    const allowNonOwner = await hasPermission(userId, WRITE_PERMISSION);
    await deps.service.deleteTask(id, userId, { allowNonOwner });
    sendJson(reply, 200, ok(null));
  });
}
