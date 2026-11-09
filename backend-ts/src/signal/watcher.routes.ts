import type { FastifyInstance } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { sendOk } from '../common/http-error.js';
import { bodyOf, pathId, queryInt } from '../common/request.js';
import { requireJwtIdentity } from '../openapi/access.js';
import type { WatcherService, WatcherInput } from './watcher.service.js';

/**
 * 信号哨兵用户级 API（docs/plan/2026-10-11-signal-watcher-technical-design.md §5.7）。
 * 全部为登录态 + 本人数据，不加管理权限码。
 */

function parseId(raw: number): number {
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '路径参数 id 必须为正整数');
  }
  return raw;
}

/** 请求体 → WatcherInput（字段缺省时由 service 的合并逻辑补）。导出供路由层回归测试使用。 */
export function toInput(body: Record<string, unknown>): Partial<WatcherInput> {
  // headers 与 body/jsonPath 统一口径：请求体里没带这个键就是「未下发」（undefined），
  // 带了键但值为 null 才是「显式清空」。若缺省也映射成 null，编辑时未填的请求头
  // 会被当成显式清空处理，且与库内有值判成假差异而重置基线（BUG-H/BUG-3）。
  let headers: Record<string, string> | null | undefined;
  if ('headers' in body) {
    headers = null;
    const headersRaw = body.headers;
    if (headersRaw != null) {
      if (typeof headersRaw !== 'object' || Array.isArray(headersRaw)) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, 'headers 必须为对象');
      }
      const parsed: Record<string, string> = {};
      for (const [key, value] of Object.entries(headersRaw as Record<string, unknown>)) {
        parsed[key] = typeof value === 'string' ? value : String(value ?? '');
      }
      headers = parsed;
    }
  }
  let copyFrom: number | undefined;
  if (body.copyFrom != null) {
    const n = Number(body.copyFrom);
    if (!Number.isInteger(n) || n <= 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'copyFrom 必须为正整数');
    }
    copyFrom = n;
  }
  // V189 脚本探针三键：probeType 缺省=HTTP；scriptPath/scriptTimeoutSeconds 与 jsonPath
  // 同口径——键未下发=未下发（编辑沿用库值），键存在且 null=显式清空。
  let scriptTimeoutSeconds: number | null | undefined;
  if ('scriptTimeoutSeconds' in body) {
    scriptTimeoutSeconds = body.scriptTimeoutSeconds == null ? null : Number(body.scriptTimeoutSeconds);
    if (scriptTimeoutSeconds != null && !Number.isFinite(scriptTimeoutSeconds)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'scriptTimeoutSeconds 必须为数字');
    }
  }
  return {
    name: typeof body.name === 'string' ? body.name : undefined,
    agentId: body.agentId == null ? undefined : Number(body.agentId),
    url: typeof body.url === 'string' ? body.url : undefined,
    method: typeof body.method === 'string' ? body.method : undefined,
    headers,
    // 可「留空不修改」的字段：仅当请求体里真的带了 key 才视为显式下发（null=清空）。
    // 若缺省也映射成 null，编辑时未填的敏感请求头/体会被当成「显式清空」而丢失。
    body: 'body' in body ? (typeof body.body === 'string' ? body.body : null) : undefined,
    intervalMinutes: body.intervalMinutes == null ? undefined : Number(body.intervalMinutes),
    compareMode: typeof body.compareMode === 'string' ? body.compareMode : undefined,
    jsonPath: 'jsonPath' in body ? (typeof body.jsonPath === 'string' ? body.jsonPath : null) : undefined,
    promptTemplate: typeof body.promptTemplate === 'string' ? body.promptTemplate : undefined,
    triggerMode: typeof body.triggerMode === 'string' ? body.triggerMode : undefined,
    probeType: typeof body.probeType === 'string' ? body.probeType : undefined,
    scriptPath: 'scriptPath' in body ? (typeof body.scriptPath === 'string' ? body.scriptPath : null) : undefined,
    scriptTimeoutSeconds,
    // 复制源哨兵 id（仅 create 消费）：敏感请求头/body 由后端从源行解密继承。
    // reuseSessionId 刻意不解析——指针系统维护，防伪造指向他人生效中的会话。
    copyFrom,
  };
}

export interface WatcherRouteDeps {
  service: WatcherService;
}

export function registerSignalWatcherRoutes(app: FastifyInstance, deps: WatcherRouteDeps): void {
  app.get('/v1/signal-watchers', async (req, reply) => {
    const userId = requireJwtIdentity(req);
    return sendOk(reply, await deps.service.list(userId));
  });

  app.post('/v1/signal-watchers', async (req, reply) => {
    const userId = requireJwtIdentity(req);
    const input = toInput(bodyOf<Record<string, unknown>>(req));
    if (input.name == null || input.agentId == null || input.promptTemplate == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'name、agentId、promptTemplate 必填');
    }
    // 脚本哨兵必填脚本路径、HTTP 哨兵必填 URL；字段级细节（格式/文件存在/互斥）由
    // normalizeInput + validateScriptFile 统一校验，路由层只拦结构性缺参。
    if (input.probeType === 'SCRIPT') {
      if (input.scriptPath == null) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '脚本哨兵必须提供 scriptPath');
      }
    } else if (input.url == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'name、agentId、url、promptTemplate 必填');
    }
    return sendOk(reply, await deps.service.create(userId, input as WatcherInput));
  });

  app.get('/v1/signal-watchers/:id', async (req, reply) => {
    const userId = requireJwtIdentity(req);
    const id = parseId(pathId(req));
    return sendOk(reply, await deps.service.get(userId, id));
  });

  app.put('/v1/signal-watchers/:id', async (req, reply) => {
    const userId = requireJwtIdentity(req);
    const id = parseId(pathId(req));
    const input = toInput(bodyOf<Record<string, unknown>>(req));
    return sendOk(reply, await deps.service.update(userId, id, input));
  });

  app.delete('/v1/signal-watchers/:id', async (req, reply) => {
    const userId = requireJwtIdentity(req);
    const id = parseId(pathId(req));
    await deps.service.remove(userId, id);
    return sendOk(reply, null);
  });

  app.post('/v1/signal-watchers/:id/status', async (req, reply) => {
    const userId = requireJwtIdentity(req);
    const id = parseId(pathId(req));
    const status = bodyOf<{ status?: unknown }>(req).status;
    if (status !== 'ACTIVE' && status !== 'PAUSED') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'status 仅支持 ACTIVE/PAUSED');
    }
    return sendOk(reply, await deps.service.setStatus(userId, id, status));
  });

  app.get('/v1/signal-watchers/:id/checks', async (req, reply) => {
    const userId = requireJwtIdentity(req);
    const id = parseId(pathId(req));
    const page = queryInt(req, 'page', 1);
    const size = Math.min(100, queryInt(req, 'size', 20));
    return sendOk(reply, await deps.service.listChecks(userId, id, page, size));
  });

  app.post('/v1/signal-watchers/:id/test', async (req, reply) => {
    const userId = requireJwtIdentity(req);
    const id = parseId(pathId(req));
    return sendOk(reply, await deps.service.test(userId, id));
  });
}
