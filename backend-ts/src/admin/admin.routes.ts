import type { FastifyInstance } from 'fastify';
import { requireRequestPermission } from '../common/http-error.js';
import { sendJson } from '../common/http-error.js';
import { ok, fail } from '../common/result.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { bodyOf } from '../common/request.js';
import type { JwtService } from '../crypto/jwt.service.js';
import { parseAnalyticsRange, resolveAnalyticsRange } from './analytics-range.js';
import type { AdminAnalyticsService } from './admin-analytics.service.js';
import type { MemoryItemVO, MemoryPageVO, MemoryScope, MemorySource, MemoryStatus } from '../memory/types.js';
import { ACTIVE_PHASES } from '../session/util/session-group-key.js';

/** 运行监控默认视图：全部活跃相位 + 异常终态（CANCELLING 与 ACTIVE_PHASES 同源，避免手写清单漂移）。 */
const RUNTIME_DEFAULT_PHASES = [...ACTIVE_PHASES, 'FAILED', 'CANCELLED'].join(',');

export interface AdminSessionLister {
  listSessionsForAdmin(
    page: number,
    size: number,
    userId?: number,
    agentId?: number,
    executionMode?: string,
    phase?: string,
    keyword?: string,
    status?: string,
    messageScope?: string,
    source?: string,
    options?: { range?: string | null; dateFrom?: string | null; dateTo?: string | null },
  ): Promise<{ records: unknown[]; total: number; current: number; size: number; matchSnippets?: Record<number, string> }>;
}

/**
 * 管理后台记忆管理：跨用户查询 + 写操作（编辑/忽略/恢复/删除/代建）。
 * 读接口需 memory:read，写接口需 memory:write（路由侧校验）；
 * 改/删的目标用户由记忆 id 反查，不接收调用方传 userId（技术方案 D3）。
 */
export interface AdminMemoryAuditor {
  listForAdmin(query: {
    userId?: number | null;
    scope?: MemoryScope | null;
    projectKey?: string | null;
    status?: MemoryStatus | null;
    source?: MemorySource | null;
    keyword?: string | null;
    updatedFrom?: string | null;
    updatedTo?: string | null;
    page: number;
    pageSize: number;
  }): Promise<MemoryPageVO>;
  updateForAdmin(id: number, input: { content?: string | null; status?: string | null }): Promise<MemoryItemVO>;
  removeForAdmin(id: number): Promise<void>;
  createForAdmin(userId: number, input: { scope: string; content: string; projectKey?: string | null }): Promise<MemoryItemVO>;
}

export interface AdminUserLookup {
  findByIds(ids: number[]): Promise<Array<{ id: number; username: string; displayName?: string | null }>>;
  /** 用户搜索选择器数据源（技术方案 D6）：keyword 为空按注册时间倒序取前 pageSize 条。 */
  search(keyword: string, pageSize: number): Promise<Array<{ id: number; username: string; displayName?: string | null }>>;
}

export interface AdminRouteDeps {
  jwt: JwtService;
  analytics: AdminAnalyticsService;
  sessionLister?: AdminSessionLister;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
  memoryAuditor?: AdminMemoryAuditor;
  memoryUserLookup?: AdminUserLookup;
}

interface AnalyticsQueryRaw {
  /** 语义统计周期（管理后台周期选择器）：今日/昨日/本周/上周/本月/上月/自定义 */
  range?: string;
  /** 自定义区间起止日（YYYY-MM-DD，闭区间），仅 range=custom 时生效 */
  start?: string;
  end?: string;
  days?: string;
  endOffset?: string;
  limit?: string;
  excludeConnectivity?: string;
  modelId?: string;
}

