import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requireRequestPermission, sendOk } from '../common/http-error.js';
import { bodyOf, pathId, queryInt, queryOptBool, queryOptStr } from '../common/request.js';
import type { HttpToolCallStatRow } from '../admin/admin-analytics.service.js';
import type { HttpApiExecutor } from '../harness/tool/impl/http-api-executor.js';
import type { HttpToolService } from './http-tool.service.js';
import type { HttpToolDraft, HttpToolParamInput } from './types.js';

/** 调用统计端口（AdminAnalyticsDbStore 满足；聚合 SQL 见 admin-analytics §9.4）。 */
export interface HttpToolCallStatsPort {
  selectHttpToolCallStats(slug?: string | null): Promise<HttpToolCallStatRow[]>;
}

type PermissionChecker = { hasPermission(userId: number, code: string): Promise<boolean> };

export interface AdminHttpToolRouteDeps {
  service: HttpToolService;
  stats: HttpToolCallStatsPort;
  /** 执行内核：试运行与正式调用同一代码路径（「试到的就是跑到的」）。 */
  httpApiExecutor: HttpApiExecutor;
  permissionService: PermissionChecker;
}

/**
 * 管理侧自定义 HTTP 工具端点（技术方案 §5.9 / §5.10）：清单 + 统计 + 全量写操作。
 * 归属模型：管理员配置 + 按 Agent 关联——写端点即管理员管理自己的工具，无属主校验；
 * 读 http_tool:read，写 http_tool:write。
 */
export function registerAdminHttpToolRoutes(app: FastifyInstance, deps: AdminHttpToolRouteDeps): void {
  const { service, stats, httpApiExecutor, permissionService } = deps;

  app.get('/v1/admin/http-tools', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'http_tool:read');
    const page = Math.max(1, queryInt(request, 'page', 1));
    const size = Math.min(100, Math.max(1, queryInt(request, 'size', 20)));
    const keyword = queryOptStr(request, 'keyword');
    const enabled = queryOptBool(request, 'enabled');
    const result = await service.listForAdmin(page, size, { keyword, enabled });
    return sendOk(reply, { ...result, current: page, size });
  });

  /** 启用工具轻量列表（Agent 表单下拉用；读权限即可加载选项）。 */
  app.get('/v1/admin/http-tools/enabled', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'http_tool:read');
    const rows = await service.listEnabledBrief();
    return sendOk(reply, rows.map((row) => ({
      id: row.id,
      name: row.name,
      displayName: row.displayName,
      method: row.method,
      readOnly: row.readOnly === 1,
    })));
  });

  app.get('/v1/admin/http-tools/stats', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'http_tool:read');
    const slug = queryOptStr(request, 'slug');
    const rows = await stats.selectHttpToolCallStats(slug);
    return sendOk(reply, rows.map((row) => ({
      slug: row.slug,
      calls: Number(row.calls ?? 0),
      errors: Number(row.errors ?? 0),
      failRate: Number(row.calls) > 0
        ? Math.round((Number(row.errors ?? 0) / Number(row.calls)) * 1000) / 1000
        : 0,
      users: Number(row.users ?? 0),
      firstAt: row.firstAt == null ? null : String(row.firstAt).replace(' ', 'T'),
      lastAt: row.lastAt == null ? null : String(row.lastAt).replace(' ', 'T'),
    })));
  });

  app.post('/v1/admin/http-tools', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'http_tool:write');
    const created = await service.create(toDraft(bodyOf<Record<string, unknown>>(request)));
    return sendOk(reply, created);
  });

  app.put('/v1/admin/http-tools/:id', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'http_tool:write');
    const updated = await service.update(requireId(request), toDraft(bodyOf<Record<string, unknown>>(request)));
    return sendOk(reply, updated);
  });

  app.delete('/v1/admin/http-tools/:id', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'http_tool:write');
    await service.remove(requireId(request));
    return sendOk(reply);
  });

  app.put('/v1/admin/http-tools/:id/enabled', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'http_tool:write');
    const body = bodyOf<{ enabled?: boolean }>(request);
    if (typeof body.enabled !== 'boolean') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '缺少 enabled 布尔参数');
    }
    const updated = await service.setEnabled(requireId(request), body.enabled);
    return sendOk(reply, updated);
  });

  // 试运行调试台（§5.9）：完整草稿 + 本次 arguments，不落库；SSRF 判定与正式调用一致
  app.post('/v1/admin/http-tools/test', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'http_tool:write');
    const body = bodyOf<Record<string, unknown>>(request);
    const draft = toDraft(body);
    const inner = body.arguments;
    let argumentsJson: string;
    if (inner == null) {
      argumentsJson = '{}';
    } else if (typeof inner === 'object' && !Array.isArray(inner)) {
      argumentsJson = JSON.stringify(inner);
    } else {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'arguments 必须是 JSON 对象（无参工具可省略）');
    }
    const resolved = service.resolveDraftForExecution(draft);
    const startedAt = Date.now();
    const result = await httpApiExecutor.execute(resolved.tool, resolved.params, argumentsJson);
    const durationMs = Date.now() - startedAt;
    if ('error' in result) {
      return sendOk(reply, { error: result.error, durationMs });
    }
    return sendOk(reply, {
      status: result.status,
      body: result.body,
      truncated: result.truncated,
      notice: result.notice ?? null,
      displayName: result.displayName,
      durationMs,
    });
  });
}

