import { spawn } from 'node:child_process';
import { existsSync, accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { requireUserId } from '../common/auth.js';
import { sendJson } from '../common/http-error.js';
import { ok } from '../common/result.js';
import type { JwtService } from '../crypto/jwt.service.js';
import type { PasswordHasher, UserRepository } from '../user/types.js';
import { SESSION_STALE_MINUTES } from '../domain/types.js';
import type { AdminAnalyticsService } from './admin-analytics.service.js';

export interface AdminSessionLister {
  listSessionsForAdmin(
    page: number,
    size: number,
    userId?: number,
    agentId?: number,
    executionMode?: string,
    phase?: string,
    keyword?: string,
    status?: string,
  ): Promise<{ records: unknown[]; total: number; current: number; size: number }>;
}

export interface AdminRouteDeps {
  jwt: JwtService;
  analytics: AdminAnalyticsService;
  sessionLister?: AdminSessionLister;
  userRepo: UserRepository;
  passwordHasher: PasswordHasher;
  rootDir: string;
  restartScript?: string;
}

const ADMIN_USERNAME = 'admin';
let restarting = false;

export function registerAdminAnalyticsRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  app.get('/v1/admin/analytics/summary', async (req, reply) => {
    requireUserId(req, deps.jwt);
    const days = Number((req.query as { days?: string }).days ?? 30);
    sendJson(reply, 200, ok(await deps.analytics.summary(Math.max(1, Math.min(days, 90)))));
  });
}

export function registerAdminRuntimeRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  app.get('/v1/admin/runtime/sessions', async (req, reply) => {
    requireUserId(req, deps.jwt);
    const q = req.query as {
      page?: string;
      size?: string;
      userId?: string;
      agentId?: string;
      executionMode?: string;
      phase?: string;
      keyword?: string;
      status?: string;
    };
    const page = Number(q.page ?? 1);
    const size = Number(q.size ?? 20);
    const runtimePhase = !q.phase || q.phase.trim() === ''
      ? 'RUNNING,RESUMING,WAITING_APPROVAL,FAILED,CANCELLED'
      : q.phase;
    if (!deps.sessionLister) {
      sendJson(reply, 200, ok({ records: [], total: 0, page, size }));
      return;
    }
    const result = await deps.sessionLister.listSessionsForAdmin(
      page,
      size,
      q.userId != null ? Number(q.userId) : undefined,
      q.agentId != null ? Number(q.agentId) : undefined,
      q.executionMode,
      runtimePhase,
      q.keyword,
      q.status,
    );
    sendJson(reply, 200, ok(result));
  });

  app.get('/v1/admin/runtime/stale-threshold', async (req, reply) => {
    requireUserId(req, deps.jwt);
    sendJson(reply, 200, ok({ staleMinutes: SESSION_STALE_MINUTES }));
  });

  app.get('/v1/admin/runtime/restart', async (req, reply) => {
    const key = (req.query as { key?: string }).key ?? '';
    await assertAdminPasswordKey(key, deps);
    const script = resolve(deps.restartScript ?? `${deps.rootDir}/backend-ts/restart.sh`);
    if (!existsSync(script)) {
      throw new BusinessException(500, `重启脚本不存在: ${script}`);
    }
    try {
      accessSync(script, constants.X_OK);
    } catch {
      throw new BusinessException(500, `重启脚本不可执行: ${script}`);
    }
    if (restarting) {
      throw new BusinessException(409, '重启已在进行中');
    }
    restarting = true;
    console.warn(`Backend restart triggered via key auth, script=${script}`);
    setTimeout(() => {
      try {
        const child = spawn('setsid', [script], {
          detached: true,
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        child.unref();
        console.info(`Restart script launched: ${script}`);
      } catch (e) {
        restarting = false;
        console.error(`Failed to launch restart script ${script}`, e);
      }
    }, 800);
    sendJson(reply, 200, ok({
      accepted: true,
      message: '重启指令已接受，服务即将重启',
      script,
    }));
  });
}

async function assertAdminPasswordKey(key: string, deps: AdminRouteDeps): Promise<void> {
  if (!key || key.trim() === '') {
    throw new BusinessException(401, 'key 无效');
  }
  const admin = await deps.userRepo.findByUsername(ADMIN_USERNAME);
  if (!admin || !admin.passwordHash) {
    throw new BusinessException(500, 'admin 用户不存在或未设置本地密码');
  }
  if (admin.status != null && admin.status === 0) {
    throw new BusinessException(403, 'admin 账号已禁用');
  }
  if (!(await deps.passwordHasher.matches(key, admin.passwordHash))) {
    throw new BusinessException(401, 'key 无效');
  }
}

export function resetRestartingFlag(): void {
  restarting = false;
}
