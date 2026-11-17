import type { FastifyInstance } from 'fastify';
import { requireRequestPermission, sendJson } from '../common/http-error.js';
import { ok } from '../common/result.js';
import type { JwtService } from '../crypto/jwt.service.js';
import type { HostStatusVo, HostTrendSample } from '@mao/contracts';
import type { StatisticsService } from './statistics.service.js';

export interface StatisticsRouteDeps {
  jwt: JwtService;
  statistics: StatisticsService;
  hostStatus: {
    snapshot(): Promise<HostStatusVo>;
    trend(): Promise<HostTrendSample>;
  };
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
}

export function registerStatisticsRoutes(app: FastifyInstance, deps: StatisticsRouteDeps): void {
  app.get('/v1/statistics/overview', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    sendJson(reply, 200, ok(await deps.statistics.getOverview()));
  });

  app.get('/v1/statistics/agents', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    sendJson(reply, 200, ok(await deps.statistics.getAgentStats()));
  });

  app.get('/v1/statistics/models', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    sendJson(reply, 200, ok(await deps.statistics.getModelStats()));
  });

  app.get('/v1/statistics/users', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    sendJson(reply, 200, ok(await deps.statistics.getUserStats()));
  });

  // 当前在线设备（WS 连接实时快照，技术方案 2026-11-10）
  app.get('/v1/statistics/online-devices', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    sendJson(reply, 200, ok(await deps.statistics.getOnlineDevices()));
  });

  // 后端所在机器的当前资源快照（CPU / 内存 / 硬盘 / 运行时容器）
  app.get('/v1/statistics/host', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    sendJson(reply, 200, ok(await deps.hostStatus.snapshot()));
  });

  // 只含 CPU 与内存的一个点。页面折线每秒拉一次，序列不落库。
  app.get('/v1/statistics/host/trend', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    sendJson(reply, 200, ok(await deps.hostStatus.trend()));
  });
}