/** 路径 id 必须是正整数：NaN 直接透传到 SQL 绑定会抛 500，这里提前拒绝。 */
function requireId(request: FastifyRequest): number {
  const id = pathId(request);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'ID 无效');
  }
  return id;
}

function str(value: unknown): string {
  return value == null ? '' : String(value);
}

/** 请求头入参兼容两种形态：键值对象或 [{key,value}] 数组（编辑器按行维护顺序）。 */
function toHeadersInput(headers: unknown): Record<string, string> | null {
  if (headers == null) return null;
  if (Array.isArray(headers)) {
    const result: Record<string, string> = {};
    for (const item of headers) {
      const row = item as { key?: unknown; value?: unknown };
      const key = str(row?.key).trim();
      if (key === '') continue;
      result[key] = str(row?.value);
    }
    return result;
  }
  if (typeof headers === 'object') {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (key.trim() === '') continue;
      result[key] = str(value);
    }
    return result;
  }
  throw new BusinessException(ErrorCode.PARAM_INVALID, '请求头必须是对象或 [{key,value}] 数组');
}

function toParamsInput(params: unknown): HttpToolParamInput[] {
  if (params == null) return [];
  if (!Array.isArray(params)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '参数定义必须是数组');
  }
  return params.map((item) => {
    const row = (item ?? {}) as Record<string, unknown>;
    return {
      name: str(row.name),
      label: str(row.label),
      type: row.type == null ? undefined : str(row.type),
      required: row.required == null ? undefined : Boolean(row.required),
      defaultValue: row.defaultValue == null ? null : str(row.defaultValue),
    };
  });
}

/** 请求体 → 草稿（字段级归一化在 service.validateDraft 统一完成，这里只做形态转换）。 */
function toDraft(body: Record<string, unknown>): HttpToolDraft {
  return {
    name: str(body.name),
    displayName: str(body.displayName),
    description: str(body.description),
    method: str(body.method),
    url: str(body.url),
    headers: toHeadersInput(body.headers),
    bodyTemplate: body.bodyTemplate == null ? null : str(body.bodyTemplate),
    readOnly: body.readOnly == null ? undefined : Boolean(body.readOnly),
    timeoutMs: body.timeoutMs == null ? undefined : Number(body.timeoutMs),
    enabled: body.enabled == null ? undefined : Boolean(body.enabled),
    params: toParamsInput(body.params),
  };
}
