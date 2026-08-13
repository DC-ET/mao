import type { FastifyInstance } from 'fastify';
import { requireUserId } from '../common/auth.js';
import { sendJson } from '../common/http-error.js';
import { ok } from '../common/result.js';
import type { JwtService } from '../crypto/jwt.service.js';
import type { QrLoginService } from './qr-login.service.js';
import type { WeixinAccountRepository } from './account.repository.js';
import type { WeixinMonitorService } from './monitor.service.js';

export interface WeixinBotRouteDeps {
  jwt: JwtService;
  qrLogin: QrLoginService;
  accountRepository: WeixinAccountRepository;
  monitorService: WeixinMonitorService;
}

function param(req: { query?: unknown; body?: unknown }, name: string): string {
  const q = (req.query ?? {}) as Record<string, string>;
  const b = (req.body ?? {}) as Record<string, string>;
  return q[name] ?? b[name] ?? '';
}

export function registerWeixinBotRoutes(app: FastifyInstance, deps: WeixinBotRouteDeps): void {
  app.get('/v1/weixin/qrcode', async (req, reply) => {
    const userId = requireUserId(req, deps.jwt);
    sendJson(reply, 200, ok(await deps.qrLogin.getQrcode(userId)));
  });

  app.get('/v1/weixin/qrcode/status', async (req, reply) => {
    requireUserId(req, deps.jwt);
    const sessionKey = param(req, 'sessionKey');
    sendJson(reply, 200, ok(await deps.qrLogin.getQrcodeStatus(sessionKey)));
  });

  app.post('/v1/weixin/binding/confirm', async (req, reply) => {
    const userId = requireUserId(req, deps.jwt);
    await deps.qrLogin.saveBindingCredentials(
      userId,
      param(req, 'botToken'),
      param(req, 'baseUrl'),
      param(req, 'ilinkUserId'),
    );
    deps.qrLogin.clearQrcodeSession(param(req, 'sessionKey'));
    sendJson(reply, 200, ok(null));
  });

  app.get('/v1/weixin/binding/status', async (req, reply) => {
    const userId = requireUserId(req, deps.jwt);
    sendJson(reply, 200, ok(await deps.accountRepository.getBindingStatus(userId)));
  });

  app.delete('/v1/weixin/binding', async (req, reply) => {
    const userId = requireUserId(req, deps.jwt);
    const account = await deps.accountRepository.findByUserId(userId);
    if (account?.accountId) {
      deps.monitorService.stopMonitor(account.accountId);
    }
    await deps.accountRepository.unbind(userId);
    sendJson(reply, 200, ok(null));
  });
}
