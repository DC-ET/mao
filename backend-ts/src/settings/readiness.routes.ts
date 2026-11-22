import type { FastifyInstance } from 'fastify';
import type { OnboardingCompleteInput } from '@mao/contracts';
import { requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf } from '../common/request.js';
import type { ReadinessService } from './readiness.service.js';

export interface ReadinessRouteDeps {
  readinessService: ReadinessService;
  permissionService: { isAdmin(userId: number): Promise<boolean> };
  /** 浏览器直播录制开关（V202）：随 readiness 下发（仅登录即可读），桌面 LOCAL 注入链消费；缺省不返回该字段。 */
  browserLiveRecordEnabled?: () => Promise<boolean>;
}

export function registerReadinessRoutes(app: FastifyInstance, deps: ReadinessRouteDeps): void {
  app.get('/v1/readiness', async (request, reply) => {
    const userId = requireUserId(request);
    const isAdmin = await deps.permissionService.isAdmin(userId);
    const vo = await deps.readinessService.getReadiness(userId, isAdmin);
    if (!deps.browserLiveRecordEnabled) {
      return sendOk(reply, vo);
    }
    // 读取失败视为关闭（桌面注入链的保守兜底），不阻断 readiness 主流程
    const browserLiveRecordEnabled = await deps.browserLiveRecordEnabled().catch(() => false);
    return sendOk(reply, { ...vo, browserLiveRecordEnabled });
  });

  app.put('/v1/readiness/onboarding', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<OnboardingCompleteInput>(request);
    const rawAgentId = typeof body.chosenAgentId === 'string' ? Number(body.chosenAgentId) : body.chosenAgentId;
    const chosenAgentId = typeof rawAgentId === 'number' && Number.isFinite(rawAgentId) && rawAgentId > 0
      ? rawAgentId
      : null;
    await deps.readinessService.completeOnboarding(userId, {
      chosenAgentId,
      skipped: body.skipped === true,
    });
    return sendOk(reply, { ok: true });
  });
}
