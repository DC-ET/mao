import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requireUserId, sendOk } from '../common/http-error.js';
import { pathId, pathParam } from '../common/request.js';
import type { BrowserReplayService } from './browser-replay.service.js';
import { parseReplayListQuery, type BrowserReplayCatalogService } from './browser-replay-catalog.service.js';

export interface BrowserReplayRouteDeps {
  sessionService: { getSession(sessionId: number): Promise<{ userId: number }> };
  replayService: BrowserReplayService;
  catalogService: BrowserReplayCatalogService;
}

/**
 * 浏览器直播回放读取 API（技术方案 2026-11-22 §4.1）。归属校验参照 session.routes 的
 * requireSessionOwner 模式（requireUserId + userId 比对 FORBIDDEN）；帧文件经 liveId/seq
 * 白名单 + containment 断言后直读，Content-Type image/jpeg、Cache-Control private（帧不可变）。
 */
export function registerBrowserReplayRoutes(app: FastifyInstance, deps: BrowserReplayRouteDeps): void {
  async function requireSessionOwner(userId: number, sessionId: number): Promise<void> {
    const session = await deps.sessionService.getSession(sessionId);
    if (session.userId !== userId) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '无权访问该会话');
    }
  }

  /** timeline 帧序号参数：纯数字白名单（seq 非连续，播放按 timeline 顺序驱动）。 */
  function seqParam(request: FastifyRequest): number {
    const raw = pathParam(request, 'seq');
    if (!/^\d+$/.test(raw)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '路径参数 seq 必须为非负整数');
    }
    return Number(raw);
  }

  app.get('/v1/browser-live/replays', async (request, reply: FastifyReply) => {
    // 本人跨会话回放列表（技术方案 2026-11-27 §4.2）：扫本人 runtime 目录，默认 30D
    const userId = requireUserId(request);
    const { filters, page, size, refresh } = parseReplayListQuery(request, '30D');
    return sendOk(reply, await deps.catalogService.listForUser(userId, filters, page, size, refresh));
  });

  app.get('/v1/sessions/:sid/browser-live/replays', async (request, reply: FastifyReply) => {
    const userId = requireUserId(request);
    const sessionId = pathId(request, 'sid');
    await requireSessionOwner(userId, sessionId);
    return sendOk(reply, deps.replayService.listReplays(userId, sessionId));
  });

  app.get('/v1/sessions/:sid/browser-live/replays/:liveId/timeline', async (request, reply: FastifyReply) => {
    const userId = requireUserId(request);
    const sessionId = pathId(request, 'sid');
    await requireSessionOwner(userId, sessionId);
    const timeline = deps.replayService.timeline(userId, sessionId, pathParam(request, 'liveId'));
    if (timeline == null) {
      return reply.status(404).send();
    }
    return sendOk(reply, timeline);
  });

  app.get('/v1/sessions/:sid/browser-live/replays/:liveId/frames/:seq', async (request, reply: FastifyReply) => {
    const userId = requireUserId(request);
    const sessionId = pathId(request, 'sid');
    await requireSessionOwner(userId, sessionId);
    const buffer = deps.replayService.frameBuffer(userId, sessionId, pathParam(request, 'liveId'), seqParam(request));
    if (buffer == null) {
      return reply.status(404).send();
    }
    return reply
      .type('image/jpeg')
      .header('Cache-Control', 'private, max-age=86400')
      .send(buffer);
  });
}
