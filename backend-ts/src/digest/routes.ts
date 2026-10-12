import type { FastifyInstance } from 'fastify';
import { sendOk } from '../common/http-error.js';
import { requireUserId } from '../common/http-error.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { bodyOf } from '../common/request.js';
import type { DigestService } from './service.js';

/**
 * 每日运营摘要用户级 API（技术方案 §5.7）。全部为登录态 + 本人数据，不加管理权限码。
 */
export interface DigestRouteDeps {
  service: DigestService;
}

export function registerDigestRoutes(app: FastifyInstance, deps: DigestRouteDeps): void {
  app.get('/v1/digest/preferences', async (request, reply) => {
    const userId = requireUserId(request);
    return sendOk(reply, await deps.service.getPreferencesView(userId));
  });

  app.patch('/v1/digest/preferences', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<Record<string, unknown>>(request);
    const patch: { enabled?: boolean; pushTime?: string; outboundEnabled?: boolean } = {};
    if ('enabled' in body) {
      if (typeof body.enabled !== 'boolean') {
        throw new BusinessException(ErrorCode.PARAM_INVALID, 'enabled 必须为布尔值');
      }
      patch.enabled = body.enabled;
    }
    if ('pushTime' in body) {
      if (typeof body.pushTime !== 'string') {
        throw new BusinessException(ErrorCode.PARAM_INVALID, 'pushTime 必须为 HH:MM 字符串');
      }
      patch.pushTime = body.pushTime;
    }
    if ('outboundEnabled' in body) {
      if (typeof body.outboundEnabled !== 'boolean') {
        throw new BusinessException(ErrorCode.PARAM_INVALID, 'outboundEnabled 必须为布尔值');
      }
      patch.outboundEnabled = body.outboundEnabled;
    }
    return sendOk(reply, await deps.service.savePreferences(userId, patch));
  });

  /** 试发：走与调度器同一条生成与投递链路，不写 last_digest_date（可重复调用）。 */
  app.post('/v1/digest/send-now', async (request, reply) => {
    const userId = requireUserId(request);
    return sendOk(reply, await deps.service.processUser(userId, { force: true }));
  });
}
