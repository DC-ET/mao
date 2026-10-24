import type { FastifyInstance } from 'fastify';
import { sendOk } from '../common/http-error.js';
import { bodyOf } from '../common/request.js';
import { hasText } from '../common/case.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { EcpAuthService } from './ecp-auth.service.js';
import type { EcpCallbackTarget } from './ecp.config.js';
import { renderEcpChannelCallbackPage } from './ecp-channel-callback-page.js';

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

  /**
   * 飞书通道「点我绑定」的公网落点：ECP 换票后直接 302 到这里。
   * 由网关（apihub）暴露到公网，返回 HTML，不依赖桌面端 SPA，也不签发登录凭证。
   */
  app.get('/v1/auth/ecp/feishu/channel-callback', async (request, reply) => {
    const query = request.query as { state?: string; code?: string };
    const outcome = await ecp.completeChannelCallback(query.state, query.code);
    return reply
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Robots-Tag', 'noindex')
      .type('text/html; charset=utf-8')
      .send(renderEcpChannelCallbackPage(outcome));
  });
}

function parseTarget(value: string | undefined): EcpCallbackTarget {
  if (value === 'admin') return 'admin';
  if (value === 'desktop' || value == null || value === '') return 'desktop';
  throw new BusinessException(ErrorCode.PARAM_INVALID, 'target 必须为 desktop 或 admin');
}