function parseAnalyticsQuery(raw: AnalyticsQueryRaw): {
  days: number;
  endOffset: number;
  limit: number;
  excludeConnectivity: boolean;
  modelId: number | null;
} {
  // 语义周期优先解析成 (days, endOffset)；缺省/非法回落原始参数（mao-cli 兼容口径）
  const range = parseAnalyticsRange(raw.range);
  const window =
    range != null ? resolveAnalyticsRange(range, { start: raw.start, end: raw.end }) : null;
  const days = Number(window?.days ?? raw.days ?? 30);
  const endOffset = Number(window?.endOffset ?? raw.endOffset ?? 0);
  const limit = Number(raw.limit ?? 20);
  const modelIdRaw = raw.modelId == null || raw.modelId === '' ? null : Number(raw.modelId);
  return {
    days: Math.max(1, Math.min(Number.isFinite(days) ? days : 30, 90)),
    endOffset: Math.max(0, Math.min(Number.isFinite(endOffset) ? endOffset : 0, 365)),
    limit: Math.max(1, Math.min(Number.isFinite(limit) ? limit : 20, 100)),
    // 默认排除连通性测试，避免模型配置自检污染质量指标
    excludeConnectivity: raw.excludeConnectivity !== 'false' && raw.excludeConnectivity !== '0',
    modelId: modelIdRaw != null && Number.isFinite(modelIdRaw) ? modelIdRaw : null,
  };
}

export function registerAdminAnalyticsRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  // 旧巨型汇总：管理后台已切换 scope 接口，暂留给 mao-cli / 兼容调用方。
  app.get('/v1/admin/analytics/summary', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.summary(days, endOffset)));
  });

  app.get('/v1/admin/analytics/overview', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.overview(days, endOffset)));
  });

  app.get('/v1/admin/analytics/trends', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset, excludeConnectivity } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    const granularity = (req.query as { granularity?: string }).granularity === 'hour' ? 'hour' : 'day';
    sendJson(reply, 200, ok(await deps.analytics.trendsScope(days, endOffset, { excludeConnectivity, granularity })));
  });

  app.get('/v1/admin/analytics/models', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset, excludeConnectivity, modelId } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(
      reply,
      200,
      ok(await deps.analytics.modelsScope(days, endOffset, { excludeConnectivity, sceneModelId: modelId })),
    );
  });

  app.get('/v1/admin/analytics/users', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset, limit, excludeConnectivity } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.usersScope(days, endOffset, limit, { excludeConnectivity })));
  });

  app.get('/v1/admin/analytics/agents', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset, limit, excludeConnectivity } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.agentsScope(days, endOffset, limit, { excludeConnectivity })));
  });

  app.get('/v1/admin/analytics/sessions', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset, excludeConnectivity } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.sessionsScope(days, endOffset, { excludeConnectivity })));
  });
}

