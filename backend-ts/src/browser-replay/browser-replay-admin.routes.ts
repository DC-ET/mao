import type { FastifyInstance, FastifyReply } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requireRequestPermission, sendOk } from '../common/http-error.js';
import { pathId, pathParam } from '../common/request.js';
import type { SessionService } from '../session/session.service.js';
import type { BrowserReplayService } from './browser-replay.service.js';
import { parseReplayListQuery, type BrowserReplayCatalogService } from './browser-replay-catalog.service.js';

export interface BrowserReplayAdminRouteDeps {
  sessionService: Pick<SessionService, 'getSession'>;
  replayService: BrowserReplayService;
  catalogService: BrowserReplayCatalogService;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
}

/**
 * 管理后台浏览器回放端点（/v1/admin/browser-replays，技术方案 2026-11-27 §4.2/§4.5）。
 *
 * 与 admin-session-files.routes 同口径：不做出属主校验（跨用户查看是管理端本职），
 * 门槛由 session:read 权限码 + 全局审计钩子把守（列表与 timeline 留 READ 痕迹，
 * 逐帧 frames 请求按 §D5 正则豁免，避免一次播放刷几百条审计）。
 * LOCAL 会话的录制在用户设备上，服务端无 runtime 目录，一律拒绝。
 */
export function registerBrowserReplayAdminRoutes(app: FastifyInstance, deps: BrowserReplayAdminRouteDeps): void {
  const requireRead = (request: Parameters<typeof requireRequestPermission>[1]) =>
    requireRequestPermission(deps.permissionService, request, 'session:read');

  /** 帧序号白名单：纯数字（seq 场内不连续，播放按 timeline 顺序驱动）。 */
  function seqParam(raw: string): number {
    if (!/^\d+$/.test(raw)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '路径参数 seq 必须为非负整数');
    }
    return Number(raw);
  }

  /** CLOUD 会话才可回放：LOCAL 录写在用户设备 ~/.mao/runtime，服务端不可见。 */
  async function requireCloudSession(sessionId: number): Promise<{ userId: number }> {
    const session = await deps.sessionService.getSession(sessionId);
    if (session.executionMode === 'LOCAL') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '本地执行会话的录制在用户设备上，服务端不可查看');
    }
    return session;
  }

  app.get('/v1/admin/browser-replays', async (request, reply: FastifyReply) => {
    await requireRead(request);
    const { filters, page, size, refresh } = parseReplayListQuery(request, '7D');
    return sendOk(reply, await deps.catalogService.listForAdmin(filters, page, size, refresh));
  });

  app.get('/v1/admin/browser-replays/:sessionId/:liveId/timeline', async (request, reply: FastifyReply) => {
    await requireRead(request);
    const sessionId = pathId(request, 'sessionId');
    const liveId = pathParam(request, 'liveId');
    const session = await requireCloudSession(sessionId);
    const timeline = deps.replayService.timeline(session.userId, sessionId, liveId);
    if (timeline == null) {
      return reply.status(404).send();
    }
    return sendOk(reply, timeline);
  });

  app.get('/v1/admin/browser-replays/:sessionId/:liveId/frames/:seq', async (request, reply: FastifyReply) => {
    await requireRead(request);
    const sessionId = pathId(request, 'sessionId');
    const liveId = pathParam(request, 'liveId');
    const seq = seqParam(pathParam(request, 'seq'));
    const session = await requireCloudSession(sessionId);
    const buffer = deps.replayService.frameBuffer(session.userId, sessionId, liveId, seq);
    if (buffer == null) {
      return reply.status(404).send();
    }
    return reply
      .type('image/jpeg')
      .header('Cache-Control', 'private, max-age=86400')
      .send(buffer);
  });
}
