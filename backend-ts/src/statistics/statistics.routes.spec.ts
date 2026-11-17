import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { HostStatusVo, HostTrendSample } from '@mao/contracts';
import { handleError } from '../common/http-error.js';
import { registerStatisticsRoutes } from './statistics.routes.js';

const snapshot: HostStatusVo = {
  hostname: 'mao-box',
  platform: 'linux',
  uptimeSeconds: 10,
  sampledAt: 1,
  memorySource: 'os',
  cpu: { cores: 2, usagePercent: 12.5, iowaitPercent: null, load1: 0.1, load5: 0.2, load15: 0.3 },
  memory: {
    totalBytes: 100,
    availableBytes: 40,
    usedBytes: 60,
    usagePercent: 60,
    swapTotalBytes: null,
    swapUsedBytes: null,
  },
  disks: [],
  diskIo: { readBytesPerSec: null, writeBytesPerSec: null },
  process: {
    uptimeSeconds: 3,
    rssBytes: 1,
    heapUsedBytes: 1,
    heapTotalBytes: 2,
    eventLoopDelayMs: null,
    openFds: null,
    fdLimit: null,
  },
  containers: { available: false, reason: '本机未安装 Docker', running: 0, stopped: 0, untracked: 0, busy: 0, total: 0 },
  dockerDisk: {
    available: false,
    reason: '本机未安装 Docker',
    imagesBytes: null,
    imagesReclaimableBytes: null,
    volumesBytes: null,
    volumesReclaimableBytes: null,
    buildCacheBytes: null,
    buildCacheReclaimableBytes: null,
  },
};

const trend: HostTrendSample = {
  sampledAt: 2,
  memorySource: 'proc',
  cpu: snapshot.cpu,
  memory: snapshot.memory,
};

async function app(allowed: boolean) {
  const hostSnapshot = vi.fn(async () => snapshot);
  const hostTrend = vi.fn(async () => trend);
  const fastify = Fastify();
  fastify.setErrorHandler(handleError);
  fastify.addHook('preHandler', (req, _reply, done) => {
    (req as unknown as { userId: number }).userId = 7;
    done();
  });
  registerStatisticsRoutes(fastify, {
    jwt: {} as never,
    statistics: {} as never,
    hostStatus: { snapshot: hostSnapshot, trend: hostTrend },
    permissionService: { hasPermission: vi.fn(async () => allowed) },
  });
  return { fastify, hostSnapshot, hostTrend };
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

describe('GET /v1/statistics/host/trend', () => {
  it('需要 analytics:read，通过后只返回 CPU 和内存这一点', async () => {
    const { fastify, hostSnapshot, hostTrend } = await app(true);
    const res = await fastify.inject({ method: 'GET', url: '/v1/statistics/host/trend' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ code: 0, data: { sampledAt: 2, memory: { usagePercent: 60 } } });
    expect(hostTrend).toHaveBeenCalledTimes(1);
    expect(hostSnapshot).not.toHaveBeenCalled();
    await fastify.close();
  });

  it('没有权限时不采样', async () => {
    const { fastify, hostTrend } = await app(false);
    const res = await fastify.inject({ method: 'GET', url: '/v1/statistics/host/trend' });
    expect(res.statusCode).toBe(403);
    expect(hostTrend).not.toHaveBeenCalled();
    await fastify.close();
  });
});
