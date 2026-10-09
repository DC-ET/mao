import type { FastifyInstance } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requireRequestPermission, sendJson, sendOk } from '../common/http-error.js';
import { bodyOf, queryInt, queryOptInt, queryOptStr } from '../common/request.js';
import { fail, ok } from '../common/result.js';
import type { PermissionService } from '../permission/permission.service.js';
import { requireJwtIdentity } from './access.js';
import type { OpenApiCallLogService } from './open-api-call-log.service.js';

export interface OpenApiCallLogRouteDeps {
  callLog: OpenApiCallLogService;
  permissionService: PermissionService;
}

function parsePage(request: Parameters<typeof queryInt>[0]): { page: number; size: number } {
  const size = queryInt(request, 'size', 20);
  return { page: queryInt(request, 'page', 1), size: Math.min(100, size) };
}

function listFilter(request: Parameters<typeof queryOptInt>[0], userId?: number) {
  return {
    userId,
    tokenId: queryOptInt(request, 'tokenId'),
    triggerId: queryOptInt(request, 'triggerId'),
    agentId: queryOptInt(request, 'agentId'),
    outcome: queryOptStr(request, 'outcome'),
    source: queryOptStr(request, 'source'),
    httpStatus: queryOptInt(request, 'httpStatus'),
    startAt: dateStart(queryOptStr(request, 'startDate')),
    endAt: dateEnd(queryOptStr(request, 'endDate')),
  };
}

function dateStart(day: string | undefined): string | undefined {
  return day != null && /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day} 00:00:00` : undefined;
}

function dateEnd(day: string | undefined): string | undefined {
  return day != null && /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day} 23:59:59` : undefined;
}

function pathId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new BusinessException(ErrorCode.PARAM_INVALID, '路径参数 id 必须为正整数');
  return id;
}

export function registerOpenApiCallLogRoutes(app: FastifyInstance, deps: OpenApiCallLogRouteDeps): void {
  app.get('/v1/open/calls', async (request, reply) => {
    const userId = requireJwtIdentity(request);
    const page = parsePage(request);
    return sendOk(reply, await deps.callLog.listForUser(userId, page.page, page.size, listFilter(request)));
  });

  app.get('/v1/open/calls/:id', async (request, reply) => {
    const userId = requireJwtIdentity(request);
    const id = pathId((request.params as { id: string }).id);
    const row = await deps.callLog.getForUser(userId, id);
    if (row == null) return sendJson(reply, 404, fail(ErrorCode.PARAM_INVALID.code, '调用记录不存在'));
    return sendOk(reply, row);
  });

  app.get('/v1/admin/openapi/calls', async (request, reply) => {
    await requireRequestPermission(deps.permissionService, request, 'openapi:read');
    const page = parsePage(request);
    const userId = queryOptInt(request, 'userId');
    return sendOk(reply, await deps.callLog.listForAdmin(page.page, page.size, listFilter(request, userId)));
  });

  app.get('/v1/admin/openapi/calls/:id', async (request, reply) => {
    await requireRequestPermission(deps.permissionService, request, 'openapi:read');
    const id = pathId((request.params as { id: string }).id);
    return sendOk(reply, await deps.callLog.getForAdmin(id));
  });

  app.get('/v1/admin/openapi/call-stats', async (request, reply) => {
    await requireRequestPermission(deps.permissionService, request, 'openapi:read');
    const granularity = queryOptStr(request, 'granularity') === 'token' ? 'token' : 'day';
    return sendOk(reply, await deps.callLog.stats({
      granularity,
      startDate: queryOptStr(request, 'startDate'),
      endDate: queryOptStr(request, 'endDate'),
      tokenId: queryOptInt(request, 'tokenId'),
      agentId: queryOptInt(request, 'agentId'),
    }));
  });

  app.post('/v1/admin/openapi/calls/:id/replay', async (request, reply) => {
    await requireRequestPermission(deps.permissionService, request, 'openapi:replay');
    const id = pathId((request.params as { id: string }).id);
    const body = bodyOf<{ message?: unknown }>(request);
    const message = typeof body.message === 'string' ? body.message : undefined;
    try {
      const result = await deps.callLog.replay(id, message);
      sendJson(reply, 202, ok({ sessionId: result.sessionId, messageId: result.messageId, queued: result.queued }));
    } catch (e) {
      if (e instanceof BusinessException && e.code === ErrorCode.SESSION_NOT_FOUND.code) {
        sendJson(reply, 404, fail(e.code, '原会话已删除，无法重发'));
        return;
      }
      throw e;
    }
  });
}
