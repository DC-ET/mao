import type { FastifyInstance, FastifyReply } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requireUserId } from '../common/auth.js';
import { sendJson } from '../common/http-error.js';
import { pathParam } from '../common/request.js';
import { ok } from '../common/result.js';
import type { JwtService } from '../crypto/jwt.service.js';
import {
  bindOutcomeToResult,
  completePendingAfterBind,
  dingtalkUnionIdOf,
} from '../channel-bind/bind-flow.js';
import type { MysqlDingtalkBindingRepository } from './binding.repository.js';
import { dingtalkAuthorizeUrl, oauthConfigured, webOriginOf, type DingtalkOauthConfig } from './oauth-client.js';
import type { MysqlDingtalkOauthStateRepository } from './oauth.repository.js';
import type { DingtalkPendingBindingMessage, MysqlDingtalkPendingBindingRepository } from './pending-binding.repository.js';

const SETTINGS_TTL_MS = 10 * 60 * 1000;
const DINGTALK_PENDING_INVALID_TEXT = '链接已过期或已使用，请回 IM 重新发送一条消息';
const DINGTALK_DISABLED_TEXT = '账号已禁用，无法完成绑定';

export interface DingtalkBindingRouteDeps {
  jwt: JwtService;
  repository: MysqlDingtalkBindingRepository;
  oauthStates: MysqlDingtalkOauthStateRepository;
  /** OAuth 配置惰性读取（V191）：每次实时查 system_setting，后台保存后即时生效。 */
  oauth: () => Promise<DingtalkOauthConfig>;
  onCallback: (state: string, userId: number, code: string) => Promise<void>;
  // 密码绑定（技术方案 2026-11-19-channel-password-bind §4.3）：pending 预览 / complete
  pending: MysqlDingtalkPendingBindingRepository;
  currentUser: (userId: number) => Promise<{ id: number; username: string | null; disabled: boolean } | null>;
  /** 补投原消息（绕开合并窗口），由 runtime 注入 processor.process。 */
  replayPending: (pending: DingtalkPendingBindingMessage) => Promise<void>;
}

export function registerDingtalkBindingRoutes(app: FastifyInstance, deps: DingtalkBindingRouteDeps): void {
  app.get('/v1/dingtalk/binding/status', async (request, reply) => {
    const userId = requireUserId(request, deps.jwt);
    return sendJson(reply, 200, ok(await deps.repository.getStatus(userId)));
  });

  app.post('/v1/dingtalk/binding', async (request, reply) => {
    const userId = requireUserId(request, deps.jwt);
    const oauth = await deps.oauth();
    if (!oauthConfigured(oauth)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '管理员尚未配置钉钉登录，暂时无法绑定');
    }
    const state = await deps.oauthStates.create(userId, SETTINGS_TTL_MS);
    return sendJson(reply, 200, ok({ authUrl: dingtalkAuthorizeUrl(oauth, state), state }));
  });

  app.delete('/v1/dingtalk/binding', async (request, reply) => {
    const userId = requireUserId(request, deps.jwt);
    await deps.repository.unbind(userId);
    return sendJson(reply, 200, ok(null));
  });

  app.get('/v1/dingtalk/bind/:state', async (request, reply) => {
    const state = pathParam(request, 'state');
    const oauth = await deps.oauth();
    const origin = webOriginOf(oauth.redirectUri);
    const userId = request.userId;
    if (userId == null) {
      if (origin == null) return reply.code(503).type('text/plain').send('管理员尚未配置钉钉登录，暂时无法绑定');
      return reply.redirect(`${origin}/login?redirect=${encodeURIComponent(`/dingtalk/bind/${state}`)}`);
    }
    const attached = await deps.oauthStates.attachUser(state, userId);
    if (attached !== 'OK' || !oauthConfigured(oauth)) {
      return redirectSettings(reply, origin, 'bindError=expired');
    }
    return reply.redirect(dingtalkAuthorizeUrl(oauth, state));
  });

  // 密码绑定预览（§4.3）：findByState 只认 SENT 且未过期，TTL 由 expires_at 列保证
  app.get('/v1/dingtalk/binding/pending', async (request, reply) => {
    const userId = requireUserId(request, deps.jwt);
    const state = String((request.query as { state?: string } | undefined)?.state ?? '').trim();
    if (state === '') throw new BusinessException(ErrorCode.PARAM_INVALID, DINGTALK_PENDING_INVALID_TEXT);
    const row = await deps.pending.findByState(state);
    if (row == null) throw new BusinessException(ErrorCode.PARAM_INVALID, DINGTALK_PENDING_INVALID_TEXT);
    const user = await deps.currentUser(userId);
    if (user?.disabled) throw new BusinessException(ErrorCode.PARAM_INVALID, DINGTALK_DISABLED_TEXT);
    const status = await deps.repository.getStatus(userId);
    return sendJson(reply, 200, ok({
      senderName: row.event.senderName ?? null,
      chatType: row.event.chatType,
      expiresAt: row.expiresAt ?? null,
      currentUser: user == null ? null : { id: userId, username: user.username },
      willRebind: status.bound,
    }));
  });

  // 密码绑定完成（§4.1/§4.3）：claim 自带 expires_at 判断；身份冲突 / 改绑语义与飞书一致
  app.post('/v1/dingtalk/binding/complete', async (request, reply) => {
    const userId = requireUserId(request, deps.jwt);
    const body = (request.body ?? {}) as { state?: unknown };
    const state = typeof body.state === 'string' ? body.state.trim() : '';
    if (state === '') throw new BusinessException(ErrorCode.PARAM_INVALID, DINGTALK_PENDING_INVALID_TEXT);
    const row = await deps.pending.findByState(state);
    const senderName = row?.event.senderName ?? null;
    if (row == null) {
      return sendJson(reply, 200, ok({ status: 'failed', message: DINGTALK_PENDING_INVALID_TEXT, senderName }));
    }
    // 账号已禁用：complete 前显式拒绝（§4.6；JWT 钩子另有全局停用拦截）
    const user = await deps.currentUser(userId);
    if (user?.disabled) {
      return sendJson(reply, 200, ok({ status: 'failed', message: DINGTALK_DISABLED_TEXT, senderName }));
    }
    const outcome = await completePendingAfterBind<DingtalkPendingBindingMessage>({
      state,
      bindUserId: userId,
      claim: (s) => deps.pending.claim(s),
      unionIdOf: dingtalkUnionIdOf,
      findUserIdByUnionId: (unionId) => deps.repository.findUserIdByUnionId(unionId),
      bind: (uid, unionId, pendingRow) => deps.repository.bind(uid, unionId, pendingRow.event.senderUserid ?? ''),
      replay: deps.replayPending,
      complete: (s) => deps.pending.complete(s),
      release: (s) => deps.pending.release(s),
      failClaimed: (s) => deps.pending.fail(s),
    });
    return sendJson(reply, 200, ok(bindOutcomeToResult(outcome, { channelLabel: '钉钉', senderName })));
  });

  app.get('/v1/dingtalk/oauth/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string };
    const oauth = await deps.oauth();
    const origin = webOriginOf(oauth.redirectUri);
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
  return reply.redirect(`${origin}/settings/channel-bindings?tab=dingtalk&${query}`);
}
