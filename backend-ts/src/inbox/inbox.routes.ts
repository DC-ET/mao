import type { FastifyInstance } from 'fastify';
import { requireUserId, sendOk } from '../common/http-error.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { bodyOf, queryOptBool } from '../common/request.js';
import type { InboxPreference } from '@mao/contracts';
import type { InboxService } from './inbox.service.js';

export interface InboxRouteDeps {
  inboxService: InboxService;
}

interface SavePreferenceRequest {
  taskCompletedEnabled?: unknown;
  questionPendingEnabled?: unknown;
  approvalPendingEnabled?: unknown;
  subagentDoneEnabled?: unknown;
  budgetWarnEnabled?: unknown;
  openApiCallFailedEnabled?: unknown;
  systemNotifyEnabled?: unknown;
}

function parsePage(value: unknown): number {
  const page = Math.floor(Number(value ?? 1));
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function parseSize(value: unknown): number {
  const size = Math.floor(Number(value ?? 20));
  return Number.isFinite(size) && size > 0 ? Math.min(size, 100) : 20;
}

function requirePathId(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '无效的条目 ID');
  }
  return id;
}

/**
 * 收件箱 REST 面（登录态即生效，归属 user_id = 当前用户）。
 * 个人数据、不挂权限点（无 admin 侧操作）；登录态由 server.ts 的全局认证守卫保证。
 * 分页命名统一 page + size（与 session.routes.ts 主流一致）。
 */
export function registerInboxRoutes(app: FastifyInstance, deps: InboxRouteDeps): void {
  const { inboxService } = deps;

  app.get('/v1/inbox', async (request, reply) => {
    const userId = requireUserId(request);
    const query = request.query as Record<string, unknown>;
    return sendOk(reply, await inboxService.list(
      userId, parsePage(query.page), parseSize(query.size), queryOptBool(request, 'unreadOnly'),
    ));
  });

  // 徽标数据源：服务端 COUNT 为唯一权威，前端禁止本地累加
  app.get('/v1/inbox/unread-count', async (request, reply) => {
    const userId = requireUserId(request);
    return sendOk(reply, { unreadCount: await inboxService.unreadCount(userId) });
  });

  app.post('/v1/inbox/:id/read', async (request, reply) => {
    const userId = requireUserId(request);
    const id = requirePathId((request.params as { id: string }).id);
    if (!(await inboxService.markRead(userId, id))) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '收件箱条目不存在或已读');
    }
    return sendOk(reply);
  });

  app.post('/v1/inbox/read-all', async (request, reply) => {
    const userId = requireUserId(request);
    await inboxService.markAllRead(userId);
    return sendOk(reply);
  });

  app.delete('/v1/inbox/:id', async (request, reply) => {
    const userId = requireUserId(request);
    const id = requirePathId((request.params as { id: string }).id);
    if (!(await inboxService.remove(userId, id))) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '收件箱条目不存在');
    }
    return sendOk(reply);
  });

  app.get('/v1/inbox/preferences', async (request, reply) => {
    const userId = requireUserId(request);
    return sendOk(reply, await inboxService.getPreferences(userId));
  });

  app.put('/v1/inbox/preferences', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<SavePreferenceRequest>(request);
    const current = await inboxService.getPreferences(userId);
    const next: InboxPreference = {
      taskCompletedEnabled: readFlag(body.taskCompletedEnabled, current.taskCompletedEnabled),
      questionPendingEnabled: readFlag(body.questionPendingEnabled, current.questionPendingEnabled),
      approvalPendingEnabled: readFlag(body.approvalPendingEnabled, current.approvalPendingEnabled),
      subagentDoneEnabled: readFlag(body.subagentDoneEnabled, current.subagentDoneEnabled),
      budgetWarnEnabled: readFlag(body.budgetWarnEnabled, current.budgetWarnEnabled),
      openApiCallFailedEnabled: readFlag(body.openApiCallFailedEnabled, current.openApiCallFailedEnabled),
      systemNotifyEnabled: readFlag(body.systemNotifyEnabled, current.systemNotifyEnabled),
    };
    return sendOk(reply, await inboxService.savePreferences(userId, next));
  });
}

function readFlag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
