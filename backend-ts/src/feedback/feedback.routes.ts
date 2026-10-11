import type { FastifyInstance } from 'fastify';
import { requireRequestPermission, requireUserId, sendJson } from '../common/http-error.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { fail, ok } from '../common/result.js';
import type { JwtService } from '../crypto/jwt.service.js';
import type { FeedbackService } from './feedback.service.js';
import type { ExperienceDraftService } from './experience-draft.service.js';
import { FEEDBACK_REASONS, FEEDBACK_STATUSES, type FeedbackReason, type FeedbackStatus } from './feedback.repository.js';

export interface FeedbackRouteDeps {
  jwt: JwtService;
  feedback: FeedbackService;
  /** 经验草稿起草（只读 LLM 调用）：转经验向导的「生成/重新生成」。 */
  experienceDraft: ExperienceDraftService;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
}

interface DislikeBody {
  reason?: string;
}

interface DismissBody {
  feedbackIds?: unknown;
}

interface DraftBody {
  feedbackIds?: unknown;
  agentId?: unknown;
}

interface ConvertBody {
  feedbackIds?: unknown;
  agentId?: unknown;
  experiences?: unknown;
}

const REASON_SET = new Set<string>(FEEDBACK_REASONS);
const STATUS_SET = new Set<string>(FEEDBACK_STATUSES);

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

function parseIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '反馈 ID 列表不能为空');
  }
  // 仅做数值收敛，合法性（正整数 / 去重 / 上限）由 FeedbackService.normalizeBatchIds 统一判定
  return (value as unknown[]).map((raw) => Number(raw));
}

/** agentId 解析：留空即不筛选；0 / 负数 / 非整数一律拒绝（避免把客户端 bug 变成全表查询）。 */
function parseAgentId(value: unknown, required: boolean): number | undefined {
  if (value == null || value === '') {
    if (required) throw new BusinessException(ErrorCode.PARAM_INVALID, '目标 Agent 无效');
    return undefined;
  }
  const agentId = Number(value);
  if (!Number.isSafeInteger(agentId) || agentId <= 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '目标 Agent 无效');
  }
  return agentId;
}

function parseSortOrder(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? (value as number) : undefined;
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
    const status = typeof query.status === 'string' && STATUS_SET.has(query.status) ? query.status as FeedbackStatus : undefined;
    const page = parsePagination(query);
    const result = await deps.feedback.listDetails({
      reason,
      status,
      agentId: parseAgentId(query.agentId, false),
      startDate: parseDate(query.startDate),
      endDate: parseDate(query.endDate),
      page: page.page,
      pageSize: page.pageSize,
    });
    sendJson(reply, 200, ok(result));
  });

  // 管理端：起草经验草稿（只读，可反复调用；N=1 单条 / N≥2 归纳由服务端按原料条数切换）
  app.post('/v1/feedback/admin/draft', async (req, reply) => {
    const operatorId = await requireRequestPermission(deps.permissionService, req, 'feedback:write');
    const body = (req.body ?? {}) as DraftBody;
    const feedbackIds = parseIds(body.feedbackIds);
    // 未显式传 agentId 时回落反馈行快照 agent_id（仅用于既有经验条数提示与目标预选）
    const agentId = parseAgentId(body.agentId, false);
    const { materials, snapshotAgentId } = await deps.feedback.buildDraftContext(feedbackIds);
    const draft = await deps.experienceDraft.draft(operatorId, agentId ?? snapshotAgentId, materials);
    sendJson(reply, 200, ok(draft));
  });

  // 管理端：确认写入（经验 + 反馈状态同事务；并发冲突以 CAS 影响行数判定）
  app.post('/v1/feedback/admin/convert', async (req, reply) => {
    const operatorId = await requireRequestPermission(deps.permissionService, req, 'feedback:write');
    const body = (req.body ?? {}) as ConvertBody;
    const feedbackIds = parseIds(body.feedbackIds);
    const agentId = parseAgentId(body.agentId, true)!;
    const rawExperiences = Array.isArray(body.experiences) ? body.experiences as Array<Record<string, unknown>> : [];
    const experiences = rawExperiences.map((item) => ({
      content: typeof item?.content === 'string' ? item.content : '',
      sortOrder: parseSortOrder(item?.sortOrder),
    }));
    const result = await deps.feedback.convertToExperience(operatorId, { feedbackIds, agentId, experiences });
    sendJson(reply, 200, ok(result));
  });

  // 管理端：忽略（DISMISSED 终态，全或无）
  app.post('/v1/feedback/admin/dismiss', async (req, reply) => {
    const operatorId = await requireRequestPermission(deps.permissionService, req, 'feedback:write');
    const body = (req.body ?? {}) as DismissBody;
    const feedbackIds = parseIds(body.feedbackIds);
    const result = await deps.feedback.dismiss(operatorId, feedbackIds);
    sendJson(reply, 200, ok(result));
  });
}
