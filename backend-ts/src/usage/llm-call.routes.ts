import type { FastifyInstance } from 'fastify';
import { requireAdmin, requireUserId, sendOk } from '../common/http-error.js';
import { queryInt, queryOptBool, queryOptInt, queryOptStr } from '../common/request.js';
import type { PermissionService } from '../permission/permission.service.js';
import type { LlmCallService } from './llm-call.service.js';

export interface LlmCallRouteDeps {
  llmCallService: LlmCallService;
  permissionService: PermissionService;
}

function parseDateRange(startDate?: string, endDate?: string): { startAt?: string; endAt?: string } {
  return {
    startAt: startDate ? `${startDate} 00:00:00` : undefined,
    endAt: endDate ? `${endDate} 23:59:59` : undefined,
  };
}

export function registerLlmCallRoutes(app: FastifyInstance, deps: LlmCallRouteDeps): void {
  app.get('/v1/admin/llm-calls', async (request, reply) => {
    await requireAdmin(deps.permissionService, request);
    const page = queryInt(request, 'page', 1);
    const size = queryInt(request, 'size', 20);
    const startDate = queryOptStr(request, 'startDate');
    const endDate = queryOptStr(request, 'endDate');
    const range = parseDateRange(startDate, endDate);
    const result = await deps.llmCallService.listForAdmin(page, size, {
      userId: queryOptInt(request, 'userId'),
      sessionId: queryOptInt(request, 'sessionId'),
      agentId: queryOptInt(request, 'agentId'),
      modelId: queryOptInt(request, 'modelId'),
      scene: queryOptStr(request, 'scene'),
      success: queryOptBool(request, 'success'),
      startAt: range.startAt,
      endAt: range.endAt,
    });
    return sendOk(reply, result);
  });

  app.get('/v1/llm-calls/me', async (request, reply) => {
    const userId = requireUserId(request);
    const page = queryInt(request, 'page', 1);
    const size = queryInt(request, 'size', 20);
    const startDate = queryOptStr(request, 'startDate');
    const endDate = queryOptStr(request, 'endDate');
    const range = parseDateRange(startDate, endDate);
    const result = await deps.llmCallService.listForUser(userId, page, size, {
      sessionId: queryOptInt(request, 'sessionId'),
      modelId: queryOptInt(request, 'modelId'),
      scene: queryOptStr(request, 'scene'),
      success: queryOptBool(request, 'success'),
      startAt: range.startAt,
      endAt: range.endAt,
    });
    return sendOk(reply, result);
  });
}
