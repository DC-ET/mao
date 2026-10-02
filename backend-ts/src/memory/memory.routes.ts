import type { FastifyInstance } from 'fastify';
import { requireUserId, sendJson, sendOk } from '../common/http-error.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { fail } from '../common/result.js';
import { bodyOf } from '../common/request.js';
import type { MemoryService } from './memory.service.js';
import type { MemoryListQuery, MemoryScope, MemoryStatus } from './types.js';
import { MEMORY_SCOPES, MEMORY_STATUSES } from './types.js';

export interface MemoryRouteDeps {
  memoryService: MemoryService;
}

interface CreateMemoryRequest {
  scope?: string;
  content?: string;
  projectKey?: string | null;
}

interface UpdateMemoryRequest {
  content?: string | null;
  status?: string | null;
}

interface MemorySettingsRequest {
  autoCaptureEnabled?: boolean;
}

function parsePage(value: unknown): number {
  const page = Math.floor(Number(value ?? 1));
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function parsePageSize(value: unknown): number {
  const size = Math.floor(Number(value ?? 20));
  return Number.isFinite(size) && size > 0 ? Math.min(size, 100) : 20;
}

function parseScopeFilter(value: unknown): MemoryScope | null {
  return typeof value === 'string' && (MEMORY_SCOPES as readonly string[]).includes(value) ? value as MemoryScope : null;
}

function parseStatusFilter(value: unknown): MemoryStatus | null {
  return typeof value === 'string' && (MEMORY_STATUSES as readonly string[]).includes(value) ? value as MemoryStatus : null;
}

function requirePathId(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new BusinessException(ErrorCode.MEMORY_ITEM_NOT_FOUND);
  }
  return id;
}

export function registerMemoryRoutes(app: FastifyInstance, deps: MemoryRouteDeps): void {
  const { memoryService } = deps;

  // 分页列表（登录态即生效，归属 user_id = 当前用户）
  app.get('/v1/memory', async (request, reply) => {
    const userId = requireUserId(request);
    const query = request.query as Record<string, unknown>;
    const listQuery: MemoryListQuery = {
      scope: parseScopeFilter(query.scope),
      projectKey: typeof query.projectKey === 'string' && query.projectKey.trim() !== '' ? query.projectKey.trim() : null,
      status: parseStatusFilter(query.status),
      page: parsePage(query.page),
      pageSize: parsePageSize(query.pageSize),
    };
    return sendOk(reply, await memoryService.list(userId, listQuery));
  });

  // 手工新增
  app.post('/v1/memory', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<CreateMemoryRequest>(request);
    if (body.content != null && typeof body.content !== 'string') {
      return sendJson(reply, 200, fail(ErrorCode.PARAM_INVALID.code, 'content 必须是字符串'));
    }
    const vo = await memoryService.create(userId, {
      scope: String(body.scope ?? ''),
      content: String(body.content ?? ''),
      projectKey: body.projectKey ?? null,
    });
    return sendOk(reply, vo);
  });

  // 编辑内容 / 切换 ACTIVE ↔ DISMISSED（编辑不改 status，见技术方案 D12）
  app.patch('/v1/memory/:id', async (request, reply) => {
    const userId = requireUserId(request);
    const id = requirePathId((request.params as { id: string }).id);
    const body = bodyOf<UpdateMemoryRequest>(request);
    if (body.content != null && typeof body.content !== 'string') {
      return sendJson(reply, 200, fail(ErrorCode.PARAM_INVALID.code, 'content 必须是字符串'));
    }
    const vo = await memoryService.update(userId, id, {
      content: body.content ?? null,
      status: body.status ?? null,
    });
    return sendOk(reply, vo);
  });

  // 物理删除
  app.delete('/v1/memory/:id', async (request, reply) => {
    const userId = requireUserId(request);
    const id = requirePathId((request.params as { id: string }).id);
    await memoryService.remove(userId, id);
    return sendOk(reply);
  });

  // 自动收集开关读取（无偏好行视为 false，即默认关闭）
  app.get('/v1/memory/settings', async (request, reply) => {
    const userId = requireUserId(request);
    return sendOk(reply, { autoCaptureEnabled: await memoryService.getAutoCaptureEnabled(userId) });
  });

  // 自动收集开关更新
  app.patch('/v1/memory/settings', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<MemorySettingsRequest>(request);
    if (typeof body.autoCaptureEnabled !== 'boolean') {
      return sendJson(reply, 200, fail(ErrorCode.PARAM_INVALID.code, 'autoCaptureEnabled 必须为布尔值'));
    }
    const autoCaptureEnabled = body.autoCaptureEnabled;
    await memoryService.updateAutoCaptureEnabled(userId, autoCaptureEnabled);
    return sendOk(reply, { autoCaptureEnabled });
  });

  // 项目级记忆下拉数据源：历史会话 projectKey 去重（排除机器人渠道特殊值）
  app.get('/v1/memory/projects', async (request, reply) => {
    const userId = requireUserId(request);
    return sendOk(reply, { projects: await memoryService.listProjectKeys(userId) });
  });
}
