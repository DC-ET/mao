import type { FastifyInstance } from 'fastify';
import { requireRequestPermission, requireUserId, sendJson } from '../common/http-error.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { fail, ok } from '../common/result.js';
import type { JwtService } from '../crypto/jwt.service.js';
import type { FeedbackService } from './feedback.service.js';
import { FEEDBACK_REASONS, type FeedbackReason } from './feedback.repository.js';

export interface FeedbackRouteDeps {
  jwt: JwtService;
  feedback: FeedbackService;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
}

interface DislikeBody {
  reason?: string;
}

const REASON_SET = new Set<string>(FEEDBACK_REASONS);

function parsePagination(query: Record<string, unknown>): { page: number; pageSize: number } {
  const page = Math.floor(Number(query.page ?? 1));
  const pageSize = Math.floor(Number(query.pageSize ?? 20));
  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 20,
  };
}

function parseDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  return value;
}

export function registerFeedbackRoutes(app: FastifyInstance, deps: FeedbackRouteDeps): void {
  // 提交/覆盖点踩
  app.put('/v1/feedback/messages/:messageId/dislike', async (req, reply) => {
    const userId = requireUserId(req);
    const messageId = Number((req.params as { messageId: string }).messageId);
    if (!Number.isInteger(messageId) || messageId <= 0) {
      sendJson(reply, 200, fail(2001, '无效的消息 ID'));
      return;
    }
    const body = (req.body ?? {}) as DislikeBody;
    await deps.feedback.dislike(userId, messageId, String(body.reason ?? ''));
    sendJson(reply, 200, ok());
  });

  // 取消点踩
  app.delete('/v1/feedback/messages/:messageId/dislike', async (req, reply) => {
    const userId = requireUserId(req);
    const messageId = Number((req.params as { messageId: string }).messageId);
    if (!Number.isInteger(messageId) || messageId <= 0) {
      sendJson(reply, 200, fail(2001, '无效的消息 ID'));
      return;
    }
    await deps.feedback.cancelDislike(userId, messageId);
    sendJson(reply, 200, ok());
  });

  // 当前用户指定会话内已点踩的消息 ID 列表（回显）
  app.get('/v1/feedback/messages/disliked-ids', async (req, reply) => {
    const userId = requireUserId(req);
    const sessionId = Number((req.query as { sessionId?: string }).sessionId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      sendJson(reply, 200, fail(2001, '无效的会话 ID'));
      return;
    }
    try {
      const ids = await deps.feedback.listDislikedMessageIds(userId, sessionId);
      sendJson(reply, 200, ok({ ids }));
    } catch (e) {
      // 会话不存在或非本人会话：回显场景静默返回空数组，不阻断聊天、不弹错误提示
      if (e instanceof BusinessException && (e.code === ErrorCode.SESSION_NOT_FOUND.code || e.code === ErrorCode.FORBIDDEN.code)) {
        sendJson(reply, 200, ok({ ids: [] }));
        return;
      }
      throw e;
    }
  });

  // 管理端：汇总统计
  app.get('/v1/feedback/admin/summary', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'feedback:read');
    const query = req.query as Record<string, unknown>;
    const summary = await deps.feedback.getSummary(parseDate(query.startDate), parseDate(query.endDate));
    sendJson(reply, 200, ok(summary));
  });

  // 管理端：分页明细
  app.get('/v1/feedback/admin/list', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'feedback:read');
    const query = req.query as Record<string, unknown>;
    const reason = typeof query.reason === 'string' && REASON_SET.has(query.reason) ? query.reason as FeedbackReason : undefined;
    const page = parsePagination(query);    const result = await deps.feedback.listDetails({
      reason,
      startDate: parseDate(query.startDate),
      endDate: parseDate(query.endDate),
      page: page.page,
      pageSize: page.pageSize,
    });
    sendJson(reply, 200, ok(result));
  });
}