export function registerAdminRuntimeRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  app.get('/v1/admin/runtime/sessions', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'session:read');
    const q = req.query as {
      page?: string;
      size?: string;
      userId?: string;
      agentId?: string;
      executionMode?: string;
      phase?: string;
      keyword?: string;
      status?: string;
      messageScope?: string;
      range?: string;
      dateFrom?: string;
      dateTo?: string;
    };
    const page = Number(q.page ?? 1);
    const size = Number(q.size ?? 20);
    const runtimePhase = !q.phase || q.phase.trim() === ''
      ? RUNTIME_DEFAULT_PHASES
      : q.phase;
    if (!deps.sessionLister) {
      sendJson(reply, 200, ok({ records: [], total: 0, page, size }));
      return;
    }
    const result = await deps.sessionLister.listSessionsForAdmin(
      page,
      size,
      q.userId != null ? Number(q.userId) : undefined,
      q.agentId != null ? Number(q.agentId) : undefined,
      q.executionMode,
      runtimePhase,
      q.keyword,
      q.status,
      q.messageScope,
      undefined,
      { range: q.range, dateFrom: q.dateFrom, dateTo: q.dateTo },
    );
    sendJson(reply, 200, ok(result));
  });

  // 用户记忆管理（技术方案 2026-11-12）：读需 memory:read，写需 memory:write；写操作经审计拦截器全量留痕
  app.get('/v1/admin/memory', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'memory:read');
    // 重复查询参数（?keyword=a&keyword=b）会被解析成数组，统一取首值，避免 .trim() 在数组上抛 500
    const q = req.query as Record<string, string | string[] | undefined>;
    const pick = (key: string): string | undefined => {
      const raw = q[key];
      return Array.isArray(raw) ? raw[0] : raw;
    };
    // userId 可选：缺省=跨用户列表；提供但非法 → PARAM_INVALID，不静默按跨用户降级（D5 评审补充）
    let userId: number | null = null;
    const rawUserId = pick('userId');
    if (rawUserId != null && rawUserId.trim() !== '') {
      const parsed = Number(rawUserId);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        sendJson(reply, 200, fail(ErrorCode.PARAM_INVALID.code, 'userId 必须是正整数'));
        return;
      }
      userId = parsed;
    }
    const rawScope = pick('scope');
    const scope = rawScope === 'USER' || rawScope === 'PROJECT' ? rawScope : null;
    const rawStatus = pick('status');
    const status = rawStatus === 'ACTIVE' || rawStatus === 'DISMISSED' ? rawStatus : null;
    const rawSource = pick('source');
    const source = rawSource === 'AUTO' || rawSource === 'MANUAL' ? rawSource : null;
    const rawKeyword = pick('keyword');
    const keyword = rawKeyword != null && rawKeyword.trim() !== '' ? rawKeyword.trim() : null;
    const rawProjectKey = pick('projectKey');
    const projectKey = rawProjectKey != null && rawProjectKey.trim() !== '' ? rawProjectKey.trim() : null;
    // D5：跨用户列表必须至少一个「能裁剪扫描面」的过滤条件（时间范围不计入——updated_at 无索引）
    if (userId == null && keyword == null && scope == null && status == null && source == null && projectKey == null) {
      sendJson(reply, 200, fail(ErrorCode.PARAM_INVALID.code, '跨用户查询必须至少指定一个过滤条件（关键词/作用域/状态/来源/项目）'));
      return;
    }
    const dateRange = parseMemoryDateRange(pick('updatedFrom'), pick('updatedTo'));
    if (typeof dateRange === 'string') {
      sendJson(reply, 200, fail(ErrorCode.PARAM_INVALID.code, dateRange));
      return;
    }
    if (!deps.memoryAuditor) {
      sendJson(reply, 200, ok({ records: [], total: 0, current: 1, size: 20 }));
      return;
    }
    const page = Math.max(1, Math.floor(Number(pick('page') ?? 1)) || 1);
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(pick('pageSize') ?? 20)) || 20));
    const result = await deps.memoryAuditor.listForAdmin({
      userId,
      scope,
      status,
      source,
      keyword,
      projectKey,
      updatedFrom: dateRange.updatedFrom,
      updatedTo: dateRange.updatedTo,
      page,
      pageSize,
    });
    // 页内 userId 去重后批量补全 username/displayName，跨用户与单用户模式统一走此路径
    if (deps.memoryUserLookup && result.records.length > 0) {
      try {
        const ids = [...new Set(result.records.map((item) => item.userId))];
        const users = await deps.memoryUserLookup.findByIds(ids);
        const byId = new Map(users.map((u) => [u.id, u]));
        result.records = result.records.map((item) => ({
          ...item,
          username: byId.get(item.userId)?.username ?? null,
          displayName: byId.get(item.userId)?.displayName ?? null,
        }));
      } catch {
        // 用户信息补全失败不影响列表返回
      }
    }
    sendJson(reply, 200, ok(result));
  });

  // 用户搜索选择器数据源（技术方案 D6）：不依赖 user:read，memory:read 即可（只回 id/username/displayName）
  app.get('/v1/admin/memory/users', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'memory:read');
    const raw = req.query as Record<string, string | string[] | undefined>;
    const rawKeyword = Array.isArray(raw.keyword) ? raw.keyword[0] : raw.keyword;
    const rawPageSize = Array.isArray(raw.pageSize) ? raw.pageSize[0] : raw.pageSize;
    if (!deps.memoryUserLookup) {
      sendJson(reply, 200, ok({ records: [] }));
      return;
    }
    const keyword = rawKeyword != null ? rawKeyword.trim() : '';
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(rawPageSize ?? 20)) || 20));
    const records = await deps.memoryUserLookup.search(keyword, pageSize);
    sendJson(reply, 200, ok({ records }));
  });

  app.patch('/v1/admin/memory/:id', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'memory:write');
    if (!deps.memoryAuditor || !deps.memoryUserLookup) {
      sendJson(reply, 200, fail(ErrorCode.INTERNAL_ERROR.code, '记忆管理依赖未装配'));
      return;
    }
    const id = requireMemoryPathId((req.params as { id: string }).id);
    const body = bodyOf<{ content?: unknown; status?: unknown }>(req);
    if (body.content != null && typeof body.content !== 'string') {
      sendJson(reply, 200, fail(ErrorCode.PARAM_INVALID.code, 'content 必须是字符串'));
      return;
    }
    const vo = await deps.memoryAuditor.updateForAdmin(id, {
      content: (body.content as string | null) ?? null,
      status: (body.status as string | null) ?? null,
    });
    sendJson(reply, 200, ok(vo));
  });

  app.delete('/v1/admin/memory/:id', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'memory:write');
    if (!deps.memoryAuditor || !deps.memoryUserLookup) {
      sendJson(reply, 200, fail(ErrorCode.INTERNAL_ERROR.code, '记忆管理依赖未装配'));
      return;
    }
    const id = requireMemoryPathId((req.params as { id: string }).id);
    await deps.memoryAuditor.removeForAdmin(id);
    sendJson(reply, 200, ok());
  });

  app.post('/v1/admin/memory', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'memory:write');
    if (!deps.memoryAuditor || !deps.memoryUserLookup) {
      sendJson(reply, 200, fail(ErrorCode.INTERNAL_ERROR.code, '记忆管理依赖未装配'));
      return;
    }
    const body = bodyOf<{ userId?: unknown; scope?: unknown; content?: unknown; projectKey?: unknown }>(req);
    const userId = Number(body.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      sendJson(reply, 200, fail(ErrorCode.PARAM_INVALID.code, 'userId 必须是正整数'));
      return;
    }
    // 目标用户存在性校验：memory_item 无外键，不校验会插入孤儿记忆行（技术方案评审补充）
    const users = await deps.memoryUserLookup.findByIds([userId]);
    if (!users.some((u) => u.id === userId)) {
      throw new BusinessException(ErrorCode.USER_NOT_FOUND);
    }
    const vo = await deps.memoryAuditor.createForAdmin(userId, {
      scope: String(body.scope ?? ''),
      content: String(body.content ?? ''),
      projectKey: (body.projectKey as string | null | undefined) ?? null,
    });
    sendJson(reply, 200, ok(vo));
  });

}

