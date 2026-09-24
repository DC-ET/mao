import type { FastifyInstance, FastifyReply } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requireUserId } from '../common/auth.js';
import { sendJson } from '../common/http-error.js';
import { pathParam } from '../common/request.js';
import { ok } from '../common/result.js';
import type { JwtService } from '../crypto/jwt.service.js';
import type { MysqlDingtalkBindingRepository } from './binding.repository.js';
import { dingtalkAuthorizeUrl, oauthConfigured, webOriginOf, type DingtalkOauthConfig } from './oauth-client.js';
import type { MysqlDingtalkOauthStateRepository } from './oauth.repository.js';

const SETTINGS_TTL_MS = 10 * 60 * 1000;

export interface DingtalkBindingRouteDeps {
  jwt: JwtService;
  repository: MysqlDingtalkBindingRepository;
  oauthStates: MysqlDingtalkOauthStateRepository;
  oauth: DingtalkOauthConfig;
  onCallback: (state: string, userId: number, code: string) => Promise<void>;
}

export function registerDingtalkBindingRoutes(app: FastifyInstance, deps: DingtalkBindingRouteDeps): void {
  app.get('/v1/dingtalk/binding/status', async (request, reply) => {
    const userId = requireUserId(request, deps.jwt);
    return sendJson(reply, 200, ok(await deps.repository.getStatus(userId)));
  });

  app.post('/v1/dingtalk/binding', async (request, reply) => {
    const userId = requireUserId(request, deps.jwt);
    if (!oauthConfigured(deps.oauth)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '管理员尚未配置钉钉登录，暂时无法绑定');
    }
    const state = await deps.oauthStates.create(userId, SETTINGS_TTL_MS);
    return sendJson(reply, 200, ok({ authUrl: dingtalkAuthorizeUrl(deps.oauth, state), state }));
  });

  app.delete('/v1/dingtalk/binding', async (request, reply) => {
    const userId = requireUserId(request, deps.jwt);
    await deps.repository.unbind(userId);
    return sendJson(reply, 200, ok(null));
  });

  app.get('/v1/dingtalk/bind/:state', async (request, reply) => {
    const state = pathParam(request, 'state');
    const origin = webOriginOf(deps.oauth.redirectUri);
    const userId = request.userId;
    if (userId == null) {
      if (origin == null) return reply.code(503).type('text/plain').send('管理员尚未配置钉钉登录，暂时无法绑定');
      return reply.redirect(`${origin}/login?redirect=${encodeURIComponent(`/dingtalk/bind/${state}`)}`);
    }
    const attached = await deps.oauthStates.attachUser(state, userId);
    if (attached !== 'OK' || !oauthConfigured(deps.oauth)) {
      return redirectSettings(reply, origin, 'bindError=expired');
    }
    return reply.redirect(dingtalkAuthorizeUrl(deps.oauth, state));
  });

  app.get('/v1/dingtalk/oauth/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string };
    const origin = webOriginOf(deps.oauth.redirectUri);
    const state = query.state ?? '';
    const code = query.code ?? '';
    const consumed = state === '' ? null : await deps.oauthStates.consume(state);
    if (consumed?.userId == null || code === '') {
      return redirectSettings(reply, origin, 'bindError=expired');
    }
    try {
      await deps.onCallback(state, consumed.userId, code);
      return redirectSettings(reply, origin, 'bound=1');
    } catch (error) {
      await deps.oauthStates.fail(state).catch(() => undefined);
      const message = error instanceof Error ? error.message : '绑定失败';
      return redirectSettings(reply, origin, `bindError=${encodeURIComponent(message)}`);
    }
  });
}

function redirectSettings(reply: FastifyReply, origin: string | null, query: string): FastifyReply {
  if (origin == null) return reply.code(400).type('text/plain').send(query);
  return reply.redirect(`${origin}/settings/dingtalk-bot?${query}`);
}
