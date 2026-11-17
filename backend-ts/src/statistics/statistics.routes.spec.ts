import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { HostStatusVo } from '@mao/contracts';
import { handleError } from '../common/http-error.js';
import { registerStatisticsRoutes } from './statistics.routes.js';

const snapshot: HostStatusVo = {
  hostname: 'mao-box',
  platform: 'linux',
  uptimeSeconds: 10,
  sampledAt: 1,
  memorySource: 'os',
  cpu: { cores: 2, usagePercent: 12.5, load1: 0.1, load5: 0.2, load15: 0.3 },
  memory: {
    totalBytes: 100,
    availableBytes: 40,
    usedBytes: 60,
    usagePercent: 60,
    swapTotalBytes: null,
    swapUsedBytes: null,
  },
  disks: [],
  containers: { available: false, reason: '本机未安装 Docker', running: 0, stopped: 0, untracked: 0, busy: 0, total: 0 },
};

async function app(allowed: boolean) {
  const hostSnapshot = vi.fn(async () => snapshot);
  const fastify = Fastify();
  fastify.setErrorHandler(handleError);
  fastify.addHook('preHandler', (req, _reply, done) => {
    (req as unknown as { userId: number }).userId = 7;
    done();
  });
  registerStatisticsRoutes(fastify, {
    jwt: {} as never,
    statistics: {} as never,
    hostStatus: { snapshot: hostSnapshot },
    permissionService: { hasPermission: vi.fn(async () => allowed) },
  });
  return { fastify, hostSnapshot };
}

describe('GET /v1/statistics/host', () => {
  it('需要 analytics:read，通过后返回主机快照', async () => {
    const { fastify, hostSnapshot } = await app(true);
    const res = await fastify.inject({ method: 'GET', url: '/v1/statistics/host' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ code: 0, data: { hostname: 'mao-box', cpu: { usagePercent: 12.5 } } });
    expect(hostSnapshot).toHaveBeenCalledTimes(1);
    await fastify.close();
  });

  it('没有权限时不采集', async () => {
    const { fastify, hostSnapshot } = await app(false);
    const res = await fastify.inject({ method: 'GET', url: '/v1/statistics/host' });
    expect(res.statusCode).toBe(403);
    expect(hostSnapshot).not.toHaveBeenCalled();
    await fastify.close();
  });
});
