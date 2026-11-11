import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { pathId, queryOptStr } from '../common/request.js';
import { parseUsageRange, type LlmCallService, type UsageDateRange } from './llm-call.service.js';
import { parseGranularity, parseUsageDateRange } from './llm-call.routes.js';

export interface LlmUsageAdminRouteDeps {
  llmCallService: LlmCallService;
  /** 权限校验窄接口（同 git-credential.routes / container-admin.routes 惯例）。 */
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
  /** 单用户存在性校验（404 口径）：userRepo 的窄接口，避免路由层依赖完整仓库。 */
  userLookup: { findById(id: number): Promise<{ id?: number } | null> };
}

/** 自定义区间最大跨度（天，闭区间天数）：对齐桌面 usage-range 的回溯上限口径（方案 D4）。 */
const MAX_CUSTOM_SPAN_DAYS = 365;

/** b − a 的日历天数（两端均为已校验的 YYYY-MM-DD）。 */
function daysBetweenYmd(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split('-').map(Number);
  const [ty, tm, td] = toYmd.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/**
 * 管理后台「用户用量」视图（用户详情抽屉"用量"Tab，方案 docs/plan/2026-11-10-admin-user-usage-product-design.md）：
 * - `GET /v1/admin/users/:id/usage/summary`：单用户周期总账 + 按模型 / 场景 / Agent 分布；
 * - `GET /v1/admin/users/:id/usage/trends`：单用户周期趋势（day/hour 分桶，后端补零）。
 *
 * 复用桌面端"我的用量"同一套服务方法（summaryForUser / trendsForUser，服务层 userId 本就是
 * 参数）与参数解析工具（parseUsageRange / parseUsageDateRange / parseGranularity），零新查询逻辑。
 *
 * 口径：connectivity_test 行 user_id 恒为 NULL（写入侧显式置空），单用户聚合天然不含连通性
 * 自检——与桌面 me/* 一致，无需 excludeConnectivity 参数（方案 §6.3）。
 *
 * 权限：`analytics:read`（方案 D1，与用量分析 / 在线设备同语义，不新增权限码）。
 * 校验：:id 非数字 → 400；用户不存在 → 404；custom 跨度超上限 → 400。
 * 周期白名单与 custom 解析沿用 me/* 语义（非法回落 last30、起止倒置交换）。
 */
export function registerLlmUsageAdminRoutes(app: FastifyInstance, deps: LlmUsageAdminRouteDeps): void {
  /** 权限 + 存在性前置（两路由共用）；返回解析后的目标 userId。 */
  const resolveTargetUser = async (request: FastifyRequest): Promise<number> => {
    const currentUserId = requireUserId(request);
    await requirePermission(deps.permissionService, currentUserId, 'analytics:read');
    const id = pathId(request);
    if (!Number.isFinite(id)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '用户 ID 必须为数字');
    }
    const user = await deps.userLookup.findById(id);
    if (user == null) {
      throw new BusinessException(ErrorCode.USER_NOT_FOUND);
    }
    return id;
  };

  /** custom 跨度上限（仅 custom 且解析出完整区间时检查；其余周期/非法入参走既有回落语义）。 */
  const assertCustomSpan = (range: string | undefined, dateRange: UsageDateRange | undefined): void => {
    if (range !== 'custom' || dateRange == null) return;
    const span = daysBetweenYmd(dateRange.startDate, dateRange.endDate) + 1;
    if (span > MAX_CUSTOM_SPAN_DAYS) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `自定义区间跨度不能超过 ${MAX_CUSTOM_SPAN_DAYS} 天`);
    }
  };

  app.get('/v1/admin/users/:id/usage/summary', async (request, reply) => {
    const id = await resolveTargetUser(request);
    const range = queryOptStr(request, 'range');
    const dateRange = parseUsageDateRange(range, queryOptStr(request, 'startDate'), queryOptStr(request, 'endDate'));
    assertCustomSpan(range, dateRange);
    return sendOk(reply, await deps.llmCallService.summaryForUser(id, parseUsageRange(range), dateRange));
  });

  app.get('/v1/admin/users/:id/usage/trends', async (request, reply) => {
    const id = await resolveTargetUser(request);
    const range = queryOptStr(request, 'range');
    const dateRange = parseUsageDateRange(range, queryOptStr(request, 'startDate'), queryOptStr(request, 'endDate'));
    assertCustomSpan(range, dateRange);
    const granularity = parseGranularity(queryOptStr(request, 'granularity'));
    return sendOk(reply, await deps.llmCallService.trendsForUser(id, parseUsageRange(range), granularity, dateRange));
  });
}
