import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf, pathId } from '../common/request.js';
import type { HttpApiExecutor } from '../harness/tool/impl/http-api-executor.js';
import type { UserToolService } from './user-tool.service.js';
import type { UserToolDraft, UserToolParamInput } from './types.js';

export interface UserToolRouteDeps {
  userToolService: UserToolService;
  /** 执行内核：试运行与正式调用同一代码路径（「试到的就是跑到的」）。 */
  httpApiExecutor: HttpApiExecutor;
}

/**
 * 用户侧自定义 HTTP 工具端点（技术方案 §5.10）：CRUD + 启停 + 草稿试运行。
 * 全部 requireUserId + 服务层属主校验；试运行不落库，直接走执行内核。
 */
export function registerUserToolRoutes(app: FastifyInstance, deps: UserToolRouteDeps): void {
  const { userToolService, httpApiExecutor } = deps;

  app.get('/v1/user-tools', async (request, reply) => {
    const userId = requireUserId(request);
    const list = await userToolService.listForUser(userId);
    return sendOk(reply, list);
  });

  app.post('/v1/user-tools', async (request, reply) => {
    const userId = requireUserId(request);
    const created = await userToolService.create(userId, toDraft(bodyOf<Record<string, unknown>>(request)));
    return sendOk(reply, created);
  });

  app.put('/v1/user-tools/:id', async (request, reply) => {
    const userId = requireUserId(request);
    const updated = await userToolService.update(userId, requireId(request), toDraft(bodyOf<Record<string, unknown>>(request)));
    return sendOk(reply, updated);
  });

  app.delete('/v1/user-tools/:id', async (request, reply) => {
    const userId = requireUserId(request);
    await userToolService.remove(userId, requireId(request));
    return sendOk(reply);
  });

  app.put('/v1/user-tools/:id/enabled', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ enabled?: boolean }>(request);
    if (typeof body.enabled !== 'boolean') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '缺少 enabled 布尔参数');
    }
    const updated = await userToolService.setEnabled(userId, requireId(request), body.enabled);
    return sendOk(reply, updated);
  });

  // 试运行调试台（§5.8）：完整草稿 + 本次 arguments，不落库；SSRF 判定与正式调用一致
  app.post('/v1/user-tools/test', async (request, reply) => {
    requireUserId(request);
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
    const resolved = userToolService.resolveDraftForExecution(draft);
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

function toParamsInput(params: unknown): UserToolParamInput[] {
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
function toDraft(body: Record<string, unknown>): UserToolDraft {
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
