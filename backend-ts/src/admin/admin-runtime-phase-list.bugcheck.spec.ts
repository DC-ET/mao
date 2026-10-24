import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerAdminRuntimeRoutes } from './admin.routes.js';
import { ACTIVE_PHASES } from '../session/util/session-group-key.js';

/**
 * 「运行监控」默认列表必须覆盖全部活跃相位。
 *
 * 默认过滤集是 `RUNNING,RESUMING,WAITING_APPROVAL,FAILED,CANCELLED`：已经为了「异常也在跑」
 * 收进两个终态，却漏掉 CANCELLING —— 而 CANCELLING 是仓内 ACTIVE_PHASES 定义的活跃相位
 * （session/util/session-group-key.ts:238），取消中的会话因此从运行监控里消失。
 */
async function makeApp() {
  const listSessionsForAdmin = vi.fn(async () => ({ records: [], total: 0, current: 1, size: 20 }));
  const app = Fastify();
  app.setErrorHandler(handleError);
  app.addHook('preHandler', (req, _reply, done) => {
    (req as unknown as { userId: number }).userId = 7;
    done();
  });
  registerAdminRuntimeRoutes(app, {
    jwt: {} as never,
    analytics: {} as never,
    permissionService: { hasPermission: vi.fn(async () => true) },
    sessionLister: { listSessionsForAdmin },
  } as never);
  return { app, listSessionsForAdmin };
}

describe('admin 运行监控默认相位集', () => {
  it('默认列表必须包含 ACTIVE_PHASES 的每个相位（当前漏 CANCELLING）', async () => {
    const { app, listSessionsForAdmin } = await makeApp();
    await app.inject({ method: 'GET', url: '/v1/admin/runtime/sessions' });

    const phaseArg = listSessionsForAdmin.mock.calls[0]?.[5] as string;
    const phases = phaseArg.split(',').map((phase) => phase.trim());
    for (const active of ACTIVE_PHASES) {
      expect(phases).toContain(active);
    }
    await app.close();
  });

  it('对照：显式传 phase 时原样透传', async () => {
    const { app, listSessionsForAdmin } = await makeApp();
    await app.inject({ method: 'GET', url: '/v1/admin/runtime/sessions?phase=RUNNING' });

    expect(listSessionsForAdmin.mock.calls[0]?.[5]).toBe('RUNNING');
    await app.close();
  });
});
