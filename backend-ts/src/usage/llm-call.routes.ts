import type { FastifyInstance } from 'fastify';
import { requireRequestPermission, requireUserId, sendOk } from '../common/http-error.js';
import { addDaysYmd, isValidYmd } from '../common/json.js';
import { queryInt, queryOptBool, queryOptInt, queryOptStr } from '../common/request.js';
import type { PermissionService } from '../permission/permission.service.js';
import { resolveActivityWindow } from '../session/message-search.js';
import { parseUsageRange, type LlmCallService, type UsageDateRange } from './llm-call.service.js';
import type { TrendGranularity } from './llm-call.repository.js';

export interface LlmCallRouteDeps {
  llmCallService: LlmCallService;
  permissionService: PermissionService;
}

/**
 * 管理端调用流水的时间窗，口径与会话列表 `resolveActivityWindow` 相同
 * （Asia/Shanghai 日历日，含起始日 00:00:00，结束日次日 00:00:00 开区间）：
 * - `range=ALL` → 不限时间；
 * - `dateFrom`/`dateTo` 或既有深链参数 `startDate`/`endDate` → 显式区间（可单边，优先于预设档）；
 * - `range=1D|3D|7D|30D|90D` → 最近 N 天（含今天）；
 * - 都没传 → 最近 7 天。避免管理端直连 API 对 `llm_call` 做全表 COUNT。
 * 用户端 `/llm-calls/me` 不走这里，缺省仍不限时间。
 */
export function resolveAdminLlmCallListWindow(input: {
  range?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  now?: Date;
}): { startAt?: string; endAtExclusive?: string } {
  const window = resolveActivityWindow({
    range: input.range,
    dateFrom: input.dateFrom ?? input.startDate,
    dateTo: input.dateTo ?? input.endDate,
    now: input.now,
  });
  if (window == null) return {};
  return {
    ...(window.from != null ? { startAt: window.from } : {}),
    ...(window.toExclusive != null ? { endAtExclusive: window.toExclusive } : {}),
  };
}

/**
 * 自定义起止日期 → 半开窗口 [startAt, endAtExclusive)。
 * 上界取次日 00:00:00：created_at 是 DATETIME(3)，字典序上 '...59.000' > '...59'，
 * 用 23:59:59 闭区间会漏掉结束日最后一秒的全部毫秒行。口径同 admin-analytics。
 * 仅用户端明细使用；缺省不补窗口。
 */
function parseDateRange(startDate?: string, endDate?: string): { startAt?: string; endAtExclusive?: string } {
  return {
    startAt: startDate != null && isValidYmd(startDate) ? `${startDate} 00:00:00` : undefined,
    endAtExclusive: endDate != null && isValidYmd(endDate) ? `${addDaysYmd(endDate, 1)} 00:00:00` : undefined,
  };
}

/** 趋势粒度白名单：非 'hour' 一律回落 'day'（与管理后台 trends 同口径）。 */
export function parseGranularity(value?: string): TrendGranularity {
  return value === 'hour' ? 'hour' : 'day';
}

/**
 * 自定义周期（range=custom）的起止日期：必须两端都是合法 YYYY-MM-DD 且 start ≤ end，
 * 否则整体回落默认周期 last30（非法入参不该让窗口变成「不限」或负数长度）。
 * 非 custom 周期忽略这两个参数。导出供 admin 单用户用量路由（llm-usage-admin.routes.ts）复用。
 */
export function parseUsageDateRange(range: string | undefined, startDate?: string, endDate?: string): UsageDateRange | undefined {
  if (range !== 'custom') return undefined;
  if (!startDate || !endDate || !isValidYmd(startDate) || !isValidYmd(endDate)) return undefined;
  return startDate <= endDate ? { startDate, endDate } : { startDate: endDate, endDate: startDate };
}

export function registerLlmCallRoutes(app: FastifyInstance, deps: LlmCallRouteDeps): void {
  app.get('/v1/admin/llm-calls', async (request, reply) => {
    await requireRequestPermission(deps.permissionService, request, 'llm-call:read');
    const page = queryInt(request, 'page', 1);
    const size = queryInt(request, 'size', 20);
    const window = resolveAdminLlmCallListWindow({
      range: queryOptStr(request, 'range'),
      dateFrom: queryOptStr(request, 'dateFrom'),
      dateTo: queryOptStr(request, 'dateTo'),
      startDate: queryOptStr(request, 'startDate'),
      endDate: queryOptStr(request, 'endDate'),
    });
    const result = await deps.llmCallService.listForAdmin(page, size, {
      userId: queryOptInt(request, 'userId'),
      sessionId: queryOptInt(request, 'sessionId'),
      agentId: queryOptInt(request, 'agentId'),
      modelId: queryOptInt(request, 'modelId'),
      scene: queryOptStr(request, 'scene'),
      success: queryOptBool(request, 'success'),
      cancelled: queryOptBool(request, 'cancelled'),
      startAt: window.startAt,
      endAtExclusive: window.endAtExclusive,
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
      cancelled: queryOptBool(request, 'cancelled'),
      startAt: range.startAt,
      endAtExclusive: range.endAtExclusive,
    });
    return sendOk(reply, result);
  });

  // 当前用户自己的用量总览（总账 + 按模型 + 按场景）。仅需登录，不加权限码。
  app.get('/v1/llm-calls/me/summary', async (request, reply) => {
    const userId = requireUserId(request);
    const range = queryOptStr(request, 'range');
    const startDate = queryOptStr(request, 'startDate');
    const endDate = queryOptStr(request, 'endDate');
    const dateRange = parseUsageDateRange(range, startDate, endDate);
    return sendOk(reply, await deps.llmCallService.summaryForUser(userId, parseUsageRange(range), dateRange));
  });

  // 当前用户自己的用量趋势（按天/小时分桶）。仅需登录，不加权限码。
  app.get('/v1/llm-calls/me/trends', async (request, reply) => {
    const userId = requireUserId(request);
    const range = queryOptStr(request, 'range');
    const startDate = queryOptStr(request, 'startDate');
    const endDate = queryOptStr(request, 'endDate');
    const dateRange = parseUsageDateRange(range, startDate, endDate);
    const granularity = parseGranularity(queryOptStr(request, 'granularity'));
    return sendOk(reply, await deps.llmCallService.trendsForUser(userId, parseUsageRange(range), granularity, dateRange));
  });
}
