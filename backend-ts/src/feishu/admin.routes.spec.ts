import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerFeishuBotRoutes } from './admin.routes.js';
import type { FeishuBotRuntimeStatus } from './monitor.service.js';
import type { FeishuBot, FeishuBotRepository } from './types.js';

function bot(overrides: Partial<FeishuBot> = {}): FeishuBot {
  return {
    id: 1, appKey: 'k1', name: 'bot-1', appId: 'cli_app_1', appSecret: 'cipher:secret',
    agentId: null, modelId: null, enabled: 1, deleted: 0, ...overrides,
  };
}

function createRepo(bots: FeishuBot[]): FeishuBotRepository {
  return {
    list: vi.fn(async () => bots),
    findById: vi.fn(async (id: number) => bots.find((b) => b.id === id) ?? null),
    findByAppKey: vi.fn(async () => null),
    create: vi.fn(async () => 1),
    update: vi.fn(async () => undefined),
    softDelete: vi.fn(async () => undefined),
  };
}

async function createApp(bots: FeishuBot[], options: {
  admin?: boolean;
  allow?: string[];
  status?: FeishuBotRuntimeStatus | null;
  reconnect?: (botId: number) => Promise<boolean>;
} = {}) {
  const app = Fastify();
  app.setErrorHandler(handleError);
  app.addHook('preHandler', (req, _r, done) => {
    req.userId = 9;
    done();
  });
  const repository = createRepo(bots);
  registerFeishuBotRoutes(app, {
    repository,
    secretKey: 'key',
    permissionService: {
      hasPermission: vi.fn(async (_userId: number, code: string) => (
        options.allow ? options.allow.includes(code) : options.admin !== false
      )),
    },
    monitorStatus: { getStatus: vi.fn((_botId: number) => options.status ?? null) },
    monitorReconnect: { reconnect: vi.fn(options.reconnect ?? (async () => true)) },
  });
  return { app, repository };
}

describe('admin feishu bot status routes', () => {
  it('returns connection status for each bot with failure details', async () => {
    const { app } = await createApp([bot(), bot({ id: 2, appKey: 'k2', name: 'bot-2', appId: 'cli_app_2', enabled: 0 })], {
      status: { botId: 1, status: 'failed', lastFailureReason: 'appSecret 解密失败', lastFailureAt: '2026-09-19T01:00:00.000Z', lastReadyAt: '2026-09-18T23:00:00.000Z' },
    });
    const res = JSON.parse((await app.inject({ method: 'GET', url: '/v1/admin/feishu-bots/status' })).body);
    expect(res.code).toBe(0);
    expect(res.data).toHaveLength(2);
    expect(res.data[0]).toMatchObject({
      botId: 1, appId: 'cli_app_1', enabled: 1, status: 'failed',
      lastFailureReason: 'appSecret 解密失败',
      lastFailureAt: '2026-09-19T01:00:00.000Z',
      lastReadyAt: '2026-09-18T23:00:00.000Z',
    });
    // 未被 monitor 接管的 bot 状态为 disabled
    expect(res.data[1]).toMatchObject({ botId: 2, enabled: 0, status: 'disabled' });
    await app.close();
  });

  it('marks unmonitored enabled bots as disabled when monitor has no state', async () => {
    const { app } = await createApp([bot()], {});
    const res = JSON.parse((await app.inject({ method: 'GET', url: '/v1/admin/feishu-bots/status' })).body);
    expect(res.code).toBe(0);
    expect(res.data[0]).toMatchObject({ botId: 1, status: 'disabled' });
    expect(res.data[0].lastFailureReason).toBeUndefined(); // null 字段被 toJacksonJson 剔除
    await app.close();
  });

  it('triggers reconnect for an enabled bot', async () => {
    const reconnect = vi.fn(async (botId: number) => botId === 1);
    const { app } = await createApp([bot()], {
      status: { botId: 1, status: 'reconnecting', lastFailureReason: null, lastFailureAt: null, lastReadyAt: null },
      reconnect,
    });
    const res = JSON.parse((await app.inject({ method: 'POST', url: '/v1/admin/feishu-bots/1/reconnect' })).body);
    expect(res.code).toBe(0);
    expect(res.data).toMatchObject({ botId: 1, status: 'reconnecting' });
    expect(reconnect).toHaveBeenCalledWith(1);
    await app.close();
  });

  it('rejects reconnect for missing or disabled bots', async () => {
    const reconnect = vi.fn(async () => true);
    const { app } = await createApp([bot({ enabled: 0 })], { reconnect });
    const missing = JSON.parse((await app.inject({ method: 'POST', url: '/v1/admin/feishu-bots/99/reconnect' })).body);
    expect(missing.code).toBe(2001);
    const disabled = JSON.parse((await app.inject({ method: 'POST', url: '/v1/admin/feishu-bots/1/reconnect' })).body);
    expect(disabled.code).toBe(2001);
    expect(reconnect).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects status endpoints without admin permission', async () => {
    const { app } = await createApp([bot()], { admin: false });
    const status = JSON.parse((await app.inject({ method: 'GET', url: '/v1/admin/feishu-bots/status' })).body);
    expect(status.code).toBe(1002);
    const reconnect = JSON.parse((await app.inject({ method: 'POST', url: '/v1/admin/feishu-bots/1/reconnect' })).body);
    expect(reconnect.code).toBe(1002);
    await app.close();
  });

  it('allows feishu-bot:read to view status but not reconnect', async () => {
    const reconnect = vi.fn(async () => true);
    const { app } = await createApp([bot()], {
      allow: ['feishu-bot:read'],
      reconnect,
      status: { botId: 1, status: 'ready', lastFailureReason: null, lastFailureAt: null, lastReadyAt: null },
    });
    const status = JSON.parse((await app.inject({ method: 'GET', url: '/v1/admin/feishu-bots/status' })).body);
    expect(status.code).toBe(0);
    const denied = JSON.parse((await app.inject({ method: 'POST', url: '/v1/admin/feishu-bots/1/reconnect' })).body);
    expect(denied.code).toBe(1002);
    expect(reconnect).not.toHaveBeenCalled();
    await app.close();
  });
});
