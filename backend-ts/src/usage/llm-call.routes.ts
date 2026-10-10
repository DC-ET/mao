import type { FastifyInstance } from 'fastify';
import { requireRequestPermission, requireUserId, sendOk } from '../common/http-error.js';
import { queryInt, queryOptBool, queryOptInt, queryOptStr } from '../common/request.js';
import type { PermissionService } from '../permission/permission.service.js';
import { parseUsageRange, type LlmCallService } from './llm-call.service.js';
import type { TrendGranularity } from './llm-call.repository.js';

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

/** 趋势粒度白名单：非 'hour' 一律回落 'day'（与管理后台 trends 同口径）。 */
function parseGranularity(value?: string): TrendGranularity {
  return value === 'hour' ? 'hour' : 'day';
}

export function registerLlmCallRoutes(app: FastifyInstance, deps: LlmCallRouteDeps): void {
  app.get('/v1/admin/llm-calls', async (request, reply) => {
    await requireRequestPermission(deps.permissionService, request, 'llm-call:read');
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

  // 当前用户自己的用量总览（总账 + 按模型 + 按场景）。仅需登录，不加权限码。
  app.get('/v1/llm-calls/me/summary', async (request, reply) => {
    const userId = requireUserId(request);
    const range = parseUsageRange(queryOptStr(request, 'range'));
    return sendOk(reply, await deps.llmCallService.summaryForUser(userId, range));
  });

  // 当前用户自己的用量趋势（按天/小时分桶）。仅需登录，不加权限码。
  app.get('/v1/llm-calls/me/trends', async (request, reply) => {
    const userId = requireUserId(request);
    const range = parseUsageRange(queryOptStr(request, 'range'));
    const granularity = parseGranularity(queryOptStr(request, 'granularity'));
    return sendOk(reply, await deps.llmCallService.trendsForUser(userId, range, granularity));
  });
}
