import type { FastifyInstance, FastifyReply } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requireUserId, sendJson, sendOk } from '../common/http-error.js';
import { bodyOf, pathId, queryOptInt } from '../common/request.js';
import { fail } from '../common/result.js';
import { contentDisposition } from '../file/file.routes.js';
import type { SessionService } from './session.service.js';
import type { Session } from './types.js';
import type { SessionExportService } from './session-export.service.js';
import type { SessionShareService } from './session-share.service.js';

export interface SessionShareRouteDeps {
  sessionService: SessionService;
  shareService: SessionShareService;
  exportService: SessionExportService;
  tokenLinksEnabled: () => Promise<boolean>;
}

export function registerSessionShareRoutes(app: FastifyInstance, deps: SessionShareRouteDeps): void {
  const { sessionService, shareService, exportService } = deps;

  async function requireSessionOwner(userId: number, sessionId: number): Promise<Session> {
    const session = await sessionService.getSession(sessionId);
    if (session.userId !== userId) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '无权操作该会话');
    }
    return session;
  }

  app.post('/v1/sessions/:id/share', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireSessionOwner(userId, pathId(request));
    const body = bodyOf<{ publicLink?: boolean; expiresInDays?: number | null }>(request);
    if (body.publicLink === true && !(await deps.tokenLinksEnabled())) {
      return sendJson(reply, 400, fail(ErrorCode.PARAM_INVALID.code, '匿名分享链接未开启'));
    }
    return sendOk(reply, await shareService.create(session, userId, body));
  });

  app.put('/v1/sessions/:id/share', async (request, reply) => {
    const userId = requireUserId(request);
    const id = pathId(request);
    await requireSessionOwner(userId, id);
    return sendOk(reply, await shareService.refresh(id));
  });

  app.get('/v1/sessions/:id/share', async (request, reply) => {
    const userId = requireUserId(request);
    const id = pathId(request);
    await requireSessionOwner(userId, id);
    return sendOk(reply, await shareService.getActive(id));
  });

  app.delete('/v1/sessions/:id/share', async (request, reply) => {
    const userId = requireUserId(request);
    const id = pathId(request);
    await requireSessionOwner(userId, id);
    await shareService.revoke(id, userId);
    return sendOk(reply);
  });

  app.get('/v1/sessions/:id/export/jsonl', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireSessionOwner(userId, pathId(request));
    const result = await exportService.render(session);
    return sendJsonl(reply, result.filename, result.jsonl);
  });

  app.get('/v1/share/:token', async (request, reply) => {
    const userId = requireUserId(request);
    const token = pathToken(request);
    const payload = await shareService.readView(
      token,
      queryOptInt(request, 'roundLimit') ?? 5,
      queryOptInt(request, 'beforeMessageId') ?? null,
      userId,
      `/v1/share/${token}`,
    );
    return sendOk(reply, payload);
  });

  app.get('/v1/share/public/:token', async (request, reply) => {
    if (!(await deps.tokenLinksEnabled())) {
      return reply.status(404).send({ error: 'not found' });
    }
    try {
      const token = pathToken(request);
      const payload = await shareService.readView(
        token,
        queryOptInt(request, 'roundLimit') ?? 5,
        queryOptInt(request, 'beforeMessageId') ?? null,
        null,
        `/v1/share/public/${token}`,
        true,
      );
      return sendOk(reply, payload);
    } catch (e) {
      // 匿名端点是免登录暴露面：业务侧"不可见"与任何内部故障都归一为同一响应，
      // 既不暴露存在性差异，也不把内部错误信封递回未认证调用方（服务端日志仍可定位）。
      if (!(e instanceof BusinessException && e.code === ErrorCode.SHARE_NOT_FOUND.code)) {
        request.log.error({ err: e, requestId: request.id }, 'public share view failed');
      }
      return reply.status(404).send({ error: 'not found' });
    }
  });
}

function pathToken(request: { params: unknown }): string {
  const token = (request.params as { token?: string }).token ?? '';
  if (!/^[0-9a-f]{64}$/i.test(token)) {
    throw new BusinessException(ErrorCode.SHARE_NOT_FOUND);
  }
  return token.toLowerCase();
}

function sendJsonl(reply: FastifyReply, filename: string, jsonl: string): FastifyReply {
  return reply
    .header('Content-Type', 'application/x-ndjson; charset=utf-8')
    .header('Content-Disposition', contentDisposition('attachment', filename))
    .send(jsonl);
}
