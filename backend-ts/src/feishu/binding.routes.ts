import type { FastifyInstance } from 'fastify';
import { requireUserId } from '../common/auth.js';
import { sendJson } from '../common/http-error.js';
import { ok } from '../common/result.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { parseSqlTimeMs } from '../app-utils.js';
import type { JwtService } from '../crypto/jwt.service.js';
import {
  bindOutcomeToResult,
  completePendingAfterBind,
  feishuUnionIdOf,
  PASSWORD_BIND_LINK_TTL_MS,
} from '../channel-bind/bind-flow.js';
import type { FeishuBindingRepository } from './binding.repository.js';
import type { FeishuAuthService } from '../auth/feishu-auth.service.js';
import type { FeishuPendingBindingMessage, MysqlFeishuPendingBindingRepository } from './pending-binding.repository.js';

export interface FeishuBindingRouteDeps { jwt: JwtService; repository: FeishuBindingRepository; auth?: FeishuAuthService; }
export function registerFeishuBindingRoutes(app: FastifyInstance, deps: FeishuBindingRouteDeps): void {
  app.get('/v1/feishu/binding/status', async (request, reply) => sendJson(reply, 200, ok(await deps.repository.getStatus(requireUserId(request, deps.jwt)))));
  app.post('/v1/feishu/binding', async (request, reply) => {
    const userId = requireUserId(request, deps.jwt);
    if (deps.auth == null) return sendJson(reply, 200, ok({ authUrl: '' }));
    const link = await deps.auth.getQrCodeUrl(userId);
    return sendJson(reply, 200, ok(link));
  });
  app.delete('/v1/feishu/binding', async (request, reply) => {
    const userId = requireUserId(request, deps.jwt);
    await deps.repository.unbind(userId);
    return sendJson(reply, 200, ok(null));
  });
}

// ========== 密码登录绑定（技术方案 2026-11-19-channel-password-bind §4.3） ==========

const FEISHU_PENDING_INVALID_TEXT = '链接已过期或已使用，请回 IM 重新发送一条消息';

export interface FeishuPendingBindingRouteDeps {
  jwt: JwtService;
  binding: FeishuBindingRepository;
  pendingBindingMessages: MysqlFeishuPendingBindingRepository;
  /** 当前登录 Mao 账号的展示信息（确认卡「→ Mao 账号 bob」用）；disabled = 账号已禁用。 */
  currentUser: (userId: number) => Promise<{ id: number; username: string | null; disabled: boolean } | null>;
  /** 补投原消息：ctx.pendingBindingProcessor 延迟解引用（处理器在路由注册后才装配）。 */
  replay: (pending: FeishuPendingBindingMessage) => Promise<void>;
  notifyMismatch?: (pending: FeishuPendingBindingMessage) => Promise<void>;
}

const FEISHU_DISABLED_TEXT = '账号已禁用，无法完成绑定';

function feishuPendingExpired(row: { createdAt?: string | null }): boolean {
  const createdAtMs = parseSqlTimeMs(row.createdAt ?? null);
  return createdAtMs == null || Date.now() - createdAtMs > PASSWORD_BIND_LINK_TTL_MS;
}

export function registerFeishuPendingBindingRoutes(app: FastifyInstance, deps: FeishuPendingBindingRouteDeps): void {
  app.get('/v1/feishu/binding/pending', async (request, reply) => {
    const userId = requireUserId(request, deps.jwt);
    const state = String((request.query as { state?: string } | undefined)?.state ?? '').trim();
    if (state === '') throw new BusinessException(ErrorCode.PARAM_INVALID, FEISHU_PENDING_INVALID_TEXT);
    const row = await deps.pendingBindingMessages.findByState(state);
    if (row == null || feishuPendingExpired(row)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, FEISHU_PENDING_INVALID_TEXT);
    }
    // 飞书 claim 不拦 created_at 过期，TTL 在预览与 complete 两处显式判断
    const user = await deps.currentUser(userId);
    if (user?.disabled) throw new BusinessException(ErrorCode.PARAM_INVALID, FEISHU_DISABLED_TEXT);
    const status = await deps.binding.getStatus(userId);
    const createdAtMs = parseSqlTimeMs(row.createdAt ?? null);
    return sendJson(reply, 200, ok({
      senderName: row.event.senderName ?? null,
      chatType: row.event.chatType,
      expiresAt: createdAtMs == null ? null : new Date(createdAtMs + PASSWORD_BIND_LINK_TTL_MS).toISOString(),
      currentUser: user == null ? null : { id: userId, username: user.username },
      willRebind: status.bound,
    }));
  });

  app.post('/v1/feishu/binding/complete', async (request, reply) => {
    const userId = requireUserId(request, deps.jwt);
    const body = (request.body ?? {}) as { state?: unknown };
    const state = typeof body.state === 'string' ? body.state.trim() : '';
    if (state === '') throw new BusinessException(ErrorCode.PARAM_INVALID, FEISHU_PENDING_INVALID_TEXT);
    const row = await deps.pendingBindingMessages.findByState(state);
    const senderName = row?.event.senderName ?? null;
    if (row == null || feishuPendingExpired(row)) {
      return sendJson(reply, 200, ok({ status: 'failed', message: FEISHU_PENDING_INVALID_TEXT, senderName }));
    }
    // 账号已禁用：complete 前显式拒绝（§4.6；JWT 钩子另有全局停用拦截）
    const user = await deps.currentUser(userId);
    if (user?.disabled) {
      return sendJson(reply, 200, ok({ status: 'failed', message: FEISHU_DISABLED_TEXT, senderName }));
    }
    const outcome = await completePendingAfterBind<FeishuPendingBindingMessage>({
      state,
      bindUserId: userId,
      claim: (s) => deps.pendingBindingMessages.claim(s),
      unionIdOf: feishuUnionIdOf,
      findUserIdByUnionId: (unionId) => deps.binding.findUserIdByUnionId(unionId),
      bind: (uid, unionId) => deps.binding.bind(uid, unionId),
      replay: deps.replay,
      complete: (s) => deps.pendingBindingMessages.complete(s),
      release: (s) => deps.pendingBindingMessages.release(s),
      failClaimed: (s) => deps.pendingBindingMessages.failClaimed(s),
      notifyMismatch: deps.notifyMismatch,
    });
    return sendJson(reply, 200, ok(bindOutcomeToResult(outcome, { channelLabel: '飞书', senderName })));
  });
}