/** 记忆路由 path id：非法（非数字/非正整数）一律按不存在处理（同用户域 memory.routes 口径）。 */
function requireMemoryPathId(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new BusinessException(ErrorCode.MEMORY_ITEM_NOT_FOUND);
  }
  return id;
}

/**
 * 更新时间范围解析：入参 YYYY-MM-DD，闭区间规范化为「当天 00:00:00 / 23:59:59」。
 * 缺省一侧返回 null（只按另一侧过滤）；格式或日历非法返回错误文案（拒绝比静默忽略更安全，
 * 避免手误把窄查询放大成无时间过滤的全量查询，也让 2026-02-30 这类串在路由层报 PARAM_INVALID
 * 而非漏到 MySQL 报 Incorrect DATETIME）。
 */
function parseMemoryDateRange(from: string | undefined, to: string | undefined): { updatedFrom: string | null; updatedTo: string | null } | string {
  const pattern = /^\d{4}-\d{2}-\d{2}$/;
  const normalize = (raw: string | undefined, suffix: string): string | null => {
    const value = raw != null ? raw.trim() : '';
    if (value === '') return null;
    if (!pattern.test(value) || !isValidCalendarDate(value)) return '';
    return `${value} ${suffix}`;
  };
  const updatedFrom = normalize(from, '00:00:00');
  const updatedTo = normalize(to, '23:59:59');
  if (updatedFrom === '' || updatedTo === '') {
    return 'updatedFrom/updatedTo 必须是 YYYY-MM-DD 格式的有效日期';
  }
  return { updatedFrom, updatedTo };
}

/** 日历有效性：拒绝 2026-02-30 这类形状合法但不存在的日期（UTC round-trip 比对）。 */
function isValidCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
