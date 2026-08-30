import type { FastifyInstance } from 'fastify';
import { sendOk } from '../common/http-error.js';
import { bodyOf } from '../common/request.js';
import { hasText } from '../common/case.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { AuthService } from './auth.service.js';
import type { FeishuAuthService } from './feishu-auth.service.js';

export function registerAuthRoutes(app: FastifyInstance, auth: AuthService, feishu: FeishuAuthService): void {
  app.post('/v1/auth/login', async (request, reply) => {
    const body = bodyOf<{ username?: string; password?: string }>(request);
    if (!hasText(body.username) || !hasText(body.password)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '用户名不能为空');
    }
    return sendOk(reply, await auth.login(body.username!, body.password!));
  });

  app.get('/v1/auth/features', async (_request, reply) => {
    return sendOk(reply, { feishuEnabled: await feishu.isEnabled() });
  });

  app.get('/v1/auth/feishu/qrcode', async (_request, reply) => {
    return sendOk(reply, await feishu.getQrCodeUrl());
  });

  app.post('/v1/auth/feishu/callback', async (request, reply) => {
    const body = bodyOf<{ code?: string }>(request);
    if (!hasText(body.code)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '授权码不能为空');
    }
    return sendOk(reply, await feishu.handleCallback(body.code!));
  });

  app.get('/v1/auth/feishu/callback', async (request, reply) => {
    const q = request.query as { code?: string; state?: string };
    const html = await feishu.renderCallbackPage(q.state, q.code);
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get('/v1/auth/feishu/status', async (request, reply) => {
    const state = (request.query as { state?: string }).state ?? '';
    return sendOk(reply, await feishu.getLoginStatus(state));
  });

  app.post('/v1/auth/refresh', async (request, reply) => {
    const body = bodyOf<{ refreshToken?: string }>(request);
    if (!hasText(body.refreshToken)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'Refresh Token 不能为空');
    }
    return sendOk(reply, await auth.refreshToken(body.refreshToken!));
  });

  app.post('/v1/auth/logout', async (_request, reply) => {
    auth.logout();
    return sendOk(reply);
  });
}
