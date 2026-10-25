import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { UserOnboardingPreference } from '../preference/types.js';
import { DEFAULT_ADMIN_PASSWORD, ReadinessService, SEED_ADMIN_USER_ID } from './readiness.service.js';
import { registerReadinessRoutes } from './readiness.routes.js';
import { hashPassword } from '../crypto/password.js';
import { handleError } from '../common/http-error.js';

function fakeOnboardingRepo() {
  const rows = new Map<number, UserOnboardingPreference>();
  return {
    rows,
    findByUserId: vi.fn(async (userId: number) => rows.get(userId) ?? null),
    insert: vi.fn(async (row: UserOnboardingPreference) => {
      rows.set(row.userId, { ...row, skipped: row.skipped ?? 0 });
    }),
  };
}

function fakeService(overrides?: {
  passwordHash?: string | null;
  adminExists?: boolean;
  modelsConfigured?: number;
  agentsEnabled?: number;
  hasSessionHistory?: boolean;
}) {
  const onboardingRepo = fakeOnboardingRepo();
  const service = new ReadinessService({
    userLookup: {
      findById: vi.fn(async (id: number) => {
        if (id !== SEED_ADMIN_USER_ID || overrides?.adminExists === false) return null;
        return { id, passwordHash: overrides?.passwordHash ?? null };
      }),
    },
    modelsConfiguredCount: vi.fn(async () => overrides?.modelsConfigured ?? 3),
    agentsEnabledCount: vi.fn(async () => overrides?.agentsEnabled ?? 2),
    sessionHistory: { existsByUserId: vi.fn(async () => overrides?.hasSessionHistory ?? false) },
    onboardingPreference: onboardingRepo,
  });
  return { service, onboardingRepo };
}

async function application(service: ReadinessService, opts?: { userId?: number; isAdmin?: boolean }) {
  const app = Fastify();
  app.setErrorHandler(handleError);
  await app.register(async (api) => {
    api.addHook('preHandler', async (request) => {
      (request as { userId?: number }).userId = opts?.userId ?? 7;
    });
    registerReadinessRoutes(api, {
      readinessService: service,
      permissionService: { isAdmin: async () => opts?.isAdmin ?? false },
    });
  }, { prefix: '/api' });
  return app;
}

describe('readiness routes', () => {
  it('管理员且默认密码未改：defaultPasswordChanged=false，其余计数与状态正确返回', async () => {
    const passwordHash = await hashPassword(DEFAULT_ADMIN_PASSWORD);
    const { service } = fakeService({ passwordHash });
    const app = await application(service, { isAdmin: true });
    const res = await app.inject({ method: 'GET', url: '/api/v1/readiness' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      defaultPasswordChanged: false, modelsConfigured: 3, agentsEnabled: 2, onboarding: 'PENDING',
    });
  });

  it('管理员已改密：defaultPasswordChanged=true', async () => {
    const passwordHash = await hashPassword('a-strong-password');
    const { service } = fakeService({ passwordHash });
    const app = await application(service, { isAdmin: true });
    const res = await app.inject({ method: 'GET', url: '/api/v1/readiness' });
    expect(res.json().data.defaultPasswordChanged).toBe(true);
  });

  it('种子管理员账号不存在：视为已改密，不报错', async () => {
    const { service } = fakeService({ adminExists: false });
    const app = await application(service, { isAdmin: true });
    const res = await app.inject({ method: 'GET', url: '/api/v1/readiness' });
    expect(res.json().data.defaultPasswordChanged).toBe(true);
  });

  it('种子管理员 passwordHash 为空：视为已改密', async () => {
    const { service } = fakeService({ passwordHash: null });
    const app = await application(service, { isAdmin: true });
    const res = await app.inject({ method: 'GET', url: '/api/v1/readiness' });
    expect(res.json().data.defaultPasswordChanged).toBe(true);
  });

  it('非管理员：defaultPasswordChanged 恒为 true（不泄漏种子状态）', async () => {
    const passwordHash = await hashPassword(DEFAULT_ADMIN_PASSWORD);
    const { service } = fakeService({ passwordHash });
    const app = await application(service, { isAdmin: false });
    const res = await app.inject({ method: 'GET', url: '/api/v1/readiness' });
    expect(res.json().data.defaultPasswordChanged).toBe(true);
  });

  it('onboarding 状态：有记录且 skipped=1 → SKIPPED；completed → DONE；有会话历史无记录 → AUTO_DONE', async () => {
    const { service, onboardingRepo } = fakeService();
    onboardingRepo.rows.set(7, { userId: 7, completedAt: new Date(), skipped: 0 });
    const app1 = await application(service);
    expect((await app1.inject({ method: 'GET', url: '/api/v1/readiness' })).json().data.onboarding).toBe('DONE');

    onboardingRepo.rows.set(7, { userId: 7, completedAt: null, skipped: 1 });
    expect((await app1.inject({ method: 'GET', url: '/api/v1/readiness' })).json().data.onboarding).toBe('SKIPPED');

    const history = fakeService({ hasSessionHistory: true });
    const app2 = await application(history.service);
    expect((await app2.inject({ method: 'GET', url: '/api/v1/readiness' })).json().data.onboarding).toBe('AUTO_DONE');
  });

  it('PUT onboarding 完成态落库；二次调用幂等不覆盖；字符串 agentId 宽容解析', async () => {
    const { service, onboardingRepo } = fakeService();
    const app = await application(service);

    const first = await app.inject({
      method: 'PUT', url: '/api/v1/readiness/onboarding',
      payload: { chosenAgentId: '5' },
    });
    expect(first.statusCode).toBe(200);
    expect(onboardingRepo.insert).toHaveBeenCalledTimes(1);
    expect(onboardingRepo.rows.get(7)?.chosenAgentId).toBe(5);
    expect(onboardingRepo.rows.get(7)?.skipped).toBe(0);
    expect(onboardingRepo.rows.get(7)?.completedAt).not.toBeNull();

    const second = await app.inject({
      method: 'PUT', url: '/api/v1/readiness/onboarding',
      payload: { skipped: true },
    });
    expect(second.statusCode).toBe(200);
    expect(onboardingRepo.insert).toHaveBeenCalledTimes(1);
    expect(onboardingRepo.rows.get(7)?.skipped).toBe(0);
  });

  it('PUT onboarding skipped=true：completed_at 为空、skipped=1', async () => {
    const { service, onboardingRepo } = fakeService();
    const app = await application(service);
    await app.inject({ method: 'PUT', url: '/api/v1/readiness/onboarding', payload: { skipped: true } });
    expect(onboardingRepo.rows.get(7)?.skipped).toBe(1);
    expect(onboardingRepo.rows.get(7)?.completedAt).toBeNull();
  });

  it('PUT onboarding 非法 agentId 归一为 null，不报错', async () => {
    const { service, onboardingRepo } = fakeService();
    const app = await application(service);
    await app.inject({ method: 'PUT', url: '/api/v1/readiness/onboarding', payload: { chosenAgentId: 'abc' } });
    expect(onboardingRepo.rows.get(7)?.chosenAgentId).toBeNull();
  });
});
