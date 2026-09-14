import type { FastifyInstance } from 'fastify';
import { sendOk } from '../common/http-error.js';
import { bodyOf } from '../common/request.js';
import { hasText } from '../common/case.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { EcpAuthService } from './ecp-auth.service.js';
import type { EcpCallbackTarget } from './ecp.config.js';

export function registerEcpAuthRoutes(app: FastifyInstance, ecp: EcpAuthService): void {
  app.post('/v1/auth/ecp/feishu/start', async (request, reply) => {
    const body = bodyOf<{ target?: string }>(request);
    const target = parseTarget(body.target);
    return sendOk(reply, await ecp.startFeishuLogin(target));
  });

  app.post('/v1/auth/ecp/feishu/callback', async (request, reply) => {
    const body = bodyOf<{ state?: string; code?: string }>(request);
    if (!hasText(body.state) || !hasText(body.code)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'state 与 code 不能为空');
    }
    return sendOk(reply, await ecp.handleCallback(body.state!, body.code!));
  });

  app.get('/v1/auth/ecp/feishu/status', async (request, reply) => {
    const state = (request.query as { state?: string }).state ?? '';
    return sendOk(reply, await ecp.getLoginStatus(state));
  });
}

function parseTarget(value: string | undefined): EcpCallbackTarget {
  if (value === 'admin') return 'admin';
  if (value === 'desktop' || value == null || value === '') return 'desktop';
  throw new BusinessException(ErrorCode.PARAM_INVALID, 'target 必须为 desktop 或 admin');
}
